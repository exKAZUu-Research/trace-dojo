import type { Assignment, Word } from './ast';
import { ansicQuote, ansicShouldQuote, containsShellMetas, doubleQuote } from './quoting';
import type { Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import {
  AssociativeTable,
  type Attribute,
  ATTRIBUTE_ORDER,
  CONVERTED_BUCKETS,
  isIdentifier,
  sortedElements,
  type Variable,
} from './variables';

/** An argument of a declaration builtin: an assignment the shell parsed, or a word it expanded. */
export type DeclarationArgument = string | Assignment;

const USAGES: Record<string, string> = {
  declare: 'declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]',
  typeset: 'typeset [-aAfFgiIlnrtux] name[=value] ... or typeset -p [-aAfFilnrtux] [name ...]',
  local: 'local [option] name[=value] ...',
  readonly: 'readonly [-aAf] [name[=value] ...] or readonly -p',
  export: 'export [-fn] [name[=value] ...] or export -p [-f]',
};

const OPTIONS: Record<string, string> = {
  declare: 'aAcfFgiIlnrtuxp',
  typeset: 'aAcfFgiIlnrtuxp',
  local: 'aAcfFgiIlnrtuxp',
  readonly: 'aAfp',
  export: 'fnp',
};

/** The options a declaration builtin got: the attributes it sets with `-` and removes with `+`. */
interface Options {
  set: Set<string>;
  unset: Set<string>;
}

/** `declare`, `typeset`, `local`, `readonly`, and `export`. */
export function runDeclaration(shell: Shell, name: string, args: DeclarationArgument[]): number {
  const parsed = parseOptions(shell, name, args);
  if (!parsed) return 2;
  const { options, operands } = parsed;
  if (name === 'local' && !shell.isInFunction) {
    shell.reportError('local: can only be used in a function');
    return 1;
  }
  if (options.set.has('f') || options.set.has('F') || options.unset.has('f')) {
    throw new UnsupportedFeatureError(`${name} -f（関数の一覧）`);
  }
  if (operands.length === 0) throw new UnsupportedFeatureError(`${name} の変数の一覧`);
  // `readonly -p` and `export -p` print only without names; with names, they set the attribute as without `-p`.
  if (options.set.has('p') && name !== 'readonly' && name !== 'export') return printDeclarations(shell, name, operands);
  const isLocal =
    name === 'local' || ((name === 'declare' || name === 'typeset') && shell.isInFunction && !options.set.has('g'));
  let status = 0;
  for (const operand of operands) {
    if (!declareOne(shell, name, operand, options, isLocal)) status = 1;
  }
  return status;
}

/** Reads the options before the operands, reporting an invalid one with the builtin's usage as Bash does. */
// code-gauge-allow functionCognitiveComplexity -- Bash's option parsing shared by the declaration builtins, with export -n's special case and declare's conflicting -a and -A.
function parseOptions(
  shell: Shell,
  name: string,
  args: DeclarationArgument[]
): { options: Options; operands: DeclarationArgument[] } | undefined {
  const options: Options = { set: new Set(), unset: new Set() };
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== 'string' || !/^[-+]./.test(arg)) break;
    if (arg === '--') {
      index++;
      break;
    }
    const target = arg.startsWith('-') ? options.set : options.unset;
    for (const option of arg.slice(1)) {
      if (!OPTIONS[name].includes(option)) {
        shell.reportError(`${name}: ${arg[0]}${option}: invalid option`);
        shell.state.fd2.write(`${name}: usage: ${USAGES[name]}\n`);
        return undefined;
      }
      target.add(option);
    }
  }
  if (options.set.has('A') && options.set.has('a')) {
    shell.reportError(`${name}: -a: invalid option`);
    return undefined;
  }
  if (name === 'readonly') options.set.add('r');
  if (name === 'export') {
    // `export -n` removes the export attribute instead of setting a name reference.
    if (options.set.delete('n')) options.unset.add('x');
    else options.set.add('x');
  }
  return { options, operands: args.slice(index) };
}

/** Splits a word like `x=1`, `a[2]+=x`, or `y` that a declaration builtin got from an expansion. */
function parseWordOperand(word: string): { name: string; subscript?: string; append: boolean; value?: string } {
  const match = /^([^=[]+)(\[[^\]]*\])?(\+?=)([\s\S]*)$/.exec(word);
  if (!match) return { name: word, append: false };
  const [, name, subscript, operator, value] = match;
  return {
    name,
    ...(subscript ? { subscript: subscript.slice(1, -1) } : {}),
    append: operator === '+=',
    value,
  };
}

interface DeclarationDestination {
  variable: Variable;
  referencedSubscript?: string;
  promoted?: boolean;
}

