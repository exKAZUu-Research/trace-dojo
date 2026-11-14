// The order CPython's compiler emits the parts of each statement, expression, and pattern in, which decides the
// order of a code object's `co_varnames` and `co_names`.
import type {
  Argument,
  Comprehension,
  Element,
  Expression,
  FunctionDef,
  MatchCase,
  NameRef,
  Pattern,
  Statement,
  Target,
} from './ast';
import { type AnnotatedAssign, type ComprehensionExpression, type Emitter, moduleAnnotations } from './codeNames';

type Handlers<T extends { kind: string }> = {
  [K in T['kind']]?: (emitter: Emitter, node: Extract<T, { kind: K }>) => void;
};

export function emitStatement(emitter: Emitter, statement: Statement): void {
  (STATEMENTS[statement.kind] as ((emitter: Emitter, node: Statement) => void) | undefined)?.(emitter, statement);
}

export function emitExpression(emitter: Emitter, expression: Expression): void {
  (EXPRESSIONS[expression.kind] as ((emitter: Emitter, node: Expression) => void) | undefined)?.(emitter, expression);
}

const each = (emitter: Emitter, nodes: (Expression | undefined)[]): void => {
  for (const node of nodes) if (node) emitter.expression(node);
};

const STATEMENTS: Handlers<Statement> = {
  expression: (e, s) => e.expression(s.expression),
  assign: (e, s) => {
    e.expression(s.value);
    for (const target of s.targets) storeTarget(e, target);
  },
  augmentedAssign: (e, s) => {
    loadTarget(e, s.target);
    e.expression(s.value);
    if (s.target.kind === 'name') e.name(s.target);
    else if (s.target.kind === 'attribute') e.names.add(s.target.name);
  },
  annotatedAssign: (e, s) => annotatedAssign(e, s),
  delete: (e, s) => {
    for (const target of s.targets) storeTarget(e, target);
  },
  return: (e, s) => each(e, [s.value]),
  raise: (e, s) => each(e, [s.exception, s.cause]),
  assert: (e, s) => each(e, [s.test, s.message]),
  if: (e, s) => loop(e, s.test, s.body, s.orelse),
  while: (e, s) => loop(e, s.test, s.body, s.orelse),
  for: (e, s) => {
    e.expression(s.iterable);
    storeTarget(e, s.target);
    e.statements(s.body);
    e.statements(s.orelse);
  },
  // The else clause follows the body, before the handlers, and the finally clause comes last.
  try: (e, s) => {
    e.statements(s.body);
    e.statements(s.orelse);
    for (const handler of s.handlers) {
      each(e, [handler.types]);
      if (handler.name) e.name(handler.name);
      e.statements(handler.body);
    }
    e.statements(s.finalbody);
  },
  with: (e, s) => {
    for (const item of s.items) {
      e.expression(item.context);
      if (item.target) storeTarget(e, item.target);
    }
    e.statements(s.body);
  },
  match: (e, s) => {
    e.expression(s.subject);
    for (const matchCase of s.cases) emitCase(e, matchCase);
  },
  functionDef: (e, s) => {
    definition(e, s.fn);
    e.name(s.binding);
  },
  classDef: (e, s) => {
    const { cls } = s;
    e.nested(cls.scope);
    if (cls.typeParams) e.nested(cls.typeParams.scope);
    for (const annotated of moduleAnnotations(cls.body)) e.annotationReads(annotated.annotation);
    each(e, cls.decorators);
    if (!cls.typeParams) emitArguments(e, cls.bases);
    e.name(s.binding);
  },
  typeAlias: (e, s) => {
    e.nested(s.typeParams.scope);
    e.name(s.binding);
  },
  import: (e, s) => {
    for (const { module, binding, bindsModule } of s.names) {
      e.names.add(module);
      // `import a.b as c` reads each submodule from its package.
      if (bindsModule) for (const part of module.split('.').slice(1)) e.names.add(part);
      e.name(binding);
    }
  },
  importFrom: (e, s) => {
    e.names.add(s.module.replace(/^\.+/, ''));
    for (const { name, binding } of s.names) {
      e.names.add(name);
      e.name(binding);
    }
  },
  importStar: (e, s) => {
    e.names.add(s.module.replace(/^\.+/, ''));
  },
};

