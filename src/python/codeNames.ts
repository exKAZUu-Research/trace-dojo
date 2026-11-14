// `co_varnames` and `co_names` of a code object, which CPython's compiler fills as it emits the code: the parameters
// first, then each fast local the first time an instruction names it, and each global, attribute, and imported name
// the first time an instruction names it. Walking the syntax tree in the order the compiler emits code gives them.
import type { Expression, FunctionDef, Module, NameRef, ScopeInfo, Statement } from './ast';
import { comprehensionBody, emitExpression, emitStatement } from './codeEmission';
import { blocksOf } from './suspension';

/** The names of a code object, in the order CPython's compiler first emits them. */
export interface CodeNames {
  varnames: string[];
  names: string[];
  /**
   * The variables nested code captures, which live in cells. A comprehension CPython inlines captures none, so a
   * variable only such a comprehension reads stays a fast local.
   */
  captured: Set<string>;
}

export type ComprehensionExpression = Extract<Expression, { kind: 'comprehension' }>;

/** The comprehension each comprehension scope belongs to, whose code a generator's `gi_code` describes. */
export const comprehensionsByScope = new WeakMap<ScopeInfo, ComprehensionExpression>();

/** The names of a generator expression's code, whose one parameter `.0` is the iterator of its first iterable. */
export function generatorCodeNames(expression: ComprehensionExpression): CodeNames {
  const run = (captured?: Set<string>): Emitter => {
    const emitter = new Emitter(expression.scope, captured);
    emitter.varnames.add('.0');
    comprehensionBody(emitter, expression);
    return emitter;
  };
  const { captured } = run();
  const emitter = run(captured);
  return { varnames: [...emitter.varnames], names: [...emitter.names], captured };
}

/** The parameters in the order of CPython's symbol table: positional, keyword-only, then `*args` and `**kwargs`. */
function parameterNames(fn: FunctionDef): string[] {
  const order = ['positionalOnly', 'positional', 'keywordOnly', 'varArgs', 'varKeywords'];
  return order.flatMap((kind) => fn.params.filter((param) => param.kind === kind).map((param) => param.name));
}

/** The names of a function's or a lambda's code. */
export function functionCodeNames(fn: FunctionDef): CodeNames {
  const run = (captured?: Set<string>): Emitter => {
    const emitter = new Emitter(fn.scope, captured, fn.usesClassCell);
    for (const name of parameterNames(fn)) emitter.varnames.add(name);
    if (Array.isArray(fn.body)) emitter.statements(fn.body);
    else emitter.expression(fn.body);
    return emitter;
  };
  // The first walk finds what nested code captures, which the second needs to tell cells from fast locals.
  const { captured } = run();
  const emitter = run(captured);
  return { varnames: [...emitter.varnames], names: [...emitter.names], captured };
}

/**
 * The names of the code compile() makes of a module: the set of conditional annotations a module with annotations
 * creates first, its docstring, its statements, and its `__annotate__` last, or each annotation stored into
 * `__annotations__` under `from __future__ import annotations`.
 */
export function moduleCodeNames(module: Module): CodeNames {
  const future = module.futureFeatures.includes('annotations');
  const annotations = moduleAnnotations(module.body);
  const run = (captured?: Set<string>): Emitter => {
    const emitter = new Emitter(module.scope, captured, false, future);
    if (annotations.length > 0) emitter.names.add('__conditional_annotations__');
    if (module.doc !== undefined) emitter.names.add('__doc__');
    emitter.statements(module.body);
    if (!future && annotations.some((each) => each.target.kind === 'name')) emitter.names.add('__annotate__');
    return emitter;
  };
  const { captured } = run();
  const emitter = run(captured);
  return { varnames: [...emitter.varnames], names: [...emitter.names], captured };
}

export type AnnotatedAssign = Extract<Statement, { kind: 'annotatedAssign' }>;

/** The annotated assignments of a module's or a class body's own code, in its compound statements too. */
export function moduleAnnotations(body: Statement[]): AnnotatedAssign[] {
  return body.flatMap((statement): AnnotatedAssign[] =>
    statement.kind === 'annotatedAssign' ? [statement] : blocksOf(statement).flatMap(moduleAnnotations)
  );
}

export class Emitter {
  readonly varnames = new Set<string>();
  readonly names = new Set<string>();
  /** What the nested code met so far reads from this code, as its free variables. */
  readonly captured = new Set<string>();
  /** The scopes of the comprehensions the compiler inlines into the code, innermost last. */
  readonly comprehensions: ScopeInfo[] = [];

  constructor(
    readonly scope: ScopeInfo,
    /** What nested code captures, once the first walk found it. */
    private readonly cells: Set<string> = new Set(),
    /** Whether `__class__` is the cell of the class a method is defined in, which `super()` reads. */
    private readonly classCell = false,
    /** Whether annotations are stored into `__annotations__`, as `from __future__ import annotations` does. */
    readonly futureAnnotations = false
  ) {}

  /** A load, store, or deletion of a name, which is a fast local, a cell, or a global or namespace name. */
  name(ref: NameRef): void {
    if (ref.name === '__class__' && this.classCell) return;
    if (ref.access === 'global' || ref.access === 'name' || ref.access === 'classCell') {
      this.names.add(ref.name);
    } else if (this.isFastLocal(ref.name, ref.access === 'local')) {
      this.varnames.add(ref.name);
    }
  }

  /** Whether a variable is a fast local of the code: one no nested code captures, or an inlined comprehension's. */
  private isFastLocal(name: string, local: boolean): boolean {
    // An inlined comprehension's variable is a fast local of the code, a cell too when nested code captures it.
    if (this.comprehensions.some((scope) => scope.locals.includes(name))) return true;
    if (this.cells.has(name)) return false;
    return local || (this.scope.kind === 'function' && this.scope.locals.includes(name));
  }

  /** Notes the variables of this code an annotation reads, which its `__annotate__` captures. */
  annotationReads(annotation: Expression): void {
    for (const name of namesRead(annotation)) {
      if (this.scope.kind === 'function' && this.scope.locals.includes(name)) this.captured.add(name);
    }
  }

  /** Notes the free variables of nested code, which the code defining it keeps in cells. */
  nested(scope: ScopeInfo): void {
    for (const name of scope.frees) this.captured.add(name);
  }

  statements(body: Statement[]): void {
    for (const statement of body) emitStatement(this, statement);
  }

  expression(expression: Expression): void {
    emitExpression(this, expression);
  }
}

/** The names an expression reads, in nested expressions too. */
function namesRead(expression: unknown, found: string[] = []): string[] {
  if (typeof expression !== 'object' || expression === null) return found;
  const node = expression as { kind?: string; name?: string; access?: string };
  if (node.kind === 'name' && typeof node.name === 'string' && node.access !== undefined) found.push(node.name);
  for (const value of Object.values(expression)) {
    if (Array.isArray(value)) for (const each of value) namesRead(each, found);
    else if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) namesRead(value, found);
  }
  return found;
}
