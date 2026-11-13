import type { Expression, Program, Statement } from './ast';

type Loop = Extract<Statement, { kind: 'for' | 'while' | 'doWhile' }>;

/**
 * Marks the loops of a program whose end cannot depend on the clock, which then never poll it however many of their
 * iterations read it: a `for...of` or `for...in` loop that neither breaks nor returns, or a `for`, `while`, or
 * `do...while` loop that neither breaks nor returns and whose test and update only combine literals, the `length` of a
 * variable, and variables that nothing assigns except the loop's update and plain statements directly in its body,
 * which run every iteration: nothing in the program for an outer variable, nothing in the loop for one its init
 * declares. Any busy wait ends through something else, which a clock read can change.
 */
export function markCountedLoops(program: Program): void {
  const assignments = new Map<string, unknown[]>();
  collectAssignments(program, assignments);
  forEachLoop(program, (loop) => {
    if (loop.kind === 'forOf' || loop.kind === 'forIn') {
      if (!leaves(loop.body)) loop.counted = true;
    } else if (
      (loop.kind === 'for' || loop.kind === 'while' || loop.kind === 'doWhile') &&
      isCounted(loop, assignments)
    ) {
      loop.counted = true;
    }
  });
}

function isCounted(loop: Loop, assignments: Map<string, unknown[]>): boolean {
  const update = loop.kind === 'for' ? loop.update : undefined;
  if (!loop.test || !isPlain(loop.test) || (update !== undefined && !isPlain(update)) || leaves(loop.body))
    return false;
  // The assignments that run once an iteration, which only advance the loop as its counter does.
  const own = new Set<unknown>();
  collectAssignmentNodes(update, own);
  const bodyStatements = loop.body.kind === 'block' ? loop.body.body : [loop.body];
  for (const statement of bodyStatements) {
    // Such an assignment advances the loop only when no code computes its value, as `n++` and `n += 2` do.
    if (statement.kind === 'expression' && isPlain(statement.expression)) {
      collectAssignmentNodes(statement.expression, own, false);
    }
  }
  // A variable the loop's own init declares is assigned only inside the loop, whatever other loops do with its name.
  const declared = new Set(
    loop.kind === 'for' && loop.init?.kind === 'declaration'
      ? namesIn(loop.init.declarators.map(({ target }) => target))
      : []
  );
  const inLoop = new Map<string, unknown[]>();
  collectAssignments([loop.test, update, loop.body], inLoop);
  return namesIn(loop.test).every((name) =>
    ((declared.has(name) ? inLoop : assignments).get(name) ?? []).every((node) => own.has(node))
  );
}

/** Whether an expression only combines literals, `X.length` reads, and variables with operators, running no code. */
function isPlain(expression: Expression): boolean {
  switch (expression.kind) {
    case 'identifier':
    case 'literal': {
      return true;
    }
    case 'member': {
      // An array's or a string's length, which no getter of the program computes.
      const { object, property } = expression;
      return object.kind === 'identifier' && property.kind === 'key' && property.key === 'length';
    }
    case 'parenthesized': {
      return isPlain(expression.expression);
    }
    case 'unary': {
      return expression.operator !== 'delete' && isPlain(expression.argument);
    }
    case 'binary':
    case 'logical': {
      return isPlain(expression.left) && isPlain(expression.right);
    }
    case 'update': {
      return expression.target.kind === 'identifier';
    }
    case 'assign': {
      return expression.target.kind === 'identifier' && isPlain(expression.value);
    }
    case 'sequence': {
      return expression.expressions.every(isPlain);
    }
    default: {
      return false;
    }
  }
}

/** Calls `visit` for every loop in the nodes, functions they define included. */
function forEachLoop(
  node: unknown,
  visit: (loop: Extract<Statement, { kind: Loop['kind'] | 'forOf' | 'forIn' }>) => void
): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) forEachLoop(item, visit);
    return;
  }
  const { kind } = node as { kind?: unknown };
  if (kind === 'for' || kind === 'while' || kind === 'doWhile' || kind === 'forOf' || kind === 'forIn') {
    visit(node as Extract<Statement, { kind: Loop['kind'] | 'forOf' | 'forIn' }>);
  }
  for (const value of Object.values(node)) forEachLoop(value, visit);
}

/** Records every assignment or increment in the nodes by the variable names it assigns, functions included. */
function collectAssignments(node: unknown, assignments: Map<string, unknown[]>): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectAssignments(item, assignments);
    return;
  }
  const record = node as { kind?: unknown; target?: unknown };
  if (record.kind === 'assign' || record.kind === 'update') {
    for (const name of namesIn(record.target)) {
      const nodes = assignments.get(name) ?? [];
      nodes.push(node);
      assignments.set(name, nodes);
    }
  }
  for (const value of Object.values(node)) collectAssignments(value, assignments);
}

/** Adds the assignment nodes in an expression; `nested` false takes only the expression itself when it is one. */
function collectAssignmentNodes(node: unknown, nodes: Set<unknown>, nested = true): void {
  if (typeof node !== 'object' || node === null) return;
  const { kind } = node as { kind?: unknown };
  if (kind === 'assign' || kind === 'update') nodes.add(node);
  if (!nested) return;
  for (const value of Object.values(node)) collectAssignmentNodes(value, nodes);
}

/** Whether a statement contains a `break` or `return`, outside any function it defines. */
function leaves(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) return node.some(leaves);
  const { kind } = node as { kind?: unknown };
  if (kind === 'functionExpression' || kind === 'classExpression' || kind === 'function' || kind === 'class')
    return false;
  if (kind === 'break' || kind === 'return') return true;
  return Object.values(node).some(leaves);
}

/** The names of the identifier nodes in a node, which for a pattern are the variables it assigns. */
function namesIn(node: unknown): string[] {
  const names = new Set<string>();
  collectNames(node, names);
  return [...names];
}

function collectNames(node: unknown, names: Set<string>): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectNames(item, names);
    return;
  }
  const record = node as { kind?: unknown; name?: unknown };
  if (record.kind === 'identifier' && typeof record.name === 'string') names.add(record.name);
  for (const value of Object.values(node)) collectNames(value, names);
}
