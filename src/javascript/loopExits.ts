import type { Statement } from './ast';

/**
 * Marks the `if` statements of a loop's body, when the statement is a loop, whose taken branch can end the loop: one
 * that breaks out of it, returns, or assigns a variable its test reads, as a flag-controlled wait does. A clock read in
 * their condition, as in the loop's test, tells that the clock decides when the loop ends.
 */
export function markLoopExits(statement: Statement): void {
  if (statement.kind === 'forOf' || statement.kind === 'forIn') {
    markExits(statement.body, new Set());
  } else if (statement.kind === 'while' || statement.kind === 'doWhile' || statement.kind === 'for') {
    const testNames = new Set<string>();
    if (statement.test) collectReadNames(statement.test, testNames);
    markExits(statement.body, testNames);
  }
}

/** Marks the exits among a statement and the statements nested in it, short of nested loops and functions. */
function markExits(statement: Statement, testNames: Set<string>): void {
  if (statement.kind === 'if' && branchesOf(statement).some((branch) => endsLoop(branch, testNames, false))) {
    statement.exitsLoop = true;
  }
  for (const child of childrenOf(statement)) markExits(child, testNames);
}

/** Whether a statement can end the loop it is in: by `return`, a `break` out of it, or assigning what its test reads. */
function endsLoop(statement: Statement, testNames: Set<string>, inSwitch: boolean): boolean {
  if (statement.kind === 'return') return true;
  // An unlabeled break in a switch only leaves the switch.
  if (statement.kind === 'break') return statement.label !== undefined || !inSwitch;
  if (statement.kind === 'expression') return assignsAny(statement.expression, testNames);
  const nestedInSwitch = inSwitch || statement.kind === 'switch';
  return childrenOf(statement).some((child) => endsLoop(child, testNames, nestedInSwitch));
}

function branchesOf(statement: Extract<Statement, { kind: 'if' }>): Statement[] {
  return statement.alternate ? [statement.consequent, statement.alternate] : [statement.consequent];
}

/** The statements directly nested in a statement, other than a loop's, which runs as a loop of its own. */
function childrenOf(statement: Statement): Statement[] {
  switch (statement.kind) {
    case 'if': {
      return branchesOf(statement);
    }
    case 'block': {
      return statement.body;
    }
    case 'labeled': {
      return [statement.body];
    }
    case 'try': {
      return [statement.block, statement.handler?.body, statement.finalizer].filter((block) => block !== undefined);
    }
    case 'switch': {
      return statement.cases.flatMap((switchCase) => switchCase.body);
    }
    default: {
      return [];
    }
  }
}

/** Whether an expression assigns, or increments, a variable named in `names`, outside any function it defines. */
function assignsAny(node: unknown, names: Set<string>): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if (Array.isArray(node)) return node.some((item) => assignsAny(item, names));
  const record = node as { kind?: unknown; target?: { kind?: unknown; name?: unknown } };
  if (record.kind === 'functionExpression' || record.kind === 'classExpression') return false;
  const name = record.kind === 'assign' || record.kind === 'update' ? targetName(record.target) : undefined;
  if (name !== undefined && names.has(name)) return true;
  return Object.values(node).some((value) => assignsAny(value, names));
}

function targetName(target: { kind?: unknown; name?: unknown } | undefined): string | undefined {
  return target?.kind === 'identifier' && typeof target.name === 'string' ? target.name : undefined;
}

/** The variables an expression reads, outside any function it defines. */
function collectReadNames(node: unknown, names: Set<string>): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectReadNames(item, names);
    return;
  }
  const record = node as { kind?: unknown; name?: unknown };
  if (record.kind === 'functionExpression' || record.kind === 'classExpression') return;
  if (record.kind === 'identifier' && typeof record.name === 'string') names.add(record.name);
  for (const value of Object.values(node)) collectReadNames(value, names);
}
