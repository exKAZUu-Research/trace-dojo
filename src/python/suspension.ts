import type { Element, Expression, FormattedValue, Parameter, Statement, Target } from './ast';

/**
 * Marks the statements of a generator's body, and the expressions in them, that may suspend the generator in the middle
 * of an expression. Nested functions, lambdas, classes, and comprehensions run in frames of their own, so only the
 * parts of them that the enclosing frame evaluates count: defaults, decorators, bases, and a comprehension's first
 * iterable.
 */
export function markSuspendingStatements(statements: Statement[]): void {
  for (const statement of statements) {
    const suspends = markAll(expressionsOf(statement));
    if (suspends) statement.suspends = true;
    for (const block of blocksOf(statement)) markSuspendingStatements(block);
  }
}

/** Whether marking makes every call suspend, as a blocking operation in it may suspend the running thread. */
let callsSuspend = false;

/**
 * Marks every statement of a module that calls a function, in the module and in every function, as one that may
 * suspend the running thread in the middle, which a blocking operation of a thread does. Class bodies, decorators, and
 * defaults run synchronously, where waiting stays on the host's stack.
 */
export function markAllSuspending(statements: Statement[]): void {
  callsSuspend = true;
  try {
    markCalls(statements, true);
  } finally {
    callsSuspend = false;
  }
}

function markCalls(statements: Statement[], marksHere: boolean): void {
  for (const statement of statements) {
    if (statement.kind === 'functionDef') {
      if (Array.isArray(statement.fn.body)) markCalls(statement.fn.body, true);
      continue;
    }
    if (statement.kind === 'classDef') {
      markCalls(statement.cls.body, false);
      continue;
    }
    // A with statement calls `__enter__` and `__exit__`, which may wait for a lock.
    if (marksHere && (markAll(expressionsOf(statement)) || statement.kind === 'with')) statement.suspends = true;
    for (const block of blocksOf(statement)) markCalls(block, marksHere);
  }
}

/** Marks an expression and its parts that may suspend, returning whether it may. */
export function markSuspendingExpression(expression: Expression): boolean {
  if (callsSuspend) markThreadParts(expression);
  const partsSuspend = markAll(partsOf(expression));
  const comprehensionSuspends = expression.kind === 'comprehension' && markAsyncComprehension(expression);
  const suspends =
    partsSuspend ||
    (callsSuspend && expression.kind === 'comprehension') ||
    (callsSuspend && expression.kind === 'call') ||
    expression.kind === 'yield' ||
    expression.kind === 'yieldFrom' ||
    expression.kind === 'await' ||
    comprehensionSuspends;
  if (suspends) expression.suspends = true;
  return suspends;
}

/**
 * Marks, in a program that runs threads, the parts of an expression that run in a frame of their own, where a call may
 * also wait for another thread: a lambda's body, and a comprehension's clauses and elements, which a comprehension
 * then runs step by step.
 */
function markThreadParts(expression: Expression): void {
  if (expression.kind === 'lambda' && !Array.isArray(expression.fn.body)) {
    markSuspendingExpression(expression.fn.body);
  } else if (expression.kind === 'comprehension') {
    const [first, ...rest] = expression.generators;
    markAll([
      ...first.conditions,
      ...rest.flatMap((generator) => [generator.iterable, ...generator.conditions]),
      expression.element,
      expression.value,
    ]);
  }
}

/**
 * Marks the parts of an async comprehension, which its own frame evaluates step by step, returning whether evaluating
 * it suspends the enclosing coroutine: an async generator expression only creates its async generator.
 */
function markAsyncComprehension(expression: Extract<Expression, { kind: 'comprehension' }>): boolean {
  if (!expression.scope.isAsync) return false;
  const [first, ...rest] = expression.generators;
  markAll([
    ...first.conditions,
    ...rest.flatMap((generator) => [generator.iterable, ...generator.conditions]),
    expression.element,
    expression.value,
  ]);
  return expression.type !== 'generator';
}

/** Whether evaluating a target's parts may suspend, which marks of its expressions tell. */
export function targetSuspends(target: Target): boolean {
  return targetParts(target).some((part) => part.suspends === true);
}

function markAll(expressions: (Expression | undefined)[]): boolean {
  let suspends = false;
  for (const expression of expressions) if (expression && markSuspendingExpression(expression)) suspends = true;
  return suspends;
}

