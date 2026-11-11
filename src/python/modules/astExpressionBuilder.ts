// code-gauge-allow-file fileNcss 520 -- Builds every kind of CPython expression node, as ast.c and the parser's actions do.
// Builds the expression nodes of CPython's `ast` module from the syntax tree, with CPython's fields and positions.
import type { Node } from '@willbooster/web-tree-sitter';

import { newBytes } from '../bytesValues';
import { children, decodeBytesEscapes, decodeEscapes, field, fieldNodes, namedChildren } from '../convertNodes';
import { constantOf } from '../expressionConverter';
import { complexClass, Ellipsis, newList, None } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { type PyClass, PyComplex, PyInstance, type PyValue } from '../values';

export type Context = 'Load' | 'Store' | 'Del';

/** A part of an f-string: text between source indices, or a FormattedValue. */
type Part = { text: string; start: number; end: number } | { node: PyValue };

/** A node's position as CPython gives it: 1-based lines and 0-based UTF-8 byte columns. */
export interface Location {
  lineno: number;
  col_offset: number;
  end_lineno: number;
  end_col_offset: number;
}

const BINARY_OPERATORS: Record<string, string> = {
  '+': 'Add',
  '-': 'Sub',
  '*': 'Mult',
  '@': 'MatMult',
  '/': 'Div',
  '%': 'Mod',
  '**': 'Pow',
  '<<': 'LShift',
  '>>': 'RShift',
  '|': 'BitOr',
  '^': 'BitXor',
  '&': 'BitAnd',
  '//': 'FloorDiv',
};
const UNARY_OPERATORS: Record<string, string> = { '+': 'UAdd', '-': 'USub', '~': 'Invert' };
const COMPARISONS: Record<string, string> = {
  '==': 'Eq',
  '!=': 'NotEq',
  '<': 'Lt',
  '<=': 'LtE',
  '>': 'Gt',
  '>=': 'GtE',
  is: 'Is',
  'is not': 'IsNot',
  in: 'In',
  'not in': 'NotIn',
};
const COMPREHENSIONS: Record<string, string> = {
  list_comprehension: 'ListComp',
  set_comprehension: 'SetComp',
  generator_expression: 'GeneratorExp',
};

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

export class AstExpressionBuilder {
  private readonly lineStarts: number[] = [0];

  constructor(
    protected readonly source: string,
    private readonly classes: Map<string, PyValue>,
    /** The field-less nodes, such as `Load()`, which CPython shares between all the trees of a run. */
    private readonly singletons: Map<string, PyValue>
  ) {
    for (let index = 0; index < source.length; index++) if (source[index] === '\n') this.lineStarts.push(index + 1);
  }

  /** A node of the class `name` with `fields`, at `location` when the class has positions. */
  protected make(name: string, fields: Record<string, PyValue>, location?: Location): PyValue {
    const cls = this.classes.get(name) as PyClass;
    const node = new PyInstance(cls);
    for (const [key, value] of Object.entries(fields)) node.dict.set(key, value);
    if (location) {
      for (const [key, value] of Object.entries(location)) node.dict.set(key, BigInt(value));
    }
    return node;
  }

  /** The node of a field-less class such as `Load` or `Add`, which CPython shares between all trees. */
  protected singleton(name: string): PyValue {
    let value = this.singletons.get(name);
    if (!value) {
      value = this.make(name, {});
      this.singletons.set(name, value);
    }
    return value;
  }

  protected location(start: Node, end: Node = start): Location {
    return {
      lineno: start.startPosition.row + 1,
      col_offset: this.column(start.startPosition.row, start.startIndex),
      end_lineno: end.endPosition.row + 1,
      end_col_offset: this.column(end.endPosition.row, end.endIndex),
    };
  }

  /** The location of a span of the source given by its indices. */
  protected locationOf(start: number, end: number): Location {
    const startRow = this.rowOf(start);
    const endRow = this.rowOf(end);
    return {
      lineno: startRow + 1,
      col_offset: this.column(startRow, start),
      end_lineno: endRow + 1,
      end_col_offset: this.column(endRow, end),
    };
  }

  private rowOf(index: number): number {
    let row = 0;
    while (row + 1 < this.lineStarts.length && this.lineStarts[row + 1] <= index) row++;
    return row;
  }

