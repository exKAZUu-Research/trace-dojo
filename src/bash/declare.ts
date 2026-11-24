// code-gauge-allow-file fileNcss -- Keeps Bash's declaration builtins (declare, typeset, local, readonly, export) and declare -p formatting together.
import type { Assignment, Word } from './ast';
import type { CompoundPrepareOptions } from './expansion';
import { ansicQuote, ansicShouldQuote, containsShellMetas, doubleQuote } from './quoting';
import type { CompoundElement, Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import {
  AssociativeTable,
  type Attribute,
  ATTRIBUTE_ORDER,
  cloneValue,
  compoundPrepareForVariable,
  CONVERTED_BUCKETS,
  findEnclosingVariable,
  isIdentifier,
  sortedElements,
  type Variable,
} from './variables';

/** An argument of a declaration builtin: an assignment the shell parsed, or a word it expanded. */
export type DeclarationArgument = string | (Assignment & { expandedElements?: CompoundElement[] });

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

/** Expands declaration command arguments left-to-right before prefix bindings and `runDeclaration` execute. */
export function expandDeclarationArguments(
  shell: Shell,
  builtin: string,
  rawArgs: (Word | Assignment)[]
): DeclarationArgument[] {
  const args: DeclarationArgument[] = [];
  const options: Options = { set: new Set(), unset: new Set() };
  let optionsDone = false;
  for (const arg of rawArgs) {
    if ('append' in arg) {
      optionsDone = true;
      args.push(expandDeclarationAssignment(shell, builtin, arg, options));
      continue;
    }
    const words = shell.expander.expandWords([arg]);
    for (const word of words) {
      if (!optionsDone) optionsDone = recordOptionWord(word, options);
      args.push(word);
    }
  }
  return args;
}

function recordOptionWord(word: string, options: Options): boolean {
  if (word === '--') return true;
  if (!/^[-+]./.test(word)) return true;
  const adding = word.startsWith('-') ? options.set : options.unset;
  const removing = word.startsWith('-') ? options.unset : options.set;
  for (const ch of word.slice(1)) {
    adding.add(ch);
    removing.delete(ch);
  }
  return false;
}

function expandDeclarationAssignment(
  shell: Shell,
  builtin: string,
  arg: Assignment,
  options: Options
): DeclarationArgument {
  const subscript = arg.subscript && literalWord(arg.subscript, shell.expander.expandAssociativeKey(arg.subscript));
  const value =
    arg.value &&
    literalWord(
      arg.value,
      shell.expander.withSpacedStar(() => shell.expander.expandAssignmentValue(arg.value as Word))
    );
  const expandedElements =
    arg.array &&
    shell.expander.expandCompoundItems(arg.array, buildCompoundPrepareOptions(shell, builtin, arg, options));
  return {
    ...arg,
    ...(subscript ? { subscript } : {}),
    ...(value ? { value } : {}),
    ...(expandedElements ? { expandedElements } : {}),
  };
}

function buildCompoundPrepareOptions(
  shell: Shell,
  builtin: string,
  arg: Assignment,
  { set, unset }: Options
): CompoundPrepareOptions {
  const isLocal =
    shell.isInFunction && !set.has('g') && (builtin === 'local' || builtin === 'declare' || builtin === 'typeset');
  const { scopes, functionScopes } = shell.state;
  const localScope = isLocal ? scopes[functionScopes.at(-1) as number] : undefined;
  const { targetName } = resolveDeclaredTarget(shell, arg.name, set, unset, false, set.has('g'), localScope);
  const existing = resolveCompoundExisting(shell, targetName, set, localScope);
  const isAssociative =
    set.has('A') ||
    (!set.has('a') && (existing?.value?.kind === 'associative' || Boolean(existing?.attributes.has('A'))));
  const isInteger = set.has('i') || (Boolean(existing?.attributes.has('i')) && !unset.has('i'));
  return compoundPrepareForVariable(targetName, existing, arg.append, isAssociative, isInteger);
}

function resolveCompoundExisting(
  shell: Shell,
  targetName: string,
  set: Set<string>,
  localScope: Map<string, Variable> | undefined
): Variable | undefined {
  const { scopes } = shell.state;
  if (localScope) {
    return (
      localScope.get(targetName) ?? (set.has('I') ? findEnclosingVariable(scopes, localScope, targetName) : undefined)
    );
  }
  return set.has('g') || set.has('n') ? scopes[0].get(targetName) : shell.findVariable(targetName, false);
}

function literalWord(origin: Word, text: string): Word {
  return { parts: [{ kind: 'single', text }], row: origin.row, text: origin.text };
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
    shell.isInFunction && !options.set.has('g') && (name === 'local' || name === 'declare' || name === 'typeset');
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
}

// code-gauge-allow functionCognitiveComplexity -- Bash's declaration of one operand: its name, a dynamic variable, its attributes, and its value.
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
  const assigns = hasValue(operand, parsed);
  const tempVar =
    !isLocal && !isSubscripted && (builtin === 'export' || builtin === 'readonly')
      ? shell.declarationPrefixVariable(name)
      : undefined;
  if (tempVar) return declarePrefixed(shell, builtin, name, tempVar, operand, parsed, options);
  const destination = declaredDestination(shell, builtin, name, options, isLocal, isSubscripted, assigns);
  if (
    !destination ||
    !applyAttributes(
      shell,
      builtin,
      destination.variable,
      options,
      assigns || isCompound(operand),
      isSubscripted || destination.referencedSubscript !== undefined
    )
  ) {
    return false;
  }
  const { variable, referencedSubscript } = destination;
  const storeVariable =
    options.set.has('g') && (isSubscripted || destination.referencedSubscript !== undefined)
      ? resolveElementStoreVariable(shell, name, variable.name, options.set, options.unset, isSubscripted)
      : variable;
  const ok = assignDeclaredOperand(shell, builtin, variable, storeVariable, operand, parsed, referencedSubscript);
  if (options.set.has('r')) variable.attributes.add('r');
  return ok;
}

