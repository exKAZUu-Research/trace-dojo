import type { Expression, Statement } from './ast';

/**
 * Marks a loop whose end cannot depend on the clock, which then never polls it however many of its iterations read it:
 * a `for`, `while`, or `do...while` whose test and update only combine variables and literals, and whose body neither
 * breaks, returns, nor assigns a variable the test reads; or a `for...of` or `for...in` whose body neither breaks nor
 * returns. Any busy wait ends through something else, which a clock read can change.
 */
export function markCountedLoop(statement: Statement): void {
  if (statement.kind === 'forOf' || statement.kind === 'forIn') {
    if (!leaves(statement.body)) statement.counted = true;
    return;
  }
  if (statement.kind !== 'for' && statement.kind !== 'while' && statement.kind !== 'doWhile') return;
  const { test } = statement;
  const update = statement.kind === 'for' ? statement.update : undefined;
  if (!test || !isPlain(test) || (update !== undefined && !isPlain(update))) return;
  const names = new Set<string>();
  collectNames(test, names);
  if (!leaves(statement.body) && !assignsAny(statement.body, names)) statement.counted = true;
}

/** Whether an expression only combines variables and literals with operators, so evaluating it runs no program code. */
function isPlain(expression: Expression): boolean {
  switch (expression.kind) {
    case 'identifier':
    case 'literal': {
      return true;
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

/** Whether anything in a statement, functions it defines included, assigns or increments a variable named in `names`. */
function assignsAny(node: unknown, names: Set<string>): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) return node.some((item) => assignsAny(item, names));
  const record = node as { kind?: unknown; target?: unknown };
  if (
    (record.kind === 'assign' || record.kind === 'update') &&
    patternNames(record.target).some((name) => names.has(name))
  ) {
    return true;
  }
  return Object.values(node).some((value) => assignsAny(value, names));
}

/** The variables a pattern assigns, or reads for an expression, found by their identifier nodes. */
function patternNames(node: unknown): string[] {
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