// code-gauge-allow functionNcss 34 -- One case per kind of statement, listing the expressions it evaluates.
function expressionsOf(statement: Statement): (Expression | undefined)[] {
  switch (statement.kind) {
    case 'expression': {
      return [statement.expression];
    }
    case 'assign': {
      return [statement.value, ...statement.targets.flatMap(targetParts)];
    }
    case 'augmentedAssign':
    case 'annotatedAssign': {
      return [...targetParts(statement.target), statement.value];
    }
    case 'delete': {
      return statement.targets.flatMap(targetParts);
    }
    case 'return': {
      return [statement.value];
    }
    case 'raise': {
      return [statement.exception, statement.cause];
    }
    case 'assert': {
      return [statement.test, statement.message];
    }
    case 'if':
    case 'while': {
      return [statement.test];
    }
    case 'for': {
      return [statement.iterable, ...targetParts(statement.target)];
    }
    case 'try': {
      return statement.handlers.map((handler) => handler.types);
    }
    case 'with': {
      return statement.items.flatMap((item) => [item.context, ...(item.target ? targetParts(item.target) : [])]);
    }
    case 'match': {
      return [statement.subject, ...statement.cases.map((matchCase) => matchCase.guard)];
    }
    case 'functionDef': {
      return [...statement.fn.decorators, ...defaultsOf(statement.fn.params)];
    }
    case 'classDef': {
      return [...statement.cls.decorators, ...statement.cls.bases.map((base) => base.value)];
    }
    default: {
      return [];
    }
  }
}

/** The statement lists a compound statement runs, without those of nested definitions. */
export function blocksOf(statement: Statement): Statement[][] {
  switch (statement.kind) {
    case 'if':
    case 'while':
    case 'for': {
      return [statement.body, statement.orelse];
    }
    case 'try': {
      return [
        statement.body,
        ...statement.handlers.map((handler) => handler.body),
        statement.orelse,
        statement.finalbody,
      ];
    }
    case 'with': {
      return [statement.body];
    }
    case 'match': {
      return statement.cases.map((matchCase) => matchCase.body);
    }
    default: {
      return [];
    }
  }
}

function targetParts(target: Target): Expression[] {
  switch (target.kind) {
    case 'name': {
      return [];
    }
    case 'attribute': {
      return [target.object];
    }
    case 'subscript': {
      return [target.object, target.index];
    }
    case 'unpack': {
      return target.elements.flatMap(targetParts);
    }
  }
}

function defaultsOf(params: Parameter[]): (Expression | undefined)[] {
  return params.map((param) => param.default);
}

// code-gauge-allow functionNcss 39 -- One case per kind of expression, listing the parts its frame evaluates.
function partsOf(expression: Expression): (Expression | undefined)[] {
  switch (expression.kind) {
    case 'fstring': {
      return expression.parts.flatMap(formattedParts);
    }
    case 'list':
    case 'tuple':
    case 'set': {
      return expression.elements.map(elementValue);
    }
    case 'dict': {
      return expression.items.flatMap((item) => (item.kind === 'pair' ? [item.key, item.value] : [item.value]));
    }
    case 'attribute': {
      return [expression.object];
    }
    case 'subscript': {
      return [expression.object, expression.index];
    }
    case 'slice': {
      return [expression.lower, expression.upper, expression.step];
    }
    case 'call': {
      return [expression.callee, ...expression.args.map((argument) => argument.value)];
    }
    case 'binary':
    case 'boolean': {
      return [expression.left, expression.right];
    }
    case 'unary':
    case 'not': {
      return [expression.operand];
    }
    case 'compare': {
      return expression.operands;
    }
    case 'conditional': {
      return [expression.test, expression.body, expression.orelse];
    }
    case 'lambda': {
      return defaultsOf(expression.fn.params);
    }
    case 'namedExpression':
    case 'yield':
    case 'yieldFrom':
    case 'await': {
      return [expression.value];
    }
    case 'comprehension': {
      return [expression.generators[0].iterable];
    }
    default: {
      return [];
    }
  }
}

function formattedParts(part: string | FormattedValue): Expression[] {
  if (typeof part === 'string') return [];
  return part.spec ? [part.expression, part.spec] : [part.expression];
}

function elementValue(element: Element): Expression {
  return element.kind === 'starred' ? element.value : element;
}
