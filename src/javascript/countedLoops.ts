import type { Expression, Program, Statement } from './ast';

type ForLoop = Extract<Statement, { kind: 'for' }>;

/**
 * Marks the counted `for` loops of a program, which then never poll the clock however many of their iterations read
 * it: `for (let i = <number>; i <op> <bound>; <step>)` whose bound is a number or a `const` the program only ever
 * gives a number, whose step adds or subtracts a number, and whose body neither breaks, returns, throws, nor writes `i`.
 * Only the loop can see `i`, and nothing can change the bound, so the clock cannot decide when the loop ends; any
 * other loop keeps polling once it has read the clock in enough iterations, since proving more of them independent of
 * the clock has kept missing ways a busy wait can end.
 */
export function markCountedLoops(program: Program): void {
  const constants = numericConstants(program);
  forEachFor(program, (loop) => {
    if (isCounted(loop, constants)) loop.counted = true;
  });
}

function isCounted(loop: ForLoop, constants: Set<string>): boolean {
  const { init, test, update, body } = loop;
  if (init?.kind !== 'declaration' || init.declarationKind !== 'let' || init.declarators.length !== 1) return false;
  const [{ target, init: start }] = init.declarators;
  if (target.kind !== 'identifier' || !isNumber(start)) return false;
  const counter = target.name;
  const bounded =
    test?.kind === 'binary' &&
    ['<', '<=', '>', '>=', '!=='].includes(test.operator) &&
    isIdentifier(test.left, counter) &&
    (isNumber(test.right) || (test.right.kind === 'identifier' && constants.has(test.right.name)));
  return bounded && isStep(update, counter) && !leaves(body) && !writes(body, counter);
}

/** Whether an update steps the counter by a number: `i++`, `--i`, `i += 2`, or `i -= 1`. */
function isStep(update: Expression | undefined, counter: string): boolean {
  if (update?.kind === 'update') return isIdentifier(update.target, counter);
  if (update?.kind !== 'assign' || (update.operator !== '+=' && update.operator !== '-=')) return false;
  return isIdentifier(update.target, counter) && isNumber(update.value);
}

/** The names every declaration of which in the program is a `const` given a number, and that nothing writes. */
function numericConstants(program: Program): Set<string> {
  const numeric = new Set<string>();
  const other = new Set<string>();
  walk(program, (node) => {
    for (const [name, isNumeric] of bindingsMade(node)) (isNumeric ? numeric : other).add(name);
  });
  for (const name of other) numeric.delete(name);
  return numeric;
}

/** The names a node gives a value, each with whether it is a `const` given a number. */
function bindingsMade(node: object): [string, boolean][] {
  const record = node as { kind?: unknown; declarationKind?: unknown; declarators?: unknown; target?: unknown };
  if (record.kind === 'declaration') {
    const declarators = record.declarators as { target: unknown; init?: Expression }[];
    const isConst = record.declarationKind === 'const';
    return declarators.flatMap(({ target, init }) =>
      namesIn(target).map((name): [string, boolean] => [name, isConst && isNumber(init)])
    );
  }
  if (record.kind === 'assign' || record.kind === 'update' || record.kind === 'forOf' || record.kind === 'forIn') {
    return namesIn(record.target).map((name) => [name, false]);
  }
  if ('params' in record && 'isGenerator' in record)
    return namesIn([(record as { params: unknown }).params, (record as { rest?: unknown }).rest]).map((name) => [
      name,
      false,
    ]);
  return [];
}

function isNumber(expression: Expression | undefined): boolean {
  if (expression?.kind === 'unary' && expression.operator === '-') return isNumber(expression.argument);
  return expression?.kind === 'literal' && typeof expression.value === 'number';
}

function isIdentifier(node: unknown, name: string): boolean {
  const record = node as { kind?: unknown; name?: unknown } | undefined;
  return record?.kind === 'identifier' && record.name === name;
}

/** Whether a node, functions it defines included, writes the variable `name`. */
function writes(node: unknown, name: string): boolean {
  let found = false;
  walk(node, (child) => {
    const record = child as { kind?: unknown; target?: unknown; init?: unknown };
    const isWrite =
      record.kind === 'assign' ||
      record.kind === 'update' ||
      record.kind === 'forOf' ||
      record.kind === 'forIn' ||
      (record.kind === undefined && 'target' in record && 'init' in record);
    if (isWrite && namesIn(record.target).includes(name)) found = true;
  });
  return found;
}

/** Whether a statement contains a `break`, `return`, or `throw`, outside any function it defines. */
function leaves(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) return node.some(leaves);
  const { kind } = node as { kind?: unknown };
  if (kind === 'functionExpression' || kind === 'classExpression' || kind === 'function' || kind === 'class')
    return false;
  if (kind === 'break' || kind === 'return' || kind === 'throw') return true;
  return Object.values(node).some(leaves);
}

function forEachFor(node: unknown, visit: (loop: ForLoop) => void): void {
  walk(node, (child) => {
    if ((child as { kind?: unknown }).kind === 'for') visit(child as ForLoop);
  });
}

/** Calls `visit` for every object in a node, functions it defines included. */
function walk(node: unknown, visit: (node: object) => void): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

function namesIn(node: unknown): string[] {
  const names: string[] = [];
  walk(node, (child) => {
    const record = child as { kind?: unknown; name?: unknown };
    if (record.kind === 'identifier' && typeof record.name === 'string') names.push(record.name);
  });
  return names;
}
