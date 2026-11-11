// What CPython 3.14's AST optimizer (`Python/ast_preprocess.c`) changes in the tree `ast.PyCF_OPTIMIZED_AST` gives:
// `__debug__` becomes a constant, the values of match patterns fold into constants, and at optimization level 2 the
// docstrings go. It folds no other constants, which CPython 3.14 folds only when it generates bytecode.
import { getAttribute } from '../objects';
import { binaryOp, unaryOp } from '../operators';
import { isInstanceOf, None } from '../types';
import { type PyClass, PyInstance, PyList, type PyTuple, type PyValue } from '../values';

const LOCATION = ['lineno', 'col_offset', 'end_lineno', 'end_col_offset'];

/** Optimizes a tree of the `_ast` classes in place, as CPython does at `level` (-1 or 0 keeping `__debug__` true). */
export function optimizeTree(tree: PyValue, level: number, classes: Map<string, PyValue>): PyValue {
  return new Optimizer(level, classes).node(tree);
}

class Optimizer {
  constructor(
    private readonly level: number,
    private readonly classes: Map<string, PyValue>
  ) {}

  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of node CPython's AST optimizer changes.
  node(value: PyValue): PyValue {
    if (value instanceof PyList) {
      for (const [index, item] of value.items.entries()) value.items[index] = this.node(item);
      return value;
    }
    if (!(value instanceof PyInstance) || !isInstanceOf(value, this.cls('AST'))) return value;
    if (this.is(value, 'Name') && value.dict.get('id') === '__debug__' && this.is(value.dict.get('ctx'), 'Load')) {
      return this.constant(this.level <= 0, value);
    }
    if (this.level >= 2 && this.hasDocstring(value)) this.removeDocstring(value);
    if (this.is(value, 'MatchValue')) value.dict.set('value', this.fold(value.dict.get('value') as PyValue));
    if (this.is(value, 'MatchMapping')) {
      const keys = value.dict.get('keys') as PyList;
      for (const [index, key] of keys.items.entries()) keys.items[index] = this.fold(key);
    }
    for (const field of (getAttribute(value.cls, '_fields') as PyTuple).items) {
      const child = value.dict.get(field as string);
      if (child !== undefined) value.dict.set(field as string, this.node(child));
    }
    return value;
  }

  private hasDocstring(node: PyInstance): boolean {
    if (!['Module', 'FunctionDef', 'AsyncFunctionDef', 'ClassDef'].some((name) => this.is(node, name))) return false;
    const [first] = (node.dict.get('body') as PyList).items;
    if (!(first instanceof PyInstance) || !this.is(first, 'Expr')) return false;
    const value = first.dict.get('value');
    return value instanceof PyInstance && this.is(value, 'Constant') && typeof value.dict.get('value') === 'string';
  }

  /** Drops a body's docstring, leaving `pass` where it stood when nothing else remains. */
  private removeDocstring(node: PyInstance): void {
    const body = node.dict.get('body') as PyList;
    const docstring = body.items.shift() as PyInstance;
    if (body.items.length > 0) return;
    // The `pass` stands at the docstring's start, spanning the four characters of its keyword.
    const pass = this.make('Pass', {}, docstring);
    pass.dict.set('end_lineno', docstring.dict.get('lineno') as PyValue);
    pass.dict.set('end_col_offset', (docstring.dict.get('col_offset') as bigint) + 4n);
    body.items.push(pass);
  }

  /** A pattern's value folded into a constant: a negative number, or a complex number written as a sum. */
  private fold(value: PyValue): PyValue {
    if (!(value instanceof PyInstance)) return value;
    if (this.is(value, 'UnaryOp') && this.is(value.dict.get('op'), 'USub')) {
      const operand = this.fold(value.dict.get('operand') as PyValue);
      const number = this.constantValue(operand);
      return number === undefined ? value : this.constant(unaryOp('-', number), value);
    }
    if (this.is(value, 'BinOp')) {
      const left = this.constantValue(this.fold(value.dict.get('left') as PyValue));
      const right = this.constantValue(value.dict.get('right') as PyValue);
      const op = value.dict.get('op');
      if (left === undefined || right === undefined) return value;
      if (this.is(op, 'Add')) return this.constant(binaryOp('+', left, right), value);
      if (this.is(op, 'Sub')) return this.constant(binaryOp('-', left, right), value);
    }
    return value;
  }

  private constantValue(node: PyValue): PyValue | undefined {
    return node instanceof PyInstance && this.is(node, 'Constant') ? node.dict.get('value') : undefined;
  }

  private constant(value: PyValue, at: PyInstance): PyValue {
    return this.make('Constant', { value, kind: None }, at);
  }

  private make(name: string, fields: Record<string, PyValue>, at: PyInstance): PyInstance {
    const node = new PyInstance(this.cls(name));
    for (const [key, value] of Object.entries(fields)) node.dict.set(key, value);
    for (const key of LOCATION) {
      const value = at.dict.get(key);
      if (value !== undefined) node.dict.set(key, value);
    }
    return node;
  }

  private cls(name: string): PyClass {
    return this.classes.get(name) as PyClass;
  }

  private is(value: PyValue | undefined, name: string): boolean {
    return value instanceof PyInstance && value.cls.isSubclassOf(this.cls(name));
  }
}