  private column(row: number, index: number): number {
    return utf8Length(this.source.slice(this.lineStarts[row], index));
  }

  // Expressions ---------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 47 -- One case per kind of expression node, each delegating where it grows.
  expr(node: Node, ctx: Context = 'Load'): PyValue {
    const at = this.location(node);
    switch (node.type) {
      case 'identifier': {
        return this.make('Name', { id: identifier(node), ctx: this.singleton(ctx) }, at);
      }
      case 'integer':
      case 'float':
      case 'true':
      case 'false':
      case 'none':
      case 'ellipsis': {
        return this.make('Constant', { value: constantValue(node), kind: None }, at);
      }
      case 'string':
      case 'concatenated_string': {
        return this.string(node);
      }
      case 'parenthesized_expression': {
        return this.parenthesized(node, ctx);
      }
      case 'type': {
        return this.expr(namedChildren(node)[0], ctx);
      }
      case 'binary_operator': {
        return this.binary(field(node, 'left'), operatorText(node), field(node, 'right'), at);
      }
      case 'union_type': {
        const [left, right] = namedChildren(node);
        return this.binary(left, '|', right, at);
      }
      case 'unary_operator': {
        const op = this.singleton(UNARY_OPERATORS[operatorText(node)]);
        return this.make('UnaryOp', { op, operand: this.expr(field(node, 'argument')) }, at);
      }
      case 'not_operator': {
        return this.make('UnaryOp', { op: this.singleton('Not'), operand: this.expr(field(node, 'argument')) }, at);
      }
      case 'boolean_operator': {
        return this.boolean(node, at);
      }
      case 'comparison_operator': {
        return this.comparison(node, at);
      }
      case 'call': {
        return this.call(node, at);
      }
      case 'attribute': {
        const attr = identifier(field(node, 'attribute'));
        return this.make('Attribute', { value: this.expr(field(node, 'object')), attr, ctx: this.singleton(ctx) }, at);
      }
      case 'subscript': {
        return this.subscript(node, ctx, at);
      }
      case 'generic_type': {
        return this.genericType(node, at);
      }
      case 'member_type': {
        const [value, attr] = namedChildren(node);
        return this.make(
          'Attribute',
          { value: this.expr(value), attr: identifier(attr), ctx: this.singleton(ctx) },
          at
        );
      }
      default: {
        return this.displayOrOther(node, ctx, at);
      }
    }
  }

  /** The displays, comprehensions, and the other expressions that compose others. */
  // code-gauge-allow functionNcss 46 -- One case per kind of expression node, each delegating where it grows.
  private displayOrOther(node: Node, ctx: Context, at: Location): PyValue {
    switch (node.type) {
      case 'list':
      case 'list_pattern': {
        return this.make('List', { elts: this.elements(namedChildren(node), ctx), ctx: this.singleton(ctx) }, at);
      }
      case 'tuple':
      case 'tuple_pattern':
      case 'expression_list':
      case 'pattern_list': {
        return this.tuple(namedChildren(node), ctx, node);
      }
      case 'set': {
        return this.make('Set', { elts: this.elements(namedChildren(node), 'Load') }, at);
      }
      case 'dictionary': {
        return this.dictionary(node, at);
      }
      case 'list_comprehension':
      case 'set_comprehension':
      case 'generator_expression': {
        const elt = this.expr(field(node, 'body'));
        return this.make(COMPREHENSIONS[node.type], { elt, generators: this.generators(node) }, at);
      }
      case 'dictionary_comprehension': {
        const pair = field(node, 'body');
        const key = this.expr(field(pair, 'key'));
        const value = this.expr(field(pair, 'value'));
        return this.make('DictComp', { key, value, generators: this.generators(node) }, at);
      }
      case 'list_splat':
      case 'list_splat_pattern':
      case 'splat_type': {
        return this.make('Starred', { value: this.expr(namedChildren(node)[0], ctx), ctx: this.singleton(ctx) }, at);
      }
      case 'conditional_expression': {
        const [body, test, orelse] = namedChildren(node).map((child) => this.expr(child));
        return this.make('IfExp', { test, body, orelse }, at);
      }
      case 'named_expression': {
        const target = this.expr(field(node, 'name'), 'Store');
        return this.make('NamedExpr', { target, value: this.expr(field(node, 'value')) }, at);
      }
      case 'lambda': {
        const parameters = node.childForFieldName('parameters');
        const args = parameters ? this.arguments(parameters) : this.emptyArguments();
        return this.make('Lambda', { args, body: this.expr(field(node, 'body')) }, at);
      }
      case 'await': {
        return this.make('Await', { value: this.expr(namedChildren(node)[0]) }, at);
      }
      case 'yield': {
        return this.yieldExpression(node, at);
      }
      case 'slice': {
        return this.slice(node, at);
      }
      default: {
        throw new UnsupportedFeatureError(`ast.parse() が扱えない構文（${node.type}）`);
      }
    }
  }

