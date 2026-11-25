import type { Assignment } from './ast';
import type { Shell } from './shell';
import { applyCaseAttributes, isIdentifier, type Scope } from './variables';

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
  const targetName = shell.resolveNameOrUndefined(assignment.name);
  if (targetName === undefined) return;
  if (!isIdentifier(targetName)) {
    shell.reportError(`\`${targetName}': not a valid identifier`);
    return;
  }
  if (shell.findOwnVariable(targetName)?.attributes.has('r') || shell.isReadonlyDynamic(targetName)) {
    // Bash reports the assignment and runs the command without it.
    shell.reportError(`${targetName}: readonly variable`);
    return;
  }
  const combined = combineTemporaryValue(shell, targetName, value, assignment.append);
  scope.set(targetName, {
    name: targetName,
    value: { kind: 'scalar', value: combined },
    attributes: new Set(['x']),
    fromTempEnv: true,
  });
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
