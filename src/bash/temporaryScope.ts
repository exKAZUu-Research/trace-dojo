import type { Assignment } from './ast';
import type { Shell } from './shell';
import { applyCaseAttributes, isIdentifier, type Scope, type Variable } from './variables';

export function populateTemporaryScope(shell: Shell, scope: Scope, assignments: Assignment[]): boolean {
  for (const assignment of assignments) {
    if (assignment.subscript || assignment.array) {
      if (!shell.performAssignment(assignment)) return false;
      continue;
    }
    bindTemporaryVariable(shell, scope, assignment);
  }
  return true;
}

function bindTemporaryVariable(shell: Shell, scope: Scope, assignment: Assignment): void {
  const value = assignment.value ? shell.expander.expandAssignmentValue(assignment.value) : '';
  const resolved = resolveTemporaryTarget(shell, assignment.name);
  if (!resolved) return;
  const { targetName, elementLink } = resolved;
  if (shell.findOwnVariable(targetName)?.attributes.has('r') || shell.isReadonlyDynamic(targetName)) {
    // Bash reports the assignment and runs the command without it.
    shell.reportError(`${targetName}: readonly variable`);
    return;
  }
  const combined = elementLink
    ? combineElementLinkTemporaryValue(shell, elementLink, value, assignment.append)
    : combineTemporaryValue(shell, targetName, value, assignment.append);
  scope.set(targetName, {
    name: targetName,
    value: { kind: 'scalar', value: combined },
    attributes: new Set(['x']),
    fromTempEnv: true,
  });
}

function resolveTemporaryTarget(
  shell: Shell,
  name: string
): { targetName: string; elementLink?: Variable } | undefined {
  const seen = new Set<Variable>();
  let current = name;
  for (;;) {
    const variable = shell.findOwnVariable(current);
    if (!variable?.attributes.has('n') || variable.value?.kind !== 'scalar' || variable.value.value === '') {
      return { targetName: current };
    }
    if (seen.has(variable)) {
      shell.reportError(`warning: ${variable.name}: circular name reference`);
      return undefined;
    }
    seen.add(variable);
    const next = variable.value.value;
    if (!isIdentifier(next)) return { targetName: variable.name, elementLink: variable };
    current = next;
  }
}

function combineElementLinkTemporaryValue(shell: Shell, link: Variable, value: string, append: boolean): string {
  if (!append) return value;
  const base = link.value?.kind === 'scalar' ? link.value.value : '';
  const raw = link.attributes.has('i')
    ? String(BigInt.asIntN(64, shell.evaluateFatalReadonly(base || '0') + shell.evaluateFatalReadonly(value)))
    : base + value;
  return applyCaseAttributes(link, raw);
}

function combineTemporaryValue(shell: Shell, name: string, value: string, append: boolean): string {
  if (!append) return value;
  const base = shell.scalarValue(name) ?? '';
  const variable = shell.findVariable(name);
  const raw = variable?.attributes.has('i')
    ? String(BigInt.asIntN(64, shell.evaluateFatalReadonly(base || '0') + shell.evaluateFatalReadonly(value)))
    : base + value;
  return variable ? applyCaseAttributes(variable, raw) : raw;
}