function loop(emitter: Emitter, test: Expression, body: Statement[], orelse: Statement[]): void {
  emitter.expression(test);
  emitter.statements(body);
  emitter.statements(orelse);
}

/**
 * `target: annotation = value`: the value and the target, or for an attribute or a subscript without a value the
 * object it checks; under `from __future__ import annotations` a module's name annotation goes into `__annotations__`.
 */
function annotatedAssign(emitter: Emitter, { target, value }: AnnotatedAssign): void {
  if (value) {
    emitter.expression(value);
    storeTarget(emitter, target);
  } else if (target.kind === 'attribute') {
    emitter.expression(target.object);
  } else if (target.kind === 'subscript') {
    each(emitter, [target.object, target.index]);
  }
  if (emitter.futureAnnotations && target.kind === 'name' && emitter.scope.kind === 'module') {
    emitter.names.add('__annotations__');
  }
}

/** What a nested `def` evaluates where it is defined: its decorators, then its defaults. */
function definition(emitter: Emitter, fn: FunctionDef): void {
  emitter.nested(fn.scope);
  if (fn.typeParams) emitter.nested(fn.typeParams.scope);
  // The annotations are the code of the function's `__annotate__`, which captures what they read from here.
  for (const param of fn.params) if (param.annotation) emitter.annotationReads(param.annotation);
  if (fn.returns) emitter.annotationReads(fn.returns);
  each(emitter, fn.decorators);
  if (!fn.typeParams) defaults(emitter, fn);
}

/** The defaults of the positional parameters, then those of the keyword-only ones. */
function defaults(emitter: Emitter, fn: FunctionDef): void {
  const positional = fn.params.filter((param) => param.kind === 'positionalOnly' || param.kind === 'positional');
  each(
    emitter,
    positional.map((param) => param.default)
  );
  each(
    emitter,
    fn.params.filter((param) => param.kind === 'keywordOnly').map((param) => param.default)
  );
}

const positional = (arg: Argument): boolean => arg.kind === 'positional' || arg.kind === 'star';

/** Positional and starred arguments, then keyword and double-starred ones. */
function emitArguments(emitter: Emitter, args: Argument[]): void {
  each(
    emitter,
    args.filter(positional).map((arg) => arg.value)
  );
  each(
    emitter,
    args.filter((arg) => !positional(arg)).map((arg) => arg.value)
  );
}

const elementValues = (elements: Element[]): Expression[] =>
  elements.map((element) => (element.kind === 'starred' ? element.value : element));

/** A store or deletion target. */
function storeTarget(emitter: Emitter, target: Target): void {
  if (target.kind === 'name') emitter.name(target);
  else if (target.kind === 'unpack') for (const element of target.elements) storeTarget(emitter, element);
  else if (target.kind === 'attribute') {
    emitter.expression(target.object);
    emitter.names.add(target.name);
  } else each(emitter, [target.object, target.index]);
}

/** What an augmented assignment reads first: the name, or the object and index of an attribute or subscript. */
function loadTarget(emitter: Emitter, target: Target): void {
  if (target.kind === 'name') emitter.name(target);
  else if (target.kind === 'attribute') {
    emitter.expression(target.object);
    emitter.names.add(target.name);
  } else if (target.kind === 'subscript') each(emitter, [target.object, target.index]);
}

/** The elements of a list, tuple, or set display. */
function displayElements(emitter: Emitter, expression: Expression): void {
  each(emitter, elementValues((expression as Extract<Expression, { elements: Element[] }>).elements));
}