  private parenthesized(node: Node, ctx: Context): PyValue {
    const inner = namedChildren(node)[0];
    // A parenthesized yield is the yield itself; other parentheses only group.
    return this.expr(inner, ctx);
  }

  private binary(left: Node, operator: string, right: Node, at: Location): PyValue {
    const op = this.singleton(BINARY_OPERATORS[operator]);
    return this.make('BinOp', { left: this.expr(left), op, right: this.expr(right) }, at);
  }

  /** `a and b and c` is one BoolOp, as CPython's parser gathers the operands of one operator. */
  private boolean(node: Node, at: Location): PyValue {
    const operator = operatorText(node);
    const operands: Node[] = [];
    const gather = (current: Node): void => {
      if (current.type === 'boolean_operator' && operatorText(current) === operator) {
        gather(field(current, 'left'));
        operands.push(field(current, 'right'));
      } else {
        operands.push(current);
      }
    };
    gather(field(node, 'left'));
    operands.push(field(node, 'right'));
    const values = newList(operands.map((operand) => this.expr(operand)));
    return this.make('BoolOp', { op: this.singleton(operator === 'and' ? 'And' : 'Or'), values }, at);
  }

  private comparison(node: Node, at: Location): PyValue {
    const operands = fieldNodes(node, 'operands');
    const operators = fieldNodes(node, 'operators').map((operator) => operator.text.replaceAll(/\s+/g, ' '));
    return this.make(
      'Compare',
      {
        left: this.expr(operands[0]),
        ops: newList(operators.map((operator) => this.singleton(COMPARISONS[operator]))),
        comparators: newList(operands.slice(1).map((operand) => this.expr(operand))),
      },
      at
    );
  }

  private call(node: Node, at: Location): PyValue {
    const func = this.expr(field(node, 'function'));
    const argumentsNode = field(node, 'arguments');
    if (argumentsNode.type === 'generator_expression') {
      const generator = this.expr(argumentsNode);
      return this.make('Call', { func, args: newList([generator]), keywords: newList([]) }, at);
    }
    const [args, keywords] = this.callArguments(argumentsNode);
    return this.make('Call', { func, args, keywords }, at);
  }

  /** The positional and keyword arguments of a call or a class definition. */
  protected callArguments(node: Node): [PyValue, PyValue] {
    const args: PyValue[] = [];
    const keywords: PyValue[] = [];
    for (const child of namedChildren(node)) {
      if (child.type === 'keyword_argument') {
        const arg = identifier(field(child, 'name'));
        keywords.push(this.make('keyword', { arg, value: this.expr(field(child, 'value')) }, this.location(child)));
      } else if (child.type === 'dictionary_splat') {
        const value = this.expr(namedChildren(child)[0]);
        keywords.push(this.make('keyword', { arg: None, value }, this.location(child)));
      } else {
        args.push(this.expr(child));
      }
    }
    return [newList(args), newList(keywords)];
  }

  private subscript(node: Node, ctx: Context, at: Location): PyValue {
    const value = this.expr(field(node, 'value'));
    const parts = fieldNodes(node, 'subscript');
    const trailingComma = children(node).some(
      (child, index, all) => child.type === ',' && all[index + 1]?.type === ']'
    );
    const slice =
      parts.length === 1 && !trailingComma
        ? this.expr(parts[0])
        : this.make(
            'Tuple',
            { elts: this.elements(parts, 'Load'), ctx: this.singleton('Load') },
            this.location(parts[0], trailingComma ? (children(node).at(-2) as Node) : (parts.at(-1) as Node))
          );
    return this.make('Subscript', { value, slice, ctx: this.singleton(ctx) }, at);
  }

