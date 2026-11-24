// code-gauge-allow-file fileNcss -- Keeps Bash's declaration builtins (declare, typeset, local, readonly, export) and declare -p formatting together.
import { skipSubscript } from './arithmetic';
import type { Assignment, Word } from './ast';
import { expandBraces } from './braces';
import { ansicQuote, ansicShouldQuote, containsShellMetas, doubleQuote } from './quoting';
import { DiscardSignal } from './runtime';
import type { CompoundElement, Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import {
  AssociativeTable,
  type Attribute,
  ATTRIBUTE_ORDER,
  cloneValue,
  CONVERTED_BUCKETS,
  findEnclosingVariable,
  isIdentifier,
  sortedElements,
  type Variable,
  type VariableValue,
} from './variables';

/** An argument of a declaration builtin: an assignment the shell parsed, or a word it expanded. */
export type DeclarationArgument =
  | string
  | (Assignment & { expandedElements?: CompoundElement[]; committedCompound?: boolean });

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
  attemptedSet: Set<string>;
}

/** Expands declaration command arguments left-to-right before prefix bindings and `runDeclaration` execute. */
export function expandDeclarationArguments(
  shell: Shell,
  builtin: string,
  rawArgs: (Word | Assignment)[]
): DeclarationArgument[] {
  const args: DeclarationArgument[] = [];
  const options: Options = { set: new Set(), unset: new Set(), attemptedSet: new Set() };
  let optionsDone = false;
  for (const arg of rawArgs) {
    if ('append' in arg) {
      optionsDone = true;
      for (const braced of braceExpandDeclarationAssignment(shell, arg)) {
        args.push(expandDeclarationAssignment(shell, builtin, braced, options));
      }
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

function braceExpandDeclarationAssignment(shell: Shell, arg: Assignment): Assignment[] {
  if (arg.array) return [arg];
  const spend = (): void => shell.runtime.spend();
  const subPartsList = arg.subscript ? expandBraces(arg.subscript.parts, spend) : [undefined];
  const valPartsList = arg.value ? expandBraces(arg.value.parts, spend) : [undefined];
  const expanded: Assignment[] = [];
  for (const subParts of subPartsList) {
    for (const valParts of valPartsList) {
      expanded.push({
        ...arg,
        ...(subParts && arg.subscript ? { subscript: { ...arg.subscript, parts: subParts } } : {}),
        ...(valParts && arg.value ? { value: { ...arg.value, parts: valParts } } : {}),
      });
    }
  }
  return expanded;
}

const SIGN_INDEPENDENT_MODE_FLAGS = new Set(['I', 'p']);

function recordOptionWord(word: string, options: Options): boolean {
  if (word === '--' || !/^[-+]./.test(word)) return true;
  for (const ch of word.slice(1)) applyOptionSign(options, word[0] as '-' | '+', ch);
  return false;
}

function applyOptionSign(options: Options, sign: '-' | '+', ch: string): void {
  if (SIGN_INDEPENDENT_MODE_FLAGS.has(ch)) {
    options.set.add(ch);
    return;
  }
  if (sign === '+') {
    if (ch === 'g') return;
    options.unset.add(ch);
    options.set.delete(ch);
    return;
  }
  options.attemptedSet.add(ch);
  if (!options.unset.has(ch)) options.set.add(ch);
}

function expandDeclarationAssignment(
  shell: Shell,
  builtin: string,
  arg: Assignment,
  rawOptions: Options
): DeclarationArgument {
  const options = isLocalDeclaration(shell, builtin, rawOptions)
    ? rawOptions
    : normalizeArrayNamerefPrecedence(rawOptions);
  const subscript = arg.subscript && literalWord(arg.subscript, shell.expander.expandAssociativeKey(arg.subscript));
  const value =
    arg.value &&
    literalWord(
      arg.value,
      shell.expander.withSpacedStar(() => shell.expander.expandAssignmentValue(arg.value as Word))
    );
  if (arg.array) {
    const rawItems = shell.expander.expandRawCompoundItems(arg.array, options.set.has('A') && !options.set.has('a'));
    const committedCompound = commitCompoundDeclaration(shell, builtin, arg, options, rawItems);
    return {
      ...arg,
      ...(subscript ? { subscript } : {}),
      ...(committedCompound ? { committedCompound: true } : { expandedElements: rawItems }),
    };
  }
  return {
    ...arg,
    ...(subscript ? { subscript } : {}),
    ...(value ? { value } : {}),
  };
}

function commitCompoundDeclaration(
  shell: Shell,
  builtin: string,
  arg: Assignment,
  options: Options,
  rawItems: CompoundElement[]
): boolean {
  const { set, unset } = options;
  if (!hasValidCompoundContext(shell, builtin, options)) return false;
  const { localScope, targetName, referencedSubscript } = resolveCompoundTargetContext(shell, builtin, arg, options);
  if (arg.subscript || referencedSubscript !== undefined) {
    const sub = arg.subscript?.text ?? referencedSubscript ?? '';
    shell.discard(`${arg.name}[${sub}]: cannot assign list to array member`);
  }
  if (localScope !== undefined && options.attemptedSet.has('n')) return false;
  if (!validateCompoundDeclarationTarget(shell, builtin, targetName, arg.append, set, unset, localScope)) return false;
  const variable = ensureCompoundTargetVariable(shell, targetName, set, localScope);
  applyAttributes(shell, builtin, variable, options, true, false);
  const { elements, error } = shell.expander.validateCompoundItems(
    rawItems,
    variable.attributes.has('A'),
    true,
    arg.name
  );
  const ok = shell.assignCompoundTo(variable, elements, arg.append, arg.name);
  if (error) shell.discard(error);
  if (!ok) throw new DiscardSignal();
  return true;
}

function resolveCompoundTargetContext(
  shell: Shell,
  builtin: string,
  arg: Assignment,
  { set, unset }: Options
): { localScope: Map<string, Variable> | undefined; targetName: string; referencedSubscript?: string } {
  const isLocal =
    shell.isInFunction && !set.has('g') && (builtin === 'local' || builtin === 'declare' || builtin === 'typeset');
  const { scopes, functionScopes } = shell.state;
  const localScope = isLocal ? scopes[functionScopes.at(-1) as number] : undefined;
  const { targetName, referencedSubscript } = resolveDeclaredTarget(
    shell,
    arg.name,
    set,
    unset,
    Boolean(arg.subscript),
    set.has('g'),
    localScope
  );
  return { localScope, targetName, ...(referencedSubscript === undefined ? {} : { referencedSubscript }) };
}

// code-gauge-allow functionParameterCount -- Checks host-env append, readonly boundary, array-kind clash, and conversion error for compound targets.
function validateCompoundDeclarationTarget(
  shell: Shell,
  builtin: string,
  targetName: string,
  append: boolean,
  set: Set<string>,
  unset: Set<string>,
  localScope: Map<string, Variable> | undefined
): boolean {
  const existing = resolveCompoundExisting(shell, targetName, set, localScope);
  if (!existing && !localScope && append && shell.isUnreadHostEnv(targetName)) {
    throw new UnsupportedFeatureError(`環境変数（${targetName}）`);
  }
  if (
    existing?.attributes.has('r') ||
    Boolean(localScope && !localScope.has(targetName) && isReadonlyGlobal(shell, targetName))
  ) {
    if (shell.isInFunction && builtin !== 'readonly' && builtin !== 'export') return false;
    shell.discard(`${targetName}: readonly variable`);
  }
  const kindErr = existing && incompatibleArrayKindError(existing, set);
  if (kindErr) shell.discard(`${targetName}: ${kindErr}`);
  if (set.has('n')) return false;
  return !(existing && conversionError(existing, set, unset));
}

function hasValidCompoundContext(shell: Shell, builtin: string, { set, unset }: Options): boolean {
  if (builtin === 'local' && !shell.isInFunction) return false;
  if (set.has('A') && set.has('a')) return false;
  const allowed = OPTIONS[builtin] ?? '';
  return [...set, ...unset].every((opt) => allowed.includes(opt) || (builtin === 'export' && opt === 'x'));
}

function ensureCompoundTargetVariable(
  shell: Shell,
  targetName: string,
  set: Set<string>,
  localScope: Map<string, Variable> | undefined
): Variable {
  const { scopes } = shell.state;
  let variable = localScope
    ? localScope.get(targetName)
    : set.has('n') || set.has('g')
      ? scopes[0].get(targetName)
      : shell.findVariable(targetName, false);
  if (!variable) {
    const origin = localScope ? resolveLocalOrigin(shell, localScope, targetName, set.has('I')) : undefined;
    variable = createDeclaredVariable(targetName, origin, set.has('A') ? 'associative' : 'indexed');
    (localScope ?? scopes[0]).set(targetName, variable);
  }
  return variable;
}

function resolveCompoundExisting(
  shell: Shell,
  targetName: string,
  set: Set<string>,
  localScope: Map<string, Variable> | undefined
): Variable | undefined {
  const { scopes } = shell.state;
  if (localScope) {
    const existing = localScope.get(targetName);
    if (existing) return existing;
    const origin = resolveLocalOrigin(shell, localScope, targetName, set.has('I'));
    return origin ? createDeclaredVariable(targetName, origin, set.has('A') ? 'associative' : 'indexed') : undefined;
  }
  return set.has('g') || set.has('n') ? scopes[0].get(targetName) : shell.findVariable(targetName, false);
}

function literalWord(origin: Word, text: string): Word {
  return { parts: [{ kind: 'single', text }], row: origin.row, text: origin.text };
}

/** Whether an executed declaration explicitly assigns a non-nameref value (`declare x=1`, `declare "x=3"`). */
export function declarationAssignsAnswer(builtin: string, args: readonly DeclarationArgument[]): boolean {
  const options: Options = { set: new Set(), unset: new Set(), attemptedSet: new Set() };
  let optionsDone = false;
  let hasAssignment = false;
  for (const arg of args) {
    if (typeof arg !== 'string') {
      optionsDone = true;
      hasAssignment = true;
      continue;
    }
    if (!optionsDone && !recordOptionWord(arg, options)) continue;
    optionsDone = true;
    hasAssignment ||= arg.includes('=');
  }
  const setsNameref = builtin !== 'export' && options.set.has('n') && !options.set.has('a') && !options.set.has('A');
  return hasAssignment && !setsNameref;
}

/** `declare`, `typeset`, `local`, `readonly`, and `export`. */
export function runDeclaration(
  shell: Shell,
  name: string,
  args: DeclarationArgument[],
  onMaterialize?: () => void
): number {
  const parsed = parseOptions(shell, name, args);
  if (!parsed) return 2;
  const { operands } = parsed;
  if (name === 'local' && !shell.isInFunction) {
    shell.reportError('local: can only be used in a function');
    return 1;
  }
  if (parsed.options.set.has('f') || parsed.options.set.has('F') || parsed.options.unset.has('f')) {
    throw new UnsupportedFeatureError(`${name} -f（関数の一覧）`);
  }
  if (operands.length === 0) throw new UnsupportedFeatureError(`${name} の変数の一覧`);
  // `readonly -p` and `export -p` print only without names; with names, they set the attribute as without `-p`.
  if (parsed.options.set.has('p') && name !== 'readonly' && name !== 'export') {
    return printDeclarations(shell, name, operands);
  }
  const isLocal = isLocalDeclaration(shell, name, parsed.options);
  const options = isLocal ? parsed.options : normalizeArrayNamerefPrecedence(parsed.options);
  let status = 0;
  for (const operand of operands) {
    if (!declareOne(shell, name, operand, options, isLocal, onMaterialize)) status = 1;
  }
  return status;
}

function isLocalDeclaration(shell: Shell, builtin: string, { set }: Options): boolean {
  return shell.isInFunction && !set.has('g') && (builtin === 'local' || builtin === 'declare' || builtin === 'typeset');
}

function normalizeArrayNamerefPrecedence(options: Options): Options {
  if (!options.set.has('n') || (!options.set.has('a') && !options.set.has('A'))) return options;
  const set = new Set(options.set);
  set.delete('n');
  return { ...options, set };
}

/** Reads the options before the operands, reporting an invalid one with the builtin's usage as Bash does. */
// code-gauge-allow functionCognitiveComplexity -- Bash's option parsing shared by the declaration builtins, with export -n's special case and declare's conflicting -a and -A.
function parseOptions(
  shell: Shell,
  name: string,
  args: DeclarationArgument[]
): { options: Options; operands: DeclarationArgument[] } | undefined {
  const options: Options = { set: new Set(), unset: new Set(), attemptedSet: new Set() };
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== 'string' || !/^[-+]./.test(arg)) break;
    if (arg === '--') {
      index++;
      break;
    }
    for (const option of arg.slice(1)) {
      if (!OPTIONS[name].includes(option)) {
        shell.reportError(`${name}: ${arg[0]}${option}: invalid option`);
        shell.state.fd2.write(`${name}: usage: ${USAGES[name]}\n`);
        return undefined;
      }
      applyOptionSign(options, arg[0] as '-' | '+', option);
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
  const eqIndex = findOperandEquals(word);
  if (eqIndex === -1) return { name: word, append: false };
  const append = eqIndex > 0 && word[eqIndex - 1] === '+';
  const lhsEnd = append ? eqIndex - 1 : eqIndex;
  const lhs = word.slice(0, lhsEnd);
  const value = word.slice(eqIndex + 1);
  const open = lhs.indexOf('[');
  if (open !== -1 && skipSubscript(lhs, open) === lhs.length - 1) {
    return { name: lhs.slice(0, open), subscript: lhs.slice(open + 1, -1), append, value };
  }
  return { name: lhs, append, value };
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
  isLocal: boolean,
  onMaterialize?: () => void
): boolean {
  const parsed = typeof operand === 'string' ? parseWordOperand(operand) : undefined;
  const name = typeof operand === 'string' ? (parsed as { name: string }).name : operand.name;
  if (rejectInvalidDeclarationName(shell, builtin, name, operand)) return false;
  if (!isLocal && shell.isDynamic(name)) return declareDynamic(shell, operand, parsed);
  const isSubscripted =
    parsed?.subscript !== undefined || (typeof operand !== 'string' && operand.subscript !== undefined);
  if (rejectSubscriptedAttributeBuiltin(shell, builtin, name, operand, parsed, isSubscripted)) return false;
  const assignMode = resolveAssignMode(operand, parsed);
  const tempVar =
    !isLocal && (builtin === 'export' || builtin === 'readonly') ? shell.declarationPrefixVariable(name) : undefined;
  if (tempVar) return declarePrefixed(shell, builtin, name, tempVar, operand, parsed, options);
  const explicitRefTarget = resolvePendingNamerefTarget(shell, name, operand, parsed, options, isLocal, isSubscripted);
  if (
    explicitRefTarget !== undefined &&
    !validatePendingNamerefTarget(shell, builtin, name, explicitRefTarget, shell.isInFunction)
  ) {
    return false;
  }
  const priorKind = shell.findVariable(name, !options.set.has('n') && !options.unset.has('n'))?.value?.kind;
  const destination = declaredDestination(
    shell,
    builtin,
    name,
    options,
    isLocal,
    isSubscripted,
    assignMode,
    isCompound(operand)
  );
  if (!destination) return false;
  if (
    !isSubscripted &&
    destination.referencedSubscript !== undefined &&
    (builtin === 'readonly' || builtin === 'export')
  ) {
    return finishElementAliasAttributeBuiltin(shell, builtin, destination, operand, parsed, assignMode);
  }
  const preUnsetStore = resolvePreUnsetNamerefStore(
    shell,
    destination.variable,
    options,
    isLocal,
    assignMode !== 'none'
  );
  if (
    !applyAttributes(
      shell,
      builtin,
      destination.variable,
      options,
      assignMode !== 'none' || isCompound(operand),
      isSubscripted || destination.referencedSubscript !== undefined,
      Boolean(preUnsetStore?.deferUnsetN),
      isCompound(operand)
    )
  ) {
    return false;
  }
  const ok =
    explicitRefTarget !== undefined
      ? commitNamerefTarget(shell, builtin, destination.variable, explicitRefTarget, shell.isInFunction)
      : storeSelectedDeclaration(
          shell,
          builtin,
          name,
          destination,
          preUnsetStore,
          options,
          operand,
          parsed,
          assignMode
        );
  finishDeclarationEffects(ok, destination.variable, preUnsetStore, options.set.has('r'), priorKind, onMaterialize);
  return ok;
}

// code-gauge-allow functionParameterCount -- Selects the effective store cell and writes the declared operand value.
function storeSelectedDeclaration(
  shell: Shell,
  builtin: string,
  name: string,
  destination: DeclarationDestination,
  preUnsetStore: DeclarationDestination | undefined,
  options: Options,
  operand: DeclarationArgument,
  parsed: { subscript?: string; append: boolean; value?: string } | undefined,
  assignMode: AssignMode
): boolean {
  const isSubscripted =
    parsed?.subscript !== undefined || (typeof operand !== 'string' && operand.subscript !== undefined);
  const selected = selectDeclarationStore(
    shell,
    name,
    destination,
    preUnsetStore,
    options,
    isSubscripted,
    assignMode !== 'none' && !isCompound(operand)
  );
  if (!selected) return false;
  return assignDeclaredOperand(
    shell,
    builtin,
    destination.variable,
    selected.storeVariable,
    operand,
    parsed,
    selected.effectiveSubscript,
    preUnsetStore !== undefined
  );
}

function rejectInvalidDeclarationName(
  shell: Shell,
  builtin: string,
  name: string,
  operand: DeclarationArgument
): boolean {
  if (isIdentifier(name)) return false;
  shell.reportError(`${builtin}: \`${typeof operand === 'string' ? operand : operand.text}': not a valid identifier`);
  return true;
}

function finishElementAliasAttributeBuiltin(
  shell: Shell,
  builtin: string,
  destination: DeclarationDestination,
  operand: DeclarationArgument,
  parsed: { subscript?: string; append: boolean; value?: string } | undefined,
  assignMode: AssignMode
): boolean {
  const ok =
    assignMode === 'none' ||
    assignDeclaredOperand(
      shell,
      builtin,
      destination.variable,
      destination.variable,
      operand,
      parsed,
      destination.referencedSubscript
    );
  if (!ok) return false;
  shell.reportError(
    `${builtin}: \`${destination.variable.name}[${destination.referencedSubscript}]': not a valid identifier`
  );
  return true;
}

function finishDeclarationEffects(
  ok: boolean,
  variable: Variable,
  preUnsetStore: PreUnsetNamerefStore | undefined,
  setsReadonly: boolean,
  priorKind: VariableValue['kind'] | undefined,
  onMaterialize: (() => void) | undefined
): void {
  if (ok && preUnsetStore?.deferUnsetN) preUnsetStore.finalLink.attributes.delete('n');
  if (setsReadonly) variable.attributes.add('r');
  notifyIfArrayMaterialized(ok, variable, priorKind, onMaterialize);
}

function rejectSubscriptedAttributeBuiltin(
  shell: Shell,
  builtin: string,
  name: string,
  operand: DeclarationArgument,
  parsed: { subscript?: string } | undefined,
  isSubscripted: boolean
): boolean {
  if (!isSubscripted || (builtin !== 'readonly' && builtin !== 'export')) return false;
  shell.reportError(`${builtin}: \`${name}[${operandSubscriptText(operand, parsed)}]': not a valid identifier`);
  return true;
}

// code-gauge-allow functionParameterCount -- Selects the destination or visible local element store for a declaration operand.
function selectDeclarationStore(
  shell: Shell,
  name: string,
  destination: DeclarationDestination,
  preUnsetStore: DeclarationDestination | undefined,
  { set, unset }: Options,
  isSubscripted: boolean,
  assignsNonCompound: boolean
): { storeVariable: Variable; effectiveSubscript: string | undefined } | undefined {
  const base = preUnsetStore ?? destination;
  const { variable, referencedSubscript } = base;
  const implicitIndexedZero =
    assignsNonCompound && !isSubscripted && referencedSubscript === undefined && isIndexedCell(variable);
  if (set.has('g') && implicitIndexedZero) {
    return resolveImplicitIndexedStore(shell, variable.name);
  }
  if (preUnsetStore) {
    return { storeVariable: variable, effectiveSubscript: referencedSubscript };
  }
  const storeVariable =
    set.has('g') && (isSubscripted || referencedSubscript !== undefined)
      ? resolveElementStoreVariable(shell, name, variable.name, set, unset, isSubscripted)
      : variable;
  return { storeVariable, effectiveSubscript: referencedSubscript };
}

function resolveImplicitIndexedStore(
  shell: Shell,
  baseName: string
): { storeVariable: Variable; effectiveSubscript: string } | undefined {
  const resolved = shell.resolveNameOrUndefined(baseName);
  if (resolved === undefined) return undefined;
  const direct = resolved.includes('[') ? shell.findOwnVariable(resolved) : undefined;
  if (!direct) {
    const split = shell.splitSubscript(resolved);
    if (split) {
      const arrName = shell.resolveNameOrUndefined(split.name);
      if (arrName === undefined) return undefined;
      return { storeVariable: ensureStoreVariable(shell, arrName), effectiveSubscript: split.subscript };
    }
  }
  const storeVariable = direct ?? ensureStoreVariable(shell, resolved);
  materializeRedirectedIndexedCell(storeVariable);
  return { storeVariable, effectiveSubscript: '0' };
}

function materializeRedirectedIndexedCell(variable: Variable): void {
  if (variable.attributes.has('r')) return;
  if (variable.value?.kind === 'associative' || variable.attributes.has('A')) {
    variable.attributes.delete('A');
    variable.attributes.add('a');
    variable.value = { kind: 'indexed', elements: new Map() };
  }
}

function isIndexedCell(variable: Variable): boolean {
  return !variable.attributes.has('n') && (variable.value?.kind === 'indexed' || variable.attributes.has('a'));
}

function notifyIfArrayMaterialized(
  ok: boolean,
  variable: Variable,
  priorKind: VariableValue['kind'] | undefined,
  onMaterialize: (() => void) | undefined
): void {
  if (
    ok &&
    !variable.attributes.has('n') &&
    variable.value !== undefined &&
    variable.value.kind !== 'scalar' &&
    priorKind !== variable.value.kind
  ) {
    onMaterialize?.();
  }
}

function operandSubscriptText(operand: DeclarationArgument, parsed: { subscript?: string } | undefined): string {
  if (typeof operand === 'string') return parsed?.subscript ?? '';
  const first = operand.subscript?.parts[0];
  return first?.kind === 'single' && operand.subscript?.parts.length === 1
    ? first.text
    : (operand.subscript?.text ?? '');
}

interface PreUnsetNamerefStore extends DeclarationDestination {
  finalLink: Variable;
  deferUnsetN: boolean;
}

function resolvePreUnsetNamerefStore(
  shell: Shell,
  finalLink: Variable | undefined,
  { set, unset }: Options,
  isLocal: boolean,
  assigns: boolean
): PreUnsetNamerefStore | undefined {
  if (isLocal || !assigns || !unset.has('n') || !finalLink?.attributes.has('n')) return undefined;
  const globalOnly = set.has('g');
  const { targetName, referencedSubscript } = resolveDeclaredTarget(
    shell,
    finalLink.name,
    new Set(),
    new Set(),
    false,
    globalOnly
  );
  if (targetName === finalLink.name && referencedSubscript === undefined) return undefined;
  let storeVariable = globalOnly ? shell.state.scopes[0].get(targetName) : shell.findVariable(targetName, false);
  if (!storeVariable) {
    storeVariable = { name: targetName, value: undefined, attributes: new Set() };
    shell.state.scopes[0].set(targetName, storeVariable);
  }
  return {
    variable: storeVariable,
    finalLink,
    deferUnsetN: referencedSubscript === undefined,
    ...(referencedSubscript === undefined ? {} : { referencedSubscript }),
  };
}

// code-gauge-allow functionParameterCount -- Inspects operand, parsed string form, options, scope mode, and subscript presence.
function resolvePendingNamerefTarget(
  shell: Shell,
  name: string,
  operand: DeclarationArgument,
  parsed: { subscript?: string; append: boolean; value?: string } | undefined,
  { set, unset }: Options,
  isLocal: boolean,
  isSubscripted: boolean
): string | undefined {
  if (isSubscripted || set.has('a') || set.has('A') || unset.has('n')) return undefined;
  const { scopes, functionScopes } = shell.state;
  const localScope = isLocal ? scopes[functionScopes.at(-1) as number] : undefined;
  const existing = findDeclarationExisting(shell, name, set.has('g'), localScope);
  if (existing && isArrayCell(existing)) return undefined;
  if (!set.has('n') && !(existing?.attributes.has('n') && existing.value === undefined)) return undefined;
  const pending = extractPendingNamerefValue(shell, operand, parsed);
  if (!pending) return undefined;
  if (!pending.append) return pending.value;
  const origin = !existing && localScope ? resolveLocalOrigin(shell, localScope, name, set.has('I')) : undefined;
  const baseSource = existing ?? origin?.source;
  const base = baseSource?.value?.kind === 'scalar' ? baseSource.value.value : '';
  return base + pending.value;
}

function findDeclarationExisting(
  shell: Shell,
  name: string,
  globalOnly: boolean,
  localScope: Map<string, Variable> | undefined
): Variable | undefined {
  if (localScope) return localScope.get(name);
  return globalOnly ? shell.state.scopes[0].get(name) : shell.findOwnVariable(name);
}

function extractPendingNamerefValue(
  shell: Shell,
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined
): { value: string; append: boolean } | undefined {
  if (typeof operand === 'string') {
    return parsed?.value === undefined ? undefined : { value: parsed.value, append: parsed.append };
  }
  if (operand.array) return undefined;
  if (operand.value !== undefined) {
    const value = shell.expander.withSpacedStar(() => shell.expander.expandAssignmentValue(operand.value as Word));
    return { value, append: operand.append };
  }
  return findOperandEquals(operand.text) !== -1 ? { value: '', append: operand.append } : undefined;
}

function validatePendingNamerefTarget(
  shell: Shell,
  builtin: string,
  name: string,
  target: string,
  inFunction: boolean
): boolean {
  if (!shell.isValidNamerefTarget(target)) {
    shell.reportError(`${builtin}: \`${target}': invalid variable name for name reference`);
    return false;
  }
  if (!inFunction && target === name) {
    shell.reportError(`${builtin}: ${name}: nameref variable self reference not allowed`);
    return false;
  }
  return true;
}

function commitNamerefTarget(
  shell: Shell,
  builtin: string,
  variable: Variable,
  target: string,
  isLocal: boolean
): boolean {
  variable.value = { kind: 'scalar', value: target };
  if ((isLocal && target === variable.name) || shell.hasNamerefCycle(variable)) {
    shell.reportError(`${builtin}: warning: ${variable.name}: circular name reference`);
  }
  return true;
}

// code-gauge-allow functionParameterCount -- Needs shell, builtin, declared/store variables, raw/parsed operand, nameref subscript, and +n flag.
function assignDeclaredOperand(
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
    return shell.assignScalarTo(storeVariable, parsed.value, parsed.append);
  }
  if (typeof operand === 'string') return true;
  return assignsNamerefTarget
    ? assignReference(shell, builtin, variable, operand)
    : assignLocally(shell, storeVariable, operand, referencedSubscript);
}

function expandDeclaredSubscript(shell: Shell, variable: Variable, rawSubscript: string): string {
  const expanded = shell.expandDynamicSubscript(rawSubscript);
  const isAssoc = variable.value?.kind === 'associative' || variable.attributes.has('A');
  return expanded === '' && rawSubscript !== '' && !isAssoc ? '0' : expanded;
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
  if (operand.value === undefined && findOperandEquals(operand.text) === -1) return true;
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

type AssignMode = 'none' | 'replace' | 'append';

function resolveAssignMode(
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined
): AssignMode {
  if (!hasValue(operand, parsed)) return 'none';
  const append = typeof operand === 'string' ? Boolean(parsed?.append) : operand.append;
  return append ? 'append' : 'replace';
}

/** Resolves the target variable and any nameref element subscript for a declaration operand. */
// code-gauge-allow functionParameterCount -- Needs shell, builtin, operand name, flags, scope mode, subscript presence, assignment mode, and compound flag.
function declaredDestination(
  shell: Shell,
  builtin: string,
  name: string,
  options: Options,
  isLocal: boolean,
  isSubscripted: boolean,
  assignMode: AssignMode,
  assignsCompound = false
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
  const targetScope = referencedSubscript === undefined ? scope : undefined;
  const variable = lookupDeclaredVariable(shell, targetName, set, targetScope);
  if (rejectDeclaredTarget(shell, builtin, targetName, variable, targetScope, assignMode, isSubscripted)) {
    return undefined;
  }
  if (rejectLocalArrayNameref(shell, builtin, targetName, variable, targetScope, options)) {
    return undefined;
  }
  const candidate = variable ?? createNewDeclaredVariable(shell, targetName, set, isSubscripted, targetScope);
  if (!variable) {
    const newVarErr = conversionError(candidate, set, unset, isSubscripted || assignsCompound);
    if (newVarErr) {
      shell.reportError(`${builtin}: ${targetName}: ${newVarErr}`);
      return undefined;
    }
  }
  if (!variable && targetScope) targetScope.set(targetName, candidate);
  if (checkReadonlyConflict(shell, builtin, targetName, candidate, options, assignMode !== 'none')) {
    return undefined;
  }
  if (!variable && !targetScope) scopes[0].set(targetName, candidate);
  return {
    variable: candidate,
    ...(referencedSubscript === undefined ? {} : { referencedSubscript }),
  };
}

function rejectLocalArrayNameref(
  shell: Shell,
  builtin: string,
  targetName: string,
  variable: Variable | undefined,
  targetScope: Map<string, Variable> | undefined,
  options: Options
): boolean {
  const { set, attemptedSet } = options;
  if (!targetScope || !attemptedSet.has('n') || (!set.has('a') && !set.has('A'))) return false;
  if (!variable) {
    const kindAttr: Attribute = set.has('A') ? 'A' : 'a';
    targetScope.set(targetName, { name: targetName, value: undefined, attributes: new Set([kindAttr]) });
  } else if (checkReadonlyConflict(shell, builtin, targetName, variable, options, false)) {
    return true;
  } else {
    const kindErr = incompatibleArrayKindError(variable, set);
    if (kindErr) {
      shell.reportError(`${builtin}: ${targetName}: ${kindErr}`);
      return true;
    }
    applyArrayKindAttributes(shell, variable, set.has('A'), set.has('a'), false);
  }
  shell.reportError(`${builtin}: ${targetName}: reference variable cannot be an array`);
  return true;
}

// code-gauge-allow functionParameterCount -- Validates readonly global local-shadows and unread host variables.
function rejectDeclaredTarget(
  shell: Shell,
  builtin: string,
  targetName: string,
  variable: Variable | undefined,
  targetScope: Map<string, Variable> | undefined,
  assignMode: AssignMode,
  isSubscripted: boolean
): boolean {
  if (targetScope && !variable && isReadonlyGlobal(shell, targetName)) {
    // Bash refuses a local copy of a readonly global, though a caller's readonly local may be shadowed.
    shell.reportError(`${builtin}: ${targetName}: readonly variable`);
    return true;
  }
  if (!targetScope && !variable && shell.isUnreadHostEnv(targetName) && (assignMode !== 'replace' || isSubscripted)) {
    throw new UnsupportedFeatureError(`環境変数（${targetName}）`);
  }
  return false;
}

function lookupDeclaredVariable(
  shell: Shell,
  targetName: string,
  set: Set<string>,
  targetScope: Map<string, Variable> | undefined
): Variable | undefined {
  if (targetScope) return targetScope.get(targetName);
  return set.has('n') || set.has('g') ? shell.state.scopes[0].get(targetName) : shell.findVariable(targetName, false);
}

function createNewDeclaredVariable(
  shell: Shell,
  targetName: string,
  set: Set<string>,
  isSubscripted: boolean,
  targetScope: Map<string, Variable> | undefined
): Variable {
  const origin = targetScope ? resolveLocalOrigin(shell, targetScope, targetName, set.has('I')) : undefined;
  const arrayKind = set.has('A') ? 'associative' : set.has('a') || isSubscripted ? 'indexed' : undefined;
  return createDeclaredVariable(targetName, origin, arrayKind);
}

interface LocalOrigin {
  source: Variable;
  inheritAttributes: boolean;
  fromTempEnv: boolean;
}

function resolveLocalOrigin(
  shell: Shell,
  targetScope: Map<string, Variable>,
  name: string,
  inheritEnclosing: boolean
): LocalOrigin | undefined {
  const tempBinding = findCallPrefixBinding(shell, targetScope, name);
  if (tempBinding) return { source: tempBinding, inheritAttributes: inheritEnclosing, fromTempEnv: true };
  if (!inheritEnclosing) return undefined;
  const inherited = findEnclosingVariable(shell.state.scopes, targetScope, name);
  if (!inherited && shell.isUnreadHostEnv(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
  return inherited
    ? { source: inherited, inheritAttributes: true, fromTempEnv: Boolean(inherited.fromTempEnv) }
    : undefined;
}

function findCallPrefixBinding(shell: Shell, targetScope: Map<string, Variable>, name: string): Variable | undefined {
  const { scopes } = shell.state;
  for (let i = scopes.indexOf(targetScope) - 1; i >= 1; i--) {
    const found = scopes[i].get(name);
    if (found) return found.fromTempEnv ? found : undefined;
  }
  return undefined;
}

function createDeclaredVariable(
  name: string,
  origin: LocalOrigin | undefined,
  arrayKind?: 'indexed' | 'associative'
): Variable {
  if (!origin) return { name, value: undefined, attributes: new Set() };
  const { source, inheritAttributes, fromTempEnv } = origin;
  const attributes = inheritAttributes
    ? new Set([...source.attributes].filter((a) => a !== 'n'))
    : new Set<Attribute>(source.attributes.has('x') ? ['x'] : []);
  let value: Variable['value'];
  if (arrayKind !== undefined && (!inheritAttributes || !isArrayCell(source))) {
    attributes.add(arrayKind === 'associative' ? 'A' : 'a');
    value =
      arrayKind === 'associative'
        ? { kind: 'associative', table: new AssociativeTable() }
        : { kind: 'indexed', elements: new Map() };
  } else {
    value = cloneValue(source.value);
  }
  return {
    name,
    value,
    attributes,
    ...(fromTempEnv ? { fromTempEnv: true } : {}),
  };
}

function isArrayCell(variable: Variable): boolean {
  return (
    variable.value?.kind === 'indexed' ||
    variable.value?.kind === 'associative' ||
    variable.attributes.has('a') ||
    variable.attributes.has('A')
  );
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
  return ensureStoreVariable(shell, storeName);
}

function ensureStoreVariable(shell: Shell, storeName: string): Variable {
  let storeVariable = shell.findVariable(storeName, false);
  if (!storeVariable) {
    storeVariable = { name: storeName, value: undefined, attributes: new Set() };
    shell.state.scopes[0].set(storeName, storeVariable);
  }
  return storeVariable;
}

const PROTECTED_READONLY_UNSET = new Set(['r', 'i', 'a', 'A', 'l', 'u', 'c']);
const READONLY_SAFE_SET = new Set(['r', 'x', 't', 'p', 'g', 'I']);

function checkReadonlyConflict(
  shell: Shell,
  builtin: string,
  targetName: string,
  variable: Variable | undefined,
  { set, unset, attemptedSet }: Options,
  assigns: boolean
): boolean {
  if (!variable?.attributes.has('r')) return false;
  const adds = [...set, ...attemptedSet].some((a) => !READONLY_SAFE_SET.has(a));
  const removes = [...unset].some(
    (a) => PROTECTED_READONLY_UNSET.has(a) || (a === 'n' && variable.attributes.has('n'))
  );
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
  if (set.has('n') || (globalOnly && isSubscripted)) return { targetName: name };
  if (unset.has('n')) {
    if (localScope) return { targetName: resolveLocalElementNamerefTarget(shell, name) ?? name };
    const start = globalOnly ? shell.state.scopes[0].get(name) : shell.findOwnVariable(name);
    return { targetName: start?.attributes.has('n') ? findFinalNamerefLink(shell, start, globalOnly).name : name };
  }
  if (localScope && set.has('I') && !localScope.has(name)) return { targetName: name };
  let current = globalOnly ? shell.state.scopes[0].get(name) : shell.findOwnVariable(name);
  let target = name;
  for (let depth = 0; depth < 8; depth++) {
    if (!current?.attributes.has('n') || current.value?.kind !== 'scalar' || current.value.value === '') break;
    target = current.value.value;
    const direct = target.includes('[') ? shell.findOwnVariable(target) : undefined;
    if (direct) return { targetName: target };
    const split = shell.splitSubscript(target);
    if (split) {
      return { targetName: split.name, ...(isSubscripted ? {} : { referencedSubscript: split.subscript }) };
    }
    current = globalOnly ? shell.state.scopes[0].get(target) : shell.findOwnVariable(target);
  }
  return { targetName: target };
}

function resolveLocalElementNamerefTarget(shell: Shell, name: string): string | undefined {
  let current = shell.findOwnVariable(name);
  const seen = new Set<Variable>();
  while (current?.attributes.has('n') && current.value?.kind === 'scalar' && current.value.value !== '') {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const target = current.value.value;
    if (shell.splitSubscript(target)) return target;
    current = shell.findOwnVariable(target);
  }
  return undefined;
}

function findFinalNamerefLink(shell: Shell, start: Variable, globalOnly: boolean): Variable {
  const seen = new Set<Variable>([start]);
  let current = start;
  while (current.attributes.has('n') && current.value?.kind === 'scalar' && current.value.value !== '') {
    const target = current.value.value;
    if (shell.splitSubscript(target)) break;
    const next = globalOnly ? shell.state.scopes[0].get(target) : shell.findOwnVariable(target);
    if (!next?.attributes.has('n') || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

function isReadonlyGlobal(shell: Shell, name: string): boolean {
  const variable = shell.findVariable(name, false);
  return variable?.attributes.has('r') === true && shell.state.scopes[0].get(name) === variable;
}

/** Sets and removes a declaration's attributes, converting the value as Bash does, or reports why it cannot. */
// code-gauge-allow functionCognitiveComplexity -- Bash's attribute rules for declare: conversions, exclusive case attributes, and array kinds.
// code-gauge-allow functionParameterCount -- Carries shell, builtin, target variable, flags, assignment/subscript flags, and deferred +n mode.
function applyAttributes(
  shell: Shell,
  builtin: string,
  variable: Variable,
  { set, unset }: Options,
  assigns: boolean,
  impliesIndexed: boolean,
  deferUnsetN = false,
  assignsCompound = false
): boolean {
  const error = conversionError(variable, set, unset, impliesIndexed || assignsCompound);
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
    if (unset.has(attribute) && !(attribute === 'n' && deferUnsetN)) variable.attributes.delete(attribute);
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

function incompatibleArrayKindError(variable: Variable, set: Set<string>): string | undefined {
  if (set.has('A') && (variable.value?.kind === 'indexed' || variable.attributes.has('a'))) {
    return 'cannot convert indexed to associative array';
  }
  if (set.has('a') && (variable.value?.kind === 'associative' || variable.attributes.has('A'))) {
    return 'cannot convert associative to indexed array';
  }
  return undefined;
}

function conversionError(
  variable: Variable,
  set: Set<string>,
  unset: Set<string>,
  impliesArray = false
): string | undefined {
  const kindErr = incompatibleArrayKindError(variable, set);
  if (kindErr) return kindErr;
  if (set.has('n') && (isArrayCell(variable) || impliesArray)) {
    return 'reference variable cannot be an array';
  }
  if (unset.has('a') && variable.value?.kind === 'indexed') return 'cannot destroy array variables in this way';
  if (unset.has('A') && variable.value?.kind === 'associative') return 'cannot destroy array variables in this way';
  return undefined;
}

/** `declare -n ref=name`, which stores the name a reference refers to, after checking that it can name a variable. */
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
  if (shell.hasNamerefCycle(variable)) {
    shell.reportError(`${builtin}: warning: ${variable.name}: circular name reference`);
  }
  return true;
}

function hasValue(operand: DeclarationArgument, parsed: { value?: string } | undefined): boolean {
  return typeof operand === 'string'
    ? parsed?.value !== undefined
    : operand.value !== undefined || operand.array !== undefined || findOperandEquals(operand.text) !== -1;
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
    if (findOperandEquals(assignment.text) !== -1) {
      return referencedSubscript === undefined
        ? shell.assignScalarTo(variable, '', append)
        : shell.assignElementTo(variable, expandDeclaredSubscript(shell, variable, referencedSubscript), '', append);
    }
    return true;
  }
  const { scopes } = shell.state;
  const owner = scopes.findLast((scope) => scope.get(variable.name) === variable);
  if (!owner) return true;
  if (assignment.array) return assignLocallyCompound(shell, variable, assignment, referencedSubscript);
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
    return shell.assignElementTo(
      variable,
      expandDeclaredSubscript(shell, variable, referencedSubscript),
      value,
      append
    );
  }
  return shell.assignScalarTo(variable, value, append);
}

function findOperandEquals(word: string): number {
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
  if (variable.attributes.has('A') && !variable.value)
    variable.value = { kind: 'associative', table: new AssociativeTable() };
  const ok = shell.assignCompoundTo(variable, elements, assignment.append);
  if (error) shell.discard(error);
  return ok;
}

/** `declare -p names`: each variable as a declaration that recreates it. */
function printDeclarations(shell: Shell, builtin: string, names: DeclarationArgument[]): number {
  let status = 0;
  for (const operand of names) {
    const name = typeof operand === 'string' ? operand : operand.name;
    const variable = declarationToShow(shell, builtin, name);
    if (!variable) {
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
  if (builtin !== 'local') {
    if (!found && shell.isUnreadHostEnv(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
    return found ?? shell.dynamicDeclaration(name);
  }
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