// code-gauge-allow functionCognitiveComplexity -- Bash's declaration of one operand: its name, a dynamic variable, its attributes, and its value.
// code-gauge-allow functionNcss -- Validates, resolves destination, applies attributes, and assigns scalar/element/reference values.
function declareOne(
  shell: Shell,
  builtin: string,
  operand: DeclarationArgument,
  options: Options,
  isLocal: boolean
): boolean {
  const parsed = typeof operand === 'string' ? parseWordOperand(operand) : undefined;
  const name = typeof operand === 'string' ? (parsed as { name: string }).name : operand.name;
  if (!isIdentifier(name)) {
    shell.reportError(`${builtin}: \`${typeof operand === 'string' ? operand : operand.text}': not a valid identifier`);
    return false;
  }
  if (!isLocal && shell.isDynamic(name)) return declareDynamic(shell, operand, parsed);
  const isSubscripted =
    parsed?.subscript !== undefined || (typeof operand !== 'string' && operand.subscript !== undefined);
  const destination = declaredDestination(
    shell,
    builtin,
    name,
    options,
    isLocal,
    isSubscripted,
    hasValue(operand, parsed)
  );
  if (
    !destination ||
    !applyAttributes(shell, builtin, destination.variable, options, hasValue(operand, parsed) || isCompound(operand))
  ) {
    return false;
  }
  const { variable, referencedSubscript, promoted } = destination;
  let ok = true;
  if (parsed?.value !== undefined) {
    const append = promoted ? false : parsed.append;
    if (variable.attributes.has('n') && parsed.subscript === undefined) {
      ok = assignReferenceTarget(shell, builtin, variable, parsed.value);
    } else if (parsed.subscript !== undefined) {
      ok = shell.assignElementTo(variable, parsed.subscript, parsed.value, parsed.append);
    } else if (referencedSubscript !== undefined) {
      ok = shell.assignElementTo(variable, referencedSubscript, parsed.value, append);
    } else {
      ok = shell.assignScalarTo(variable, parsed.value, append);
    }
  } else if (typeof operand !== 'string') {
    ok = variable.attributes.has('n')
      ? assignReference(shell, builtin, variable, operand)
      : assignLocally(shell, variable, operand, referencedSubscript, promoted);
  }
  if (options.set.has('r')) variable.attributes.add('r');
  return ok;
}

/** A global declaration of a dynamic variable, which assigns it as an assignment word does and keeps it dynamic. */
function declareDynamic(
  shell: Shell,
  operand: DeclarationArgument,
  parsed: { name: string; value?: string } | undefined
): boolean {
  const name = typeof operand === 'string' ? (parsed as { name: string }).name : operand.name;
  const value =
    typeof operand === 'string' ? parsed?.value : operand.value && shell.expander.expandAssignmentValue(operand.value);
  if (value !== undefined) shell.assignDynamic(name, value);
  return true;
}

/** Resolves the target variable and any nameref element subscript for a declaration operand. */
// code-gauge-allow functionCognitiveComplexity -- Handles local vs global (-g), nameref chains (including element targets), prefix propagation, and readonly checks.
// code-gauge-allow functionParameterCount -- Needs shell, builtin, operand name, flags, scope mode, subscript presence, and whether a value is assigned.
function declaredDestination(
  shell: Shell,
  builtin: string,
  name: string,
  { set, unset }: Options,
  isLocal: boolean,
  isSubscripted: boolean,
  assigns: boolean
): DeclarationDestination | undefined {
  const { scopes } = shell.state;
  const scope = isLocal ? scopes[shell.state.functionScopes.at(-1) as number] : undefined;
  const directPrefix =
    !scope && !isSubscripted && (builtin === 'export' || builtin === 'readonly')
      ? shell.selectCommandPrefix(name, assigns, unset.has('x'))
      : undefined;
  if (directPrefix) {
    if (checkReadonlyConflict(shell, builtin, name, directPrefix, set, assigns)) return undefined;
    return { variable: directPrefix, promoted: true };
  }
  const { targetName, referencedSubscript } = resolveDeclaredTarget(shell, name, set, unset, isSubscripted);
  const targetScope = scope && referencedSubscript === undefined ? scope : undefined;
  let variable = targetScope
    ? targetScope.get(targetName)
    : set.has('n') || (set.has('g') && !isSubscripted && targetName === name)
      ? scopes[0].get(targetName)
      : shell.findVariable(targetName, false);
  if (targetScope && !variable && isReadonlyGlobal(shell, targetName)) {
    // Bash refuses a local copy of a readonly global, though a caller's readonly local may be shadowed.
    shell.reportError(`${builtin}: ${targetName}: readonly variable`);
    return undefined;
  }
  if (checkReadonlyConflict(shell, builtin, targetName, variable, set, assigns)) return undefined;
  if (!variable) {
    variable = { name: targetName, value: undefined, attributes: new Set() };
    (targetScope ?? scopes[0]).set(targetName, variable);
  }
  return { variable, ...(referencedSubscript === undefined ? {} : { referencedSubscript }) };
}