// code-gauge-allow functionParameterCount -- Needs shell, builtin, declared/store variables, raw/parsed operand, and nameref subscript.
function assignDeclaredOperand(
  shell: Shell,
  builtin: string,
  variable: Variable,
  storeVariable: Variable,
  operand: DeclarationArgument,
  parsed: { subscript?: string; append: boolean; value?: string } | undefined,
  referencedSubscript?: string
): boolean {
  if (parsed?.value !== undefined) {
    if (variable.attributes.has('n') && parsed.subscript === undefined) {
      return assignReferenceTarget(shell, builtin, variable, parsed.value);
    }
    if (parsed.subscript !== undefined) {
      return shell.assignElementTo(storeVariable, parsed.subscript, parsed.value, parsed.append);
    }
    if (referencedSubscript !== undefined) {
      return shell.assignElementTo(storeVariable, referencedSubscript, parsed.value, parsed.append);
    }
    return shell.assignScalarTo(storeVariable, parsed.value, parsed.append);
  }
  if (typeof operand === 'string') return true;
  return variable.attributes.has('n')
    ? assignReference(shell, builtin, variable, operand)
    : assignLocally(shell, storeVariable, operand, referencedSubscript);
}

/**
 * Executes an `export` or `readonly` operand naming a prefix binding (`x=temp export ...`) immediately against both
 * the temporary prefix binding and the nearest enclosing variable cell, matching Bash 5.3's per-operand semantics.
 */
// code-gauge-allow functionParameterCount -- Needs shell, builtin, operand name, prefix cell, raw/parsed operand, and options.
function declarePrefixed(
  shell: Shell,
  builtin: string,
  name: string,
  tempVar: Variable,
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined,
  options: Options
): boolean {
  const assigns = hasValue(operand, parsed);
  let enclosing = shell.findEnclosingForPrefix(name);
  if (
    checkReadonlyConflict(shell, builtin, name, tempVar.attributes.has('r') ? tempVar : enclosing, options, assigns)
  ) {
    return false;
  }
  if (enclosing?.attributes.has('n')) {
    return applyPrefixedTempOnly(shell, builtin, tempVar, operand, parsed, options, assigns);
  }
  const ensureEnclosing = (): Variable => {
    if (!enclosing) {
      enclosing = { name, value: undefined, attributes: new Set() };
      shell.state.scopes[0].set(name, enclosing);
    }
    return enclosing;
  };
  if (!assignPrefixedOperand(shell, builtin, tempVar, ensureEnclosing, operand, parsed, options)) return false;
  return propagatePrefixedAttributes(shell, builtin, tempVar, ensureEnclosing, operand, options, assigns);
}