const EXPRESSIONS: Handlers<Expression> = {
  name: (e, x) => e.name(x),
  fstring: (e, x) => {
    for (const part of x.parts) if (typeof part !== 'string') each(e, [part.expression, part.spec]);
  },
  list: displayElements,
  tuple: displayElements,
  set: displayElements,
  dict: (e, x) => {
    for (const item of x.items) each(e, item.kind === 'pair' ? [item.key, item.value] : [item.value]);
  },
  attribute: (e, x) => {
    e.expression(x.object);
    e.names.add(x.name);
  },
  subscript: (e, x) => each(e, [x.object, x.index]),
  slice: (e, x) => each(e, [x.lower, x.upper, x.step]),
  call: (e, x) => {
    e.expression(x.callee);
    emitArguments(e, x.args);
  },
  binary: (e, x) => each(e, [x.left, x.right]),
  boolean: (e, x) => each(e, [x.left, x.right]),
  unary: (e, x) => e.expression(x.operand),
  not: (e, x) => e.expression(x.operand),
  conditional: (e, x) => each(e, [x.test, x.body, x.orelse]),
  compare: (e, x) => each(e, x.operands),
  lambda: (e, x) => {
    e.nested(x.fn.scope);
    defaults(e, x.fn);
  },
  namedExpression: (e, x) => {
    e.expression(x.value);
    // An inlined comprehension in a module or a class body keeps its walrus target as a hidden fast local too.
    if (e.comprehensions.length > 0 && e.scope.kind !== 'function') e.varnames.add(x.target.name);
    e.name(x.target);
  },
  comprehension: (e, x) => comprehension(e, x),
  yield: (e, x) => each(e, [x.value]),
  yieldFrom: (e, x) => e.expression(x.value),
  await: (e, x) => e.expression(x.value),
};

/**
 * A comprehension: a generator expression is code of its own, which takes its first iterable from here, while the
 * others CPython inlines, emitting each clause's target and conditions before the next clause, then the element.
 */
function comprehension(emitter: Emitter, expression: ComprehensionExpression): void {
  const [first] = expression.generators as [Comprehension, ...Comprehension[]];
  emitter.expression(first.iterable);
  if (expression.type === 'generator') {
    emitter.nested(expression.scope);
    return;
  }
  emitter.comprehensions.push(expression.scope);
  try {
    comprehensionBody(emitter, expression);
  } finally {
    emitter.comprehensions.pop();
  }
}

/** The clauses and the element of a comprehension, as the code of a generator expression runs them. */
export function comprehensionBody(emitter: Emitter, expression: ComprehensionExpression): void {
  for (const [index, clause] of expression.generators.entries()) {
    if (index > 0) emitter.expression(clause.iterable);
    storeTarget(emitter, clause.target);
    each(emitter, clause.conditions);
  }
  each(emitter, [expression.element, expression.value]);
}

/** A case: the loads of its pattern, the stores of its captures once it matches, then its guard and body. */
function emitCase(emitter: Emitter, matchCase: MatchCase): void {
  const captures: NameRef[] = [];
  emitPattern(emitter, matchCase.pattern, captures);
  for (const capture of captures) emitter.name(capture);
  each(emitter, [matchCase.guard]);
  emitter.statements(matchCase.body);
}

function emitPattern(emitter: Emitter, pattern: Pattern, captures: NameRef[]): void {
  (PATTERNS[pattern.kind] as ((e: Emitter, p: Pattern, c: NameRef[]) => void) | undefined)?.(
    emitter,
    pattern,
    captures
  );
}

type PatternHandlers = {
  [K in Pattern['kind']]?: (emitter: Emitter, pattern: Extract<Pattern, { kind: K }>, captures: NameRef[]) => void;
};

const PATTERNS: PatternHandlers = {
  value: (e, p) => e.expression(p.value),
  capture: (_e, p, c) => {
    if (p.name) c.push(p.name);
  },
  star: (_e, p, c) => {
    if (p.name) c.push(p.name);
  },
  sequence: (e, p, c) => {
    for (const sub of p.patterns) emitPattern(e, sub, c);
  },
  mapping: (e, p, c) => {
    each(e, p.keys);
    for (const sub of p.patterns) emitPattern(e, sub, c);
    if (p.rest) c.push(p.rest);
  },
  class: (e, p, c) => {
    e.expression(p.cls);
    for (const sub of [...p.patterns, ...p.keywordPatterns]) emitPattern(e, sub, c);
  },
  // Every alternative binds the same names, which the compiler stores in the order of the first.
  or: (e, p, c) => {
    for (const [index, sub] of p.patterns.entries()) emitPattern(e, sub, index === 0 ? c : []);
  },
  as: (e, p, c) => {
    emitPattern(e, p.pattern, c);
    c.push(p.name);
  },
};