function checkReadonlyConflict(
  shell: Shell,
  builtin: string,
  targetName: string,
  variable: Variable | undefined,
  set: Set<string>,
  assigns: boolean
): boolean {
  const changes = assigns || [...set].some((a) => a !== 'r' && a !== 'x' && a !== 'p' && a !== 'g');
  if (!variable?.attributes.has('r') || !changes) return false;
  shell.reportError(`${builtin}: ${targetName}: readonly variable`);
  return true;
}

function resolveDeclaredTarget(
  shell: Shell,
  name: string,
  set: Set<string>,
  unset: Set<string>,
  isSubscripted: boolean
): { targetName: string; referencedSubscript?: string } {
  if (set.has('n') || unset.has('n')) return { targetName: name };
  let current = set.has('g') && !isSubscripted ? shell.state.scopes[0].get(name) : shell.findOwnVariable(name);
  let target = name;
  for (let depth = 0; depth < 8; depth++) {
    if (!current?.attributes.has('n') || current.value?.kind !== 'scalar' || current.value.value === '') break;
    target = current.value.value;
    const split = shell.splitSubscript(target);
    if (split) {
      return { targetName: split.name, ...(isSubscripted ? {} : { referencedSubscript: split.subscript }) };
    }
    current = shell.findOwnVariable(target);
  }
  return { targetName: target };
}

function isReadonlyGlobal(shell: Shell, name: string): boolean {
  const variable = shell.findVariable(name, false);
  return variable?.attributes.has('r') === true && shell.state.scopes[0].get(name) === variable;
}

/** Sets and removes a declaration's attributes, converting the value as Bash does, or reports why it cannot. */
// code-gauge-allow functionCognitiveComplexity -- Bash's attribute rules for declare: conversions, exclusive case attributes, and array kinds.
function applyAttributes(
  shell: Shell,
  builtin: string,
  variable: Variable,
  { set, unset }: Options,
  assigns: boolean
): boolean {
  const error = conversionError(variable, set, unset);
  if (error) {
    shell.reportError(`${builtin}: ${variable.name}: ${error}`);
    return false;
  }
  for (const attribute of ['i', 'l', 'u', 'c', 'n', 'x', 't'] as Attribute[]) {
    if (set.has(attribute)) variable.attributes.add(attribute);
    if (unset.has(attribute)) variable.attributes.delete(attribute);
  }
  // The case attributes exclude each other.
  for (const [attribute, others] of CASE_ATTRIBUTES) {
    if (set.has(attribute)) for (const other of others) variable.attributes.delete(other);
  }
  if (set.has('A')) {
    variable.attributes.add('A');
    if (variable.value?.kind === 'scalar') {
      const table = new AssociativeTable(CONVERTED_BUCKETS);
      table.set('0', variable.value.value);
      variable.value = { kind: 'associative', table };
    }
    if (!variable.value && assigns) variable.value = { kind: 'associative', table: new AssociativeTable() };
  }
  if (set.has('a')) {
    variable.attributes.add('a');
    if (variable.value?.kind === 'scalar') shell.indexedElements(variable);
  }
  return true;
}

const CASE_ATTRIBUTES: [Attribute, Attribute[]][] = [
  ['u', ['l', 'c']],
  ['l', ['u', 'c']],
  ['c', ['u', 'l']],
];

function conversionError(variable: Variable, set: Set<string>, unset: Set<string>): string | undefined {
  if (set.has('A') && (variable.value?.kind === 'indexed' || variable.attributes.has('a'))) {
    return 'cannot convert indexed to associative array';
  }
  if (set.has('a') && (variable.value?.kind === 'associative' || variable.attributes.has('A'))) {
    return 'cannot convert associative to indexed array';
  }
  if (unset.has('a') && variable.value?.kind === 'indexed') return 'cannot destroy array variables in this way';
  return undefined;
}

/** `declare -n ref=name`, which stores the name a reference refers to, after checking that it can name a variable. */
function assignReference(shell: Shell, builtin: string, variable: Variable, assignment: Assignment): boolean {
  if (assignment.value === undefined || assignment.array) return assignLocally(shell, variable, assignment);
  const target = shell.expander.withSpacedStar(() => shell.expander.expandAssignmentValue(assignment.value as Word));
  return assignReferenceTarget(shell, builtin, variable, target);
}

function assignReferenceTarget(shell: Shell, builtin: string, variable: Variable, target: string): boolean {
  if (target !== '' && !isIdentifier(target) && !shell.splitSubscript(target)) {
    shell.reportError(`${builtin}: \`${target}': invalid variable name for name reference`);
    variable.attributes.delete('n');
    return false;
  }
  variable.value = { kind: 'scalar', value: target };
  return true;
}