// code-gauge-allow functionParameterCount -- Carries shell, builtin, temporary cell, lazy enclosing cell, raw/parsed operand, and options.
function assignPrefixedOperand(
  shell: Shell,
  builtin: string,
  tempVar: Variable,
  ensureEnclosing: () => Variable,
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined,
  options: Options
): boolean {
  if (parsed?.value !== undefined) {
    if (!shell.assignScalarTo(ensureEnclosing(), parsed.value, parsed.append)) return false;
    tempVar.value = { kind: 'scalar', value: parsed.value };
    return true;
  }
  if (typeof operand === 'string') return true;
  if (operand.array) {
    const target = ensureEnclosing();
    return applyAttributes(shell, builtin, target, options, true, false) && assignLocally(shell, target, operand);
  }
  if (operand.value === undefined && !operand.text.includes('=')) return true;
  const rhs = operand.value
    ? shell.expander.withSpacedStar(() => shell.expander.expandAssignmentValue(operand.value as Word))
    : '';
  if (!shell.assignScalarTo(ensureEnclosing(), rhs, operand.append)) return false;
  tempVar.value = { kind: 'scalar', value: rhs };
  return true;
}

// code-gauge-allow functionParameterCount -- Carries shell, builtin, temporary cell, lazy enclosing cell, operand, options, and assigns flag.
function propagatePrefixedAttributes(
  shell: Shell,
  builtin: string,
  tempVar: Variable,
  ensureEnclosing: () => Variable,
  operand: DeclarationArgument,
  options: Options,
  assigns: boolean
): boolean {
  if (options.set.has('x')) tempVar.attributes.add('x');
  if (options.unset.has('x')) tempVar.attributes.delete('x');
  if (options.set.has('r')) tempVar.attributes.add('r');
  if (options.unset.has('x')) return true;
  const target = ensureEnclosing();
  if (!isCompound(operand) && !applyAttributes(shell, builtin, target, options, assigns, false)) return false;
  if (tempVar.value?.kind === 'scalar' && !shell.assignScalarTo(target, tempVar.value.value, false)) return false;
  for (const attr of tempVar.attributes) target.attributes.add(attr);
  return true;
}