  /** `list[int]` in an annotation, which the grammar parses as a type: a subscript. */
  private genericType(node: Node, at: Location): PyValue {
    const [name, parameters] = namedChildren(node);
    const types = namedChildren(parameters);
    const slice =
      types.length === 1
        ? this.expr(types[0])
        : this.make(
            'Tuple',
            { elts: this.elements(types, 'Load'), ctx: this.singleton('Load') },
            this.location(types[0], types.at(-1) as Node)
          );
    return this.make('Subscript', { value: this.expr(name), slice, ctx: this.singleton('Load') }, at);
  }

  private slice(node: Node, at: Location): PyValue {
    const parts: (Node | undefined)[] = [undefined, undefined, undefined];
    let index = 0;
    for (const child of children(node)) {
      if (child.type === ':') index++;
      else parts[index] = child;
    }
    const [lower, upper, step] = parts.map((part) => (part ? this.expr(part) : None));
    return this.make('Slice', { lower, upper, step }, at);
  }

  protected elements(nodes: Node[], ctx: Context): PyValue {
    return newList(nodes.map((child) => this.expr(child, ctx)));
  }

  /** A tuple; without parentheses, it spans its elements, which CPython's parser gives it. */
  protected tuple(nodes: Node[], ctx: Context, node: Node): PyValue {
    const parenthesized = node.type === 'tuple' || (node.type === 'tuple_pattern' && children(node)[0]?.type === '(');
    const at = parenthesized || nodes.length === 0 ? this.location(node) : this.location(nodes[0], tupleEnd(node));
    return this.make('Tuple', { elts: this.elements(nodes, ctx), ctx: this.singleton(ctx) }, at);
  }

  private dictionary(node: Node, at: Location): PyValue {
    const keys: PyValue[] = [];
    const values: PyValue[] = [];
    for (const child of namedChildren(node)) {
      if (child.type === 'pair') {
        keys.push(this.expr(field(child, 'key')));
        values.push(this.expr(field(child, 'value')));
      } else {
        keys.push(None);
        values.push(this.expr(namedChildren(child)[0]));
      }
    }
    return this.make('Dict', { keys: newList(keys), values: newList(values) }, at);
  }

  private generators(node: Node): PyValue {
    const generators: PyValue[] = [];
    let ifs: PyValue[] = [];
    for (const clause of namedChildren(node)) {
      if (clause.type === 'if_clause') {
        ifs.push(this.expr(namedChildren(clause)[0]));
      } else if (clause.type === 'for_in_clause') {
        ifs = [];
        const rights = fieldNodes(clause, 'right');
        const iter = rights.length === 1 ? this.expr(rights[0]) : this.tuple(rights, 'Load', clause);
        generators.push(
          this.make('comprehension', {
            target: this.expr(field(clause, 'left'), 'Store'),
            iter,
            ifs: newList(ifs),
            is_async: children(clause)[0].type === 'async' ? 1n : 0n,
          })
        );
      }
    }
    return newList(generators);
  }

  private yieldExpression(node: Node, at: Location): PyValue {
    const isFrom = children(node).some((child) => child.type === 'from');
    const operand = namedChildren(node)[0];
    if (isFrom) return this.make('YieldFrom', { value: this.expr(operand) }, at);
    return this.make('Yield', { value: operand ? this.expr(operand) : None }, at);
  }

  // Parameters ----------------------------------------------------------------------------------------------------

  protected emptyArguments(): PyValue {
    return this.make('arguments', {
      posonlyargs: newList([]),
      args: newList([]),
      vararg: None,
      kwonlyargs: newList([]),
      kw_defaults: newList([]),
      kwarg: None,
      defaults: newList([]),
    });
  }