function hasValue(operand: DeclarationArgument, parsed: { value?: string } | undefined): boolean {
  return typeof operand === 'string'
    ? parsed?.value !== undefined
    : operand.value !== undefined || operand.array !== undefined;
}

function isCompound(operand: DeclarationArgument): boolean {
  return typeof operand !== 'string' && operand.array !== undefined;
}

/** Assigns a declaration's value to the variable it declared, which may be a local shadowing a global or vice versa. */
// code-gauge-allow functionCognitiveComplexity -- Bash's assignment kinds for a declared variable: none, empty, compound, element, and scalar.
function assignLocally(
  shell: Shell,
  variable: Variable,
  assignment: Assignment,
  referencedSubscript?: string,
  promoted = false
): boolean {
  const append = promoted ? false : assignment.append;
  if (assignment.value === undefined && !assignment.array) {
    if (variable.attributes.has('a') && !variable.value) variable.value = { kind: 'indexed', elements: new Map() };
    if (variable.attributes.has('A') && !variable.value)
      variable.value = { kind: 'associative', table: new AssociativeTable() };
    // `declare x` and `local x` declare a variable with no value; `x=` gives it the empty one.
    if (assignment.text.includes('=')) {
      return referencedSubscript === undefined
        ? shell.assignScalarTo(variable, '', append)
        : shell.assignElementTo(variable, referencedSubscript, '', append);
    }
    return true;
  }
  const { scopes } = shell.state;
  const owner = scopes.findLast((scope) => scope.get(variable.name) === variable);
  if (!owner) return true;
  if (assignment.array) {
    const { elements, error } = shell.expander.expandCompound(assignment.array, variable.attributes.has('A'), true);
    if (variable.attributes.has('A') && !variable.value)
      variable.value = { kind: 'associative', table: new AssociativeTable() };
    const ok = shell.assignCompoundTo(variable, elements, assignment.append);
    if (error) shell.discard(error);
    return ok;
  }
  const value = shell.expander.withSpacedStar(() =>
    shell.expander.expandAssignmentValue(assignment.value as NonNullable<Assignment['value']>)
  );
  if (assignment.subscript) {
    const subscript = variable.attributes.has('A')
      ? shell.expander.expandAssociativeKey(assignment.subscript)
      : shell.expander.expandSubscriptString(assignment.subscript);
    return shell.assignElementTo(variable, subscript, value, assignment.append);
  }
  if (referencedSubscript !== undefined) {
    return shell.assignElementTo(variable, referencedSubscript, value, append);
  }
  return shell.assignScalarTo(variable, value, append);
}

/** `declare -p names`: each variable as a declaration that recreates it. */
function printDeclarations(shell: Shell, builtin: string, names: DeclarationArgument[]): number {
  let status = 0;
  for (const operand of names) {
    const name = typeof operand === 'string' ? operand : operand.name;
    const variable = declarationToShow(shell, builtin, name);
    if (!variable || variable.isSystem) {
      if (variable?.isSystem) throw new UnsupportedFeatureError(`シェルの変数の表示（${builtin} -p ${name}）`);
      shell.reportError(`${builtin}: ${name}: not found`);
      status = 1;
      continue;
    }
    shell.state.fd1.write(`${declarationText(variable)}\n`);
  }
  return status;
}

/** The variable `declare -p name` shows; `local -p` shows only the current function's own variables. */
function declarationToShow(shell: Shell, builtin: string, name: string): Variable | undefined {
  const found = shell.findVariable(name, false);
  if (builtin !== 'local') return found ?? shell.dynamicDeclaration(name);
  const { scopes, functionScopes } = shell.state;
  return scopes[functionScopes.at(-1) as number].get(name) === found ? found : undefined;
}

export function declarationText(variable: Variable): string {
  const flags = ATTRIBUTE_ORDER.filter((attribute) => variable.attributes.has(attribute)).join('');
  const prefix = `declare -${flags || '-'} ${variable.name}`;
  const { value } = variable;
  if (!value) return prefix;
  if (value.kind === 'scalar') return `${prefix}=${quoteValue(value.value)}`;
  if (value.kind === 'indexed') {
    const body = sortedElements(value.elements)
      .map(([index, element]) => `[${index}]=${quoteValue(element)}`)
      .join(' ');
    return `${prefix}=(${body})`;
  }
  const body = value.table
    .entries()
    .map(([key, element]) => `[${quoteKey(key)}]=${quoteValue(element)} `)
    .join('');
  return `${prefix}=(${body})`;
}

function quoteValue(text: string): string {
  return ansicShouldQuote(text) ? ansicQuote(text) : doubleQuote(text);
}

function quoteKey(key: string): string {
  if (ansicShouldQuote(key)) return ansicQuote(key);
  if (containsShellMetas(key) || key === '@' || key === '*') return doubleQuote(key);
  return key;
}