// code-gauge-allow functionParameterCount -- Updates only the temporary prefix cell when an enclosing nameref must stay intact.
function applyPrefixedTempOnly(
  shell: Shell,
  builtin: string,
  tempVar: Variable,
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined,
  options: Options,
  assigns: boolean
): boolean {
  if (!applyAttributes(shell, builtin, tempVar, options, assigns || isCompound(operand), false)) return false;
  let ok = true;
  if (parsed?.value !== undefined) ok = shell.assignScalarTo(tempVar, parsed.value, parsed.append);
  else if (typeof operand !== 'string') ok = assignLocally(shell, tempVar, operand);
  if (options.set.has('r')) tempVar.attributes.add('r');
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
// code-gauge-allow functionParameterCount -- Needs shell, builtin, operand name, flags, scope mode, subscript presence, and whether a value is assigned.
function declaredDestination(
  shell: Shell,
  builtin: string,
  name: string,
  options: Options,
  isLocal: boolean,
  isSubscripted: boolean,
  assigns: boolean
): DeclarationDestination | undefined {
  const { set, unset } = options;
  const { scopes } = shell.state;
  const scope = isLocal ? scopes[shell.state.functionScopes.at(-1) as number] : undefined;
  const { targetName, referencedSubscript } = resolveDeclaredTarget(
    shell,
    name,
    set,
    unset,
    isSubscripted,
    set.has('g'),
    scope
  );
  const targetScope = scope && referencedSubscript === undefined ? scope : undefined;
  let variable = targetScope
    ? targetScope.get(targetName)
    : set.has('n') || set.has('g')
      ? scopes[0].get(targetName)
      : shell.findVariable(targetName, false);
  if (targetScope && !variable && isReadonlyGlobal(shell, targetName)) {
    // Bash refuses a local copy of a readonly global, though a caller's readonly local may be shadowed.
    shell.reportError(`${builtin}: ${targetName}: readonly variable`);
    return undefined;
  }
  const inherited =
    targetScope && !variable && set.has('I') ? findEnclosingVariable(scopes, targetScope, targetName) : undefined;
  if (checkReadonlyConflict(shell, builtin, targetName, variable ?? inherited, options, assigns)) return undefined;
  if (!variable) {
    variable = createDeclaredVariable(targetName, inherited);
    (targetScope ?? scopes[0]).set(targetName, variable);
  }
  return {
    variable,
    ...(referencedSubscript === undefined ? {} : { referencedSubscript }),
  };
}

function createDeclaredVariable(name: string, inherited: Variable | undefined): Variable {
  if (!inherited) return { name, value: undefined, attributes: new Set() };
  return {
    name,
    value: cloneValue(inherited.value),
    attributes: new Set([...inherited.attributes].filter((attr) => attr !== 'n')),
  };
}

function resolveElementStoreVariable(
  shell: Shell,
  name: string,
  targetName: string,
  set: Set<string>,
  unset: Set<string>,
  isSubscripted: boolean
): Variable {
  const storeName = isSubscripted ? resolveDeclaredTarget(shell, name, set, unset, true, false).targetName : targetName;
  let storeVariable = shell.findVariable(storeName, false);
  if (!storeVariable) {
    storeVariable = { name: storeName, value: undefined, attributes: new Set() };
    shell.state.scopes[0].set(storeName, storeVariable);
  }
  return storeVariable;
}

function checkReadonlyConflict(
  shell: Shell,
  builtin: string,
  targetName: string,
  variable: Variable | undefined,
  { set, unset }: Options,
  assigns: boolean
): boolean {
  if (!variable?.attributes.has('r')) return false;
  const adds = [...set].some((a) => a !== 'r' && a !== 'x' && a !== 'p' && a !== 'g' && a !== 'I');
  const removes = [...unset].some((a) => a === 'r' || (a !== 'x' && variable.attributes.has(a as Attribute)));
  if (!assigns && !adds && !removes) return false;
  shell.reportError(`${builtin}: ${targetName}: readonly variable`);
  return true;
}

// code-gauge-allow functionCognitiveComplexity -- Resolves -n/+n, -g, -I local inheritance, and chained nameref element targets.
// code-gauge-allow functionParameterCount -- Needs shell, operand name, set/unset flags, subscript flag, global-only flag, and optional local scope.
function resolveDeclaredTarget(
  shell: Shell,
  name: string,
  set: Set<string>,
  unset: Set<string>,
  isSubscripted: boolean,
  globalOnly = set.has('g'),
  localScope?: Map<string, Variable>
): { targetName: string; referencedSubscript?: string } {
  if (set.has('n') || unset.has('n') || (globalOnly && isSubscripted)) return { targetName: name };
  if (localScope && set.has('I') && !localScope.has(name)) return { targetName: name };
  let current = globalOnly ? shell.state.scopes[0].get(name) : shell.findOwnVariable(name);
  let target = name;
  for (let depth = 0; depth < 8; depth++) {
    if (!current?.attributes.has('n') || current.value?.kind !== 'scalar' || current.value.value === '') break;
    target = current.value.value;
    const split = shell.splitSubscript(target);
    if (split) {
      return { targetName: split.name, ...(isSubscripted ? {} : { referencedSubscript: split.subscript }) };
    }
    current = globalOnly ? shell.state.scopes[0].get(target) : shell.findOwnVariable(target);
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
  assigns: boolean,
  impliesIndexed: boolean
): boolean {
  const error = conversionError(variable, set, unset);
  if (error) {
    shell.reportError(`${builtin}: ${variable.name}: ${error}`);
    return false;
  }
  const becomesIndexed =
    set.has('a') ||
    (impliesIndexed && !set.has('A') && !variable.attributes.has('A') && variable.value?.kind !== 'associative');
  if ((set.has('A') || becomesIndexed) && variable.attributes.delete('n')) variable.value = undefined;
  for (const attribute of ['i', 'l', 'u', 'c', 'n', 'x', 't'] as Attribute[]) {
    if (set.has(attribute)) variable.attributes.add(attribute);
    if (unset.has(attribute)) variable.attributes.delete(attribute);
  }
  // The case attributes exclude each other.
  for (const [attribute, others] of CASE_ATTRIBUTES) {
    if (set.has(attribute)) for (const other of others) variable.attributes.delete(other);
  }
  applyArrayKindAttributes(shell, variable, set.has('A'), becomesIndexed, assigns);
  return true;
}

function applyArrayKindAttributes(
  shell: Shell,
  variable: Variable,
  becomesAssociative: boolean,
  becomesIndexed: boolean,
  assigns: boolean
): void {
  if (becomesAssociative) {
    variable.attributes.add('A');
    if (variable.value?.kind === 'scalar') {
      const table = new AssociativeTable(CONVERTED_BUCKETS);
      table.set('0', variable.value.value);
      variable.value = { kind: 'associative', table };
    }
    if (!variable.value && assigns) variable.value = { kind: 'associative', table: new AssociativeTable() };
  }
  if (becomesIndexed) {
    variable.attributes.add('a');
    if (variable.value?.kind === 'scalar') shell.indexedElements(variable);
    if (!variable.value && assigns) variable.value = { kind: 'indexed', elements: new Map() };
  }
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
  assignment: Assignment & { expandedElements?: CompoundElement[] },
  referencedSubscript?: string
): boolean {
  const { append } = assignment;
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
    const { elements, error } = assignment.expandedElements
      ? shell.expander.validateCompoundItems(assignment.expandedElements, variable.attributes.has('A'), true)
      : shell.expander.expandCompound(assignment.array, variable.attributes.has('A'), true);
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
