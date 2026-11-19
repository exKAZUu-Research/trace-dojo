import type { Expression, Pattern, Statement } from './ast';

/**
 * The names a function body assigns, other than in declarations, and those it assigns inside nested closures, which
 * flow analysis needs to decide what it may promote.
 */
export function assignedNames(root: unknown): { all: Set<string>; inClosures: Set<string> } {
  const all = new Set<string>();
  const inClosures = new Set<string>();
  const visit = (node: unknown, inClosure: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, inClosure);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as { kind?: string } & Record<string, unknown>;
    const childInClosure = inClosure || record.kind === 'function' || record.kind === 'localFunction';
    const assigned = assignedName(record);
    if (assigned) {
      all.add(assigned);
      if (inClosure) inClosures.add(assigned);
    }
    if (record.kind === 'patternAssign')
      collectPatternNames((record as unknown as { pattern: Pattern }).pattern, all, inClosure ? inClosures : undefined);
    for (const [key, value] of Object.entries(record)) {
      if (key === 'row' || key === 'column' || key === 'start' || key === 'end') continue;
      if (typeof value === 'object' && value !== null) visit(value, childInClosure);
    }
  };
  visit(root, false);
  return { all, inClosures };
}

function assignedName(node: { kind?: string } & Record<string, unknown>): string | undefined {
  if (node.kind === 'assign') {
    const target = (node as unknown as { target: Expression }).target;
    return target.kind === 'identifier' ? target.name : undefined;
  }
  if (node.kind === 'postfix' || (node.kind === 'prefix' && (node.operator === '++' || node.operator === '--'))) {
    const operand = (node as unknown as { operand: Expression }).operand;
    return operand.kind === 'identifier' ? operand.name : undefined;
  }
  if (node.kind === 'forIn' || node.kind === 'forInElement') {
    const binding = (node as unknown as { binding: { kind: string; name?: string } }).binding;
    return binding.kind === 'identifier' ? binding.name : undefined;
  }
  return undefined;
}

function collectPatternNames(pattern: unknown, into: Set<string>, alsoInto: Set<string> | undefined): void {
  if (Array.isArray(pattern)) {
    for (const item of pattern) collectPatternNames(item, into, alsoInto);
    return;
  }
  if (typeof pattern !== 'object' || pattern === null) return;
  const record = pattern as { kind?: string; name?: string } & Record<string, unknown>;
  if (record.kind === 'assignedVariable' && record.name) {
    into.add(record.name);
    alsoInto?.add(record.name);
  }
  for (const value of Object.values(record)) if (typeof value === 'object') collectPatternNames(value, into, alsoInto);
}

/** The names a statement assigns, for the variables a loop must forget the promotions of. */
export function namesAssignedIn(statement: Statement | Expression | object): Set<string> {
  return assignedNames(statement).all;
}