  // code-gauge-allow functionNcss 32 -- Sorts each kind of parameter into CPython's lists.
  protected arguments(node: Node): PyValue {
    const positional: PyValue[] = [];
    const posonly: PyValue[] = [];
    const kwonly: PyValue[] = [];
    const kwDefaults: PyValue[] = [];
    const defaults: PyValue[] = [];
    let vararg: PyValue = None;
    let kwarg: PyValue = None;
    let keywordOnly = false;
    for (const parameter of namedChildren(node)) {
      if (parameter.type === 'positional_separator') {
        posonly.push(...positional.splice(0));
        continue;
      }
      if (parameter.type === 'keyword_separator') {
        keywordOnly = true;
        continue;
      }
      const { arg, splat, value } = this.parameter(parameter);
      if (splat === '*') {
        vararg = arg;
        keywordOnly = true;
      } else if (splat === '**') {
        kwarg = arg;
      } else if (keywordOnly) {
        kwonly.push(arg);
        kwDefaults.push(value ?? None);
      } else {
        positional.push(arg);
        if (value) defaults.push(value);
      }
    }
    return this.make('arguments', {
      posonlyargs: newList(posonly),
      args: newList(positional),
      vararg,
      kwonlyargs: newList(kwonly),
      kw_defaults: newList(kwDefaults),
      kwarg,
      defaults: newList(defaults),
    });
  }

  /** One parameter: its `arg` node, whether it is `*args` or `**kwargs`, and its default. */
  private parameter(node: Node): { arg: PyValue; splat?: '*' | '**'; value?: PyValue } {
    const nameNode =
      node.childForFieldName('name') ?? (node.type === 'typed_parameter' ? namedChildren(node)[0] : node);
    const typeNode = node.childForFieldName('type');
    const valueNode = node.childForFieldName('value');
    let splat: '*' | '**' | undefined;
    let name = nameNode;
    if (nameNode.type === 'list_splat_pattern' || nameNode.type === 'dictionary_splat_pattern') {
      splat = nameNode.type === 'list_splat_pattern' ? '*' : '**';
      name = namedChildren(nameNode)[0];
    }
    const annotation = typeNode ? this.expr(typeNode) : None;
    const arg = this.make(
      'arg',
      { arg: identifier(name), annotation, type_comment: None },
      this.location(name, typeNode ?? name)
    );
    return { arg, splat, value: valueNode ? this.expr(valueNode) : undefined };
  }

  // Strings -------------------------------------------------------------------------------------------------------

  protected string(node: Node): PyValue {
    const strings = node.type === 'concatenated_string' ? namedChildren(node) : [node];
    const prefixes = strings.map((string) => prefixOf(string));
    const at = this.location(node);
    if (prefixes.some((prefix) => prefix.includes('b'))) {
      const data = strings.flatMap((string, index) => [...this.bytesOf(string, prefixes[index].includes('r'))]);
      return this.make('Constant', { value: newBytes(Uint8Array.from(data)), kind: None }, at);
    }
    const kind = prefixes[0] === 'u' ? 'u' : None;
    if (!prefixes.some((prefix) => prefix.includes('f'))) {
      const value = strings.map((string, index) => this.textOf(string, prefixes[index])).join('');
      return this.make('Constant', { value, kind }, at);
    }
    const parts: Part[] = [];
    for (const [index, string] of strings.entries()) {
      if (prefixes[index].includes('f')) this.formattedParts(string, prefixes[index].includes('r'), parts);
      else parts.push({ text: this.textOf(string, prefixes[index]), start: string.startIndex, end: string.endIndex });
    }
    return this.make('JoinedStr', { values: this.joinParts(parts) }, at);
  }

  /** The texts and the replacement fields of an f-string, between its quotes. */
  private formattedParts(string: Node, isRaw: boolean, parts: Part[]): void {
    const nodes = children(string);
    const startNode = nodes[0];
    const quote = startNode.text.replace(/^[a-zA-Z]+/, '');
    let position = startNode.endIndex;
    const pushText = (end: number): void => {
      if (end <= position) return;
      const raw = this.source.slice(position, end).replaceAll('{{', '{').replaceAll('}}', '}');
      parts.push({ text: isRaw ? raw : decodeEscapes(raw, string.startPosition.row), start: position, end });
    };
    for (const child of nodes.slice(1, -1)) {
      if (child.type !== 'interpolation') continue;
      pushText(child.startIndex);
      this.replacementField(child, isRaw, parts);
      position = child.endIndex;
    }
    pushText((nodes.at(-1) as Node).endIndex - quote.length);
  }

