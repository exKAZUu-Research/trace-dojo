import { skipSubscript } from './arithmetic';
import type { Assignment, Word } from './ast';
import type { DeclarationArgument } from './declare';
import type { CompoundElement, Shell } from './shell';
import { AssociativeTable, type Variable } from './variables';

// code-gauge-allow functionParameterCount -- Needs shell, builtin, declared/store variables, raw/parsed operand, nameref subscript, and +n flag.
export function assignDeclaredOperand(
  shell: Shell,
  builtin: string,
  variable: Variable,
  storeVariable: Variable,
  operand: DeclarationArgument,
  parsed: { subscript?: string; append: boolean; value?: string } | undefined,
  referencedSubscript?: string,
  bypassNamerefTarget = false
): boolean {
  const assignsNamerefTarget = variable.attributes.has('n') && !bypassNamerefTarget;
  if (parsed?.value !== undefined) {
    if (assignsNamerefTarget && parsed.subscript === undefined) {
      return assignReferenceTarget(shell, builtin, variable, parsed.value);
    }
    if (parsed.subscript !== undefined) {
      const sub = expandDeclaredSubscript(shell, storeVariable, parsed.subscript);
      return shell.assignElementTo(storeVariable, sub, parsed.value, parsed.append);
    }
    if (referencedSubscript !== undefined) {
      const sub = expandDeclaredSubscript(shell, storeVariable, referencedSubscript);
      return shell.assignElementTo(storeVariable, sub, parsed.value, parsed.append);
    }
    if (shell.isDynamic(storeVariable.name)) return shell.assignDynamic(storeVariable.name, parsed.value);
    return shell.assignScalarTo(storeVariable, parsed.value, parsed.append);
  }
  if (typeof operand === 'string') return true;
  return assignsNamerefTarget
    ? assignReference(shell, builtin, variable, operand)
    : assignLocally(shell, storeVariable, operand, referencedSubscript);
}

function assignReference(shell: Shell, builtin: string, variable: Variable, assignment: Assignment): boolean {
  if (assignment.value === undefined || assignment.array) return assignLocally(shell, variable, assignment);
  const target = shell.expander.withSpacedStar(() => shell.expander.expandAssignmentValue(assignment.value as Word));
  return assignReferenceTarget(shell, builtin, variable, target);
}

function assignReferenceTarget(shell: Shell, builtin: string, variable: Variable, target: string): boolean {
  if (!shell.isValidNamerefTarget(target)) {
    shell.reportError(`${builtin}: \`${target}': invalid variable name for name reference`);
    variable.attributes.delete('n');
    return false;
  }
  variable.value = { kind: 'scalar', value: target };
  variable.userAssigned = true;
  if (shell.hasNamerefCycle(variable)) {
    shell.reportError(`${builtin}: warning: ${variable.name}: circular name reference`);
  }
  return true;
}

export function assignLocally(
  shell: Shell,
  variable: Variable,
  assignment: Assignment & { expandedElements?: CompoundElement[] },
  referencedSubscript?: string
): boolean {
  if (!assignment.array && assignment.value === undefined && findOperandEquals(assignment.text) === -1) {
    ensureUninitializedArrayContainer(variable);
    return true;
  }
  const owner = shell.state.scopes.findLast((scope) => scope.get(variable.name) === variable);
  if (!owner) return assignLocallyUnowned(shell, variable, assignment, referencedSubscript);
  if (assignment.array) return assignLocallyCompound(shell, variable, assignment, referencedSubscript);
  const value = expandOptionalAssignmentWord(shell, assignment.value);
  if (assignment.subscript) {
    const subscript = variable.attributes.has('A')
      ? shell.expander.expandAssociativeKey(assignment.subscript)
      : shell.expander.expandSubscriptString(assignment.subscript);
    return shell.assignElementTo(variable, subscript, value, assignment.append);
  }
  if (referencedSubscript !== undefined) {
    return shell.assignElementTo(
      variable,
      expandDeclaredSubscript(shell, variable, referencedSubscript),
      value,
      assignment.append
    );
  }
  return shell.assignScalarTo(variable, value, assignment.append);
}

function ensureUninitializedArrayContainer(variable: Variable): void {
  if (variable.attributes.has('a') && !variable.value) variable.value = { kind: 'indexed', elements: new Map() };
  if (variable.attributes.has('A') && !variable.value) {
    variable.value = { kind: 'associative', table: new AssociativeTable() };
  }
}

function assignLocallyUnowned(
  shell: Shell,
  variable: Variable,
  assignment: Assignment,
  referencedSubscript: string | undefined
): boolean {
  if (
    !assignment.array &&
    !assignment.subscript &&
    referencedSubscript === undefined &&
    shell.isDynamic(variable.name)
  ) {
    return shell.assignDynamic(variable.name, expandOptionalAssignmentWord(shell, assignment.value));
  }
  return true;
}

function expandOptionalAssignmentWord(shell: Shell, word: Word | undefined): string {
  return word ? shell.expander.withSpacedStar(() => shell.expander.expandAssignmentValue(word)) : '';
}

function expandDeclaredSubscript(shell: Shell, variable: Variable, rawSubscript: string): string {
  const expanded = shell.expandDynamicSubscript(rawSubscript);
  const isAssoc = variable.value?.kind === 'associative' || variable.attributes.has('A');
  return expanded === '' && rawSubscript !== '' && !isAssoc ? '0' : expanded;
}

function assignLocallyCompound(
  shell: Shell,
  variable: Variable,
  assignment: Assignment & { expandedElements?: CompoundElement[]; committedCompound?: boolean },
  referencedSubscript?: string
): boolean {
  if (assignment.committedCompound) return true;
  if (assignment.subscript || referencedSubscript !== undefined) {
    const sub = assignment.subscript?.text ?? referencedSubscript ?? '';
    shell.reportError(`${variable.name}[${sub}]: cannot assign list to array member`);
    return false;
  }
  const { elements, error } = assignment.expandedElements
    ? shell.expander.validateCompoundItems(
        assignment.expandedElements,
        variable.attributes.has('A'),
        true,
        variable.name
      )
    : shell.expander.expandCompound(assignment.array as Word[], variable.attributes.has('A'), true, variable.name);
  if (variable.attributes.has('A') && !variable.value) {
    variable.value = { kind: 'associative', table: new AssociativeTable() };
  }
  const ok = shell.assignCompoundTo(variable, elements, assignment.append);
  if (error) shell.discard(error);
  return ok;
}

export function hasValue(operand: DeclarationArgument, parsed: { value?: string } | undefined): boolean {
  return typeof operand === 'string'
    ? parsed?.value !== undefined
    : operand.value !== undefined || operand.array !== undefined || findOperandEquals(operand.text) !== -1;
}

export function isCompound(operand: DeclarationArgument): boolean {
  return typeof operand !== 'string' && operand.array !== undefined;
}

export function findOperandEquals(word: string): number {
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '[') {
      const close = skipSubscript(word, i);
      if (close < word.length) i = close;
      continue;
    }
    if (word[i] === '=') return i;
  }
  return -1;
}
