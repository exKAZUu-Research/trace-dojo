import type { Expression, Statement } from './ast';

/**
 * Marks a loop whose end cannot depend on the clock, which then never polls it however many of its iterations read it:
 * a `for...of` or `for...in` loop that neither breaks nor returns, or a `for` loop that neither breaks nor returns and
 * whose test and update only combine literals, the `length` of a variable, and variables its init declares that only
 * its update assigns: only code inside the loop can see those, so no code it calls can change when it ends. Any busy wait
 * ends through something else, which a clock read can change.
 */
export function markCountedLoop(statement: Statement): void {
  if (statement.kind === 'forOf' || statement.kind === 'forIn') {
    if (!leaves(statement.body)) statement.counted = true;
    return;
  }
  if (statement.kind !== 'for' || !statement.test || statement.init?.kind !== 'declaration') return;
  const own = new Set(statement.init.declarators.flatMap(({ target }) => namesIn(target)));
  const { test, update, body } = statement;
  if (!usesOnly(test, own) || (update !== undefined && !usesOnly(update, own))) return;
  if (leaves(body) || assignsAny(body, own)) return;
  statement.counted = true;
}

/** Whether an expression only combines literals, `X.length` reads, and the variables in `own` with operators. */
function usesOnly(expression: Expression, own: Set<string>): boolean {
  switch (expression.kind) {
    case 'identifier': {
      return own.has(expression.name);
    }
    case 'literal': {
      return true;
    }
    case 'member': {
      // An array's or a string's length, which no getter of the program computes.
      return (
        expression.object.kind === 'identifier' &&
        expression.property.kind === 'key' &&
        expression.property.key === 'length'
      );
    }
    case 'parenthesized': {
      return usesOnly(expression.expression, own);
    }
    case 'unary': {
      return expression.operator !== 'delete' && usesOnly(expression.argument, own);
    }
    case 'binary':
    case 'logical': {
      return usesOnly(expression.left, own) && usesOnly(expression.right, own);
    }
    case 'update': {
      return expression.target.kind === 'identifier' && own.has(expression.target.name);
    }
    case 'assign': {
      return (
        expression.target.kind === 'identifier' && own.has(expression.target.name) && usesOnly(expression.value, own)
      );
    }
    case 'sequence': {
      return expression.expressions.every((item) => usesOnly(item, own));
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
  if (isFunctionKind(kind)) return false;
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
    namesIn(record.target).some((name) => names.has(name))
  ) {
    return true;
  }
  return Object.values(node).some((value) => assignsAny(value, names));
}

function isFunctionKind(kind: unknown): boolean {
  return kind === 'functionExpression' || kind === 'classExpression' || kind === 'function' || kind === 'class';
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