  /** A `{...}` replacement field: a FormattedValue, after the text a `=` shows. */
  private replacementField(node: Node, isRaw: boolean, parts: Part[]): void {
    const expressionNode = field(node, 'expression');
    const value =
      expressionNode.type === 'expression_list'
        ? this.tuple(namedChildren(expressionNode), 'Load', expressionNode)
        : this.expr(expressionNode);
    const conversionNode = node.childForFieldName('type_conversion');
    const specNode = node.childForFieldName('format_specifier');
    const equals = children(node).find((child) => child.type === '=');
    let conversion = conversionNode ? BigInt(conversionNode.text.codePointAt(1) as number) : -1n;
    if (equals) {
      const end = (conversionNode ?? specNode ?? (children(node).at(-1) as Node)).startIndex;
      parts.push({ text: this.source.slice(node.startIndex + 1, end), start: node.startIndex + 1, end });
      if (!conversionNode && !specNode) conversion = 114n;
    }
    const formatSpec = specNode ? this.formatSpec(specNode, isRaw) : None;
    parts.push({
      node: this.make('FormattedValue', { value, conversion, format_spec: formatSpec }, this.location(node)),
    });
  }

  private formatSpec(node: Node, isRaw: boolean): PyValue {
    const parts: Part[] = [];
    // The specifier's text starts after its colon.
    let position = node.startIndex + 1;
    for (const child of namedChildren(node)) {
      if (child.type !== 'format_expression') continue;
      if (child.startIndex > position) parts.push(this.specText(position, child.startIndex, isRaw, node));
      this.replacementField(child, isRaw, parts);
      position = child.endIndex;
    }
    if (node.endIndex > position) parts.push(this.specText(position, node.endIndex, isRaw, node));
    return this.make('JoinedStr', { values: this.joinParts(parts) }, this.location(node));
  }

  private specText(start: number, end: number, isRaw: boolean, node: Node): Part {
    const raw = this.source.slice(start, end);
    return { text: isRaw ? raw : decodeEscapes(raw, node.startPosition.row), start, end };
  }

  /** The values of a JoinedStr: adjacent texts join into one Constant, which spans them all. */
  private joinParts(parts: Part[]): PyValue {
    const values: PyValue[] = [];
    let pending: { text: string; start: number; end: number } | undefined;
    const flush = (): void => {
      if (pending && pending.text !== '') {
        values.push(
          this.make('Constant', { value: pending.text, kind: None }, this.locationOf(pending.start, pending.end))
        );
      }
      pending = undefined;
    };
    for (const part of parts) {
      if ('node' in part) {
        flush();
        values.push(part.node);
      } else if (pending) {
        pending = { text: pending.text + part.text, start: pending.start, end: part.end };
      } else {
        pending = { ...part };
      }
    }
    flush();
    return newList(values);
  }

  private textOf(string: Node, prefix: string): string {
    const nodes = children(string);
    const quote = nodes[0].text.slice(prefix.length);
    const text = this.source.slice(nodes[0].endIndex, (nodes.at(-1) as Node).endIndex - quote.length);
    return prefix.includes('r') ? text : decodeEscapes(text, string.startPosition.row);
  }

  private bytesOf(string: Node, isRaw: boolean): Uint8Array {
    const nodes = children(string);
    const prefix = prefixOf(string);
    const quote = nodes[0].text.slice(prefix.length);
    const text = this.source.slice(nodes[0].endIndex, (nodes.at(-1) as Node).endIndex - quote.length);
    return decodeBytesEscapes(text, string.startPosition.row, isRaw);
  }
}

/** The end of a bare tuple: its last element, or the trailing comma CPython's parser includes. */
function tupleEnd(node: Node): Node {
  return children(node).at(-1) as Node;
}

export function identifier(node: Node): string {
  // CPython normalizes identifiers to NFKC.
  return node.text.normalize('NFKC');
}

function operatorText(node: Node): string {
  return (node.childForFieldName('operator') as Node).text;
}

function prefixOf(string: Node): string {
  return children(string)[0]
    .text.replace(/['"]+$/, '')
    .toLowerCase();
}

function constantValue(node: Node): PyValue {
  const constant = constantOf(node);
  switch (constant.kind) {
    case 'bool': {
      return constant.value;
    }
    case 'none': {
      return None;
    }
    case 'ellipsis': {
      return Ellipsis;
    }
    case 'imaginary': {
      return new PyComplex(complexClass, 0, constant.value);
    }
    case 'int':
    case 'float': {
      return constant.value;
    }
    default: {
      throw new Error(`Unexpected constant ${constant.kind}`);
    }
  }
}
