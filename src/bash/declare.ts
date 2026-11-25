// code-gauge-allow-file fileNcss -- Keeps static, dynamic, and shadowed declaration schedules plus shared compound commit in one cohesive module.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { skipSubscript } from './arithmetic';
import type { Assignment, Word } from './ast';
import { expandBraces } from './braces';
import {
  type Attribute,
  rejectSpecialVariableMutation,
  rejectUnsupportedDeclarationListing,
  rejectUnsupportedDeclarationOperand,
  rejectUnsupportedDeclarationOptions,
  rejectUnsupportedShadowedCompound,
} from './capabilities';
import { printDeclarations } from './declarePrint';
import type { FailureContext } from './failurePolicy';
import type { Shell } from './shell';
import { resolveTargetName } from './targets';
import {
  type CellHandle,
  type CompoundElement,
  type DestinationIntent,
  isIdentifier,
  pushCompoundElementRoots,
  type VariableView,
} from './variables';

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

const VALUE_ATTRIBUTES = new Set<string>(['a', 'A', 'i', 'x', 'r']);

interface ParsedOptions {
  readonly set: Set<string>;
  readonly unset: Set<string>;
  readonly hasPlusOption: boolean;
  readonly invalidOption?: string;
}

type PlannedOperand =
  | { readonly kind: 'word'; readonly text: string }
  | {
      readonly kind: 'assignment';
      readonly name: string;
      readonly subscript?: Word;
      readonly append: boolean;
      readonly value: string | undefined;
      readonly text: string;
    }
  | {
      readonly kind: 'completedCompound';
      readonly name: string;
      readonly cell: CellHandle;
      readonly materializedArray: boolean;
      readonly text: string;
    }
  | { readonly kind: 'failedCompound'; readonly name: string; readonly text: string }
  | { readonly kind: 'deferredCompound'; readonly name: string; readonly text: string };

interface DeclarationPlan {
  readonly builtin: string;
  readonly options: ParsedOptions;
  readonly operands: PlannedOperand[];
  readonly lastArgText: string;
}

export interface CompoundCommitRequest {
  readonly builtin?: string;
  readonly name: string;
  readonly subscript?: Word;
  readonly append: boolean;
  readonly words: Word[];
  readonly rawItems?: CompoundElement[];
  readonly intent: DestinationIntent;
  readonly set: ReadonlySet<string>;
  readonly context: 'scriptAssignment' | 'declarationCompoundPhase1' | 'declarationFunctionCompoundPhase1';
}

/** Runs a static `declaration_command` (`declare`, `typeset`, `local`, `readonly`, `export`) via the shared schedule. */
export function executeDeclarationCommand(
  shell: Shell,
  builtin: string,
  rawArgs: readonly (Word | Assignment)[],
  withRedirects: <T>(run: () => T) => T
): { status: number; assignsAnswer: boolean } {
  const roots: string[] = [];
  return shell.withValuesRoot(roots, () => {
    const plan = buildDeclarationPlan(shell, builtin, rawArgs, roots);
    let assignsAnswer = planAssignsAnswer(plan);
    const status = withRedirects(() => {
      const code = runDeclarationPlan(shell, plan, () => {
        assignsAnswer = true;
      });
      shell.store.lastArgument = plan.lastArgText;
      return code;
    });
    return { status, assignsAnswer };
  });
}

/** Runs a declaration builtin invoked through an expanded command word (`cmd=declare; $cmd x=1`). */
export function runDynamicDeclarationBuiltin(shell: Shell, builtin: string, args: readonly string[]): number {
  const options = createEmptyOptions();
  const operands: PlannedOperand[] = [];
  let optionsDone = false;
  for (const arg of args) {
    if (!optionsDone && arg === '--') {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && consumeOptionToken(builtin, arg, options)) continue;
    optionsDone = true;
    operands.push({ kind: 'word', text: arg });
  }
  applyBuiltinImpliedFlags(builtin, options);
  const plan: DeclarationPlan = {
    builtin,
    options,
    operands,
    lastArgText: args.at(-1) ?? builtin,
  };
  return runDeclarationPlan(shell, plan);
}

/** Expands a static declaration command's arguments when a shell function shadows the builtin name. */
export function expandShadowedDeclarationArgs(
  shell: Shell,
  builtin: string,
  rawArgs: readonly (Word | Assignment)[]
): string[] {
  const argv = [builtin];
  return shell.withValuesRoot(argv, () => {
    for (const arg of rawArgs) appendShadowedArg(shell, builtin, arg, argv);
    return argv;
  });
}

function appendShadowedArg(shell: Shell, builtin: string, arg: Word | Assignment, argv: string[]): void {
  if (!('append' in arg)) {
    for (const word of shell.expander.expandWords([arg])) pushShadowedArg(argv, word);
    return;
  }
  if (arg.array) rejectUnsupportedShadowedCompound(builtin);
  for (const braced of braceExpandAssignment(shell, arg)) {
    pushShadowedArg(argv, expandAssignmentOperand(shell, braced).text);
  }
}

function pushShadowedArg(argv: string[], value: string): void {
  argv.push(value);
  if (argv.length - 1 > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
}

/** Executes an ordinary `name=(...)` or `name+=(...)` compound assignment through the single compound schedule. */
export function executeCompoundAssignment(shell: Shell, assignment: Assignment, context: 'scriptAssignment'): boolean {
  const outcome = executeCompoundOperation(shell, {
    name: assignment.name,
    subscript: assignment.subscript,
    append: assignment.append,
    words: assignment.array as Word[],
    intent: 'visible',
    set: new Set(),
    context,
  });
  return outcome !== undefined;
}

// ---------------------------------------------------------------- shared compound expand-prepare-commit schedule

function executeCompoundOperation(
  shell: Shell,
  req: CompoundCommitRequest
): { cell: CellHandle; materializedArray: boolean } | undefined {
  if (req.subscript) {
    shell.failures.handleStoreFailure(req.context, {
      ok: false,
      reason: 'cannotAssign',
      message: `${req.name}[${req.subscript.text}]: cannot assign list to array member`,
    });
    return undefined;
  }
  const targetName = resolveCompoundTargetName(shell, req);
  if (targetName === undefined) return undefined;
  const priorView = priorDestinationView(shell, targetName, req.intent);
  if (req.builtin !== undefined) {
    rejectUnsupportedDeclarationOperand(req.builtin, req.name, req.set, {
      isSubscripted: false,
      isCompound: true,
      append: req.append,
      hasScalarValue: false,
      hasEnclosingTempBinding: shell.store.hasTemporaryBinding(req.name),
      isUnreadHostTarget: isUnreadHostAtIntent(shell, targetName, req.intent),
      existing: priorView,
    });
  } else if (priorView?.attributes.has('r')) {
    shell.failures.handleStoreFailure(req.context, {
      ok: false,
      reason: 'readonly',
      message: `${targetName}: readonly variable`,
    });
    return undefined;
  }
  const wasMaterialized = priorView?.kind === 'indexed' || priorView?.kind === 'associative';
  const existingIsAssoc = priorView?.kind === 'associative' || priorView?.attributes.has('A') === true;
  const isAssoc = req.set.has('A') || existingIsAssoc;
  if (req.builtin === undefined && req.append && existingIsAssoc && priorView?.handle) {
    const ok = streamAssociativeAppend(shell, priorView.handle, req.words, req.name, req.context);
    return ok ? { cell: priorView.handle, materializedArray: !wasMaterialized } : undefined;
  }
  return commitPreparedCompound(shell, req, targetName, isAssoc, wasMaterialized);
}

function resolveCompoundTargetName(shell: Shell, req: CompoundCommitRequest): string | undefined {
  const targetName = req.intent === 'visible' ? resolveTargetName(shell, req.name) : req.name;
  if (targetName === undefined) {
    if (req.builtin === undefined) {
      shell.failures.handleStoreFailure(req.context, { ok: false, reason: 'cannotAssign', message: '' });
    }
    return undefined;
  }
  rejectSpecialVariableMutation(targetName, false);
  if (!isIdentifier(targetName)) {
    shell.failures.handleStoreFailure(req.context, {
      ok: false,
      reason: 'invalidIdentifier',
      message: `\`${targetName}': not a valid identifier`,
    });
    return undefined;
  }
  const outerRo = req.intent === 'local' ? shell.store.outerReadonlyFailure(targetName) : undefined;
  if (outerRo) {
    shell.failures.handleStoreFailure(req.context, outerRo, req.builtin);
    return undefined;
  }
  return targetName;
}

function streamAssociativeAppend(
  shell: Shell,
  handle: CellHandle,
  words: Word[],
  reportedName: string,
  context: FailureContext
): boolean {
  const { outcome, syntaxError } = shell.store.writeAssociativeCompoundStream(
    handle,
    reportedName,
    (expr) => shell.evaluateFatalReadonly(expr, false),
    (commitPair) => shell.expander.expandAssociativeAppend(words, reportedName, commitPair)
  );
  if (syntaxError !== undefined) shell.discard(syntaxError);
  return outcome.ok ? true : shell.failures.handleStoreFailure(context, outcome);
}

function commitPreparedCompound(
  shell: Shell,
  req: CompoundCommitRequest,
  targetName: string,
  isAssoc: boolean,
  wasMaterialized: boolean
): { cell: CellHandle; materializedArray: boolean } | undefined {
  const roots: string[] = [];
  return shell.withValuesRoot(roots, () => {
    const isDeclaration = req.builtin !== undefined;
    const expanded = expandCompoundElements(shell, req, isAssoc, isDeclaration);
    pushCompoundElementRoots(roots, expanded.elements);
    const cell = prepareCompoundDestinationCell(shell, req, targetName, isAssoc, isDeclaration);
    if (!cell) return;
    const outcome = shell.store.writeCompound(cell, expanded.elements, {
      append: req.append,
      reportedName: req.name,
      evalIndex: (cellHandle, rawKey) => shell.evaluateCompoundIndex(cellHandle, rawKey),
      evalInt: (expr) => shell.evaluateFatalReadonly(expr, false),
      onItemError: (msg) => shell.reportError(msg),
    });
    if (expanded.error !== undefined) shell.discard(expanded.error);
    if (!outcome.ok) {
      shell.failures.handleStoreFailure(isDeclaration ? 'declarationCompoundPhase1' : req.context, outcome);
      return;
    }
    const finalKind = shell.store.viewOfHandle(cell).kind;
    return { cell, materializedArray: !wasMaterialized && (finalKind === 'indexed' || finalKind === 'associative') };
  });
}

function expandCompoundElements(
  shell: Shell,
  req: CompoundCommitRequest,
  isAssoc: boolean,
  isDeclaration: boolean
): { elements: CompoundElement[]; error?: string } {
  return req.rawItems
    ? shell.expander.validateCompoundItems(req.rawItems, isAssoc, true, req.name)
    : shell.expander.expandCompound(req.words, isAssoc, isDeclaration, req.name);
}

function prepareCompoundDestinationCell(
  shell: Shell,
  req: CompoundCommitRequest,
  targetName: string,
  isAssoc: boolean,
  isDeclaration: boolean
): CellHandle | undefined {
  const selected = shell.store.selectDestination(
    req.intent,
    targetName,
    isAssoc ? 'associative' : 'indexed',
    req.append
  );
  if (!isDeclaration) return selected.cell;
  const attrFailure = shell.store.applyAttributes(selected.cell, nonReadonlyValueAttributes(req.set), false);
  if (!attrFailure) return selected.cell;
  shell.failures.handleStoreFailure(req.context, attrFailure);
  return undefined;
}

// ---------------------------------------------------------------- Phase 1: plan construction & eager compound commit

interface PlanBuilderState {
  readonly options: { set: Set<string>; unset: Set<string>; hasPlusOption: boolean; invalidOption?: string };
  readonly operands: PlannedOperand[];
  readonly roots: string[];
  optionsDone: boolean;
  lastArgText: string;
}

function buildDeclarationPlan(
  shell: Shell,
  builtin: string,
  rawArgs: readonly (Word | Assignment)[],
  roots: string[]
): DeclarationPlan {
  const state: PlanBuilderState = {
    options: createEmptyOptions(),
    operands: [],
    roots,
    optionsDone: false,
    lastArgText: builtin,
  };
  for (const arg of rawArgs) {
    if ('append' in arg) {
      state.optionsDone = true;
      for (const braced of braceExpandAssignment(shell, arg)) {
        const planned = planAssignmentOperand(shell, builtin, braced, state);
        state.lastArgText = planned.text;
        pushPlannedOperand(state, planned);
      }
    } else {
      appendExpandedDeclareWords(shell, builtin, arg, state);
    }
  }
  applyBuiltinImpliedFlags(builtin, state.options);
  return { builtin, options: state.options, operands: state.operands, lastArgText: state.lastArgText };
}

function appendExpandedDeclareWords(shell: Shell, builtin: string, arg: Word, state: PlanBuilderState): void {
  for (const word of shell.expander.expandWords([arg])) {
    state.roots.push(word);
    state.lastArgText = word;
    if (!state.optionsDone && word === '--') {
      state.optionsDone = true;
      continue;
    }
    if (!state.optionsDone && consumeOptionToken(builtin, word, state.options)) continue;
    state.optionsDone = true;
    pushPlannedOperand(state, { kind: 'word', text: word });
  }
}

function pushPlannedOperand(state: PlanBuilderState, operand: PlannedOperand): void {
  state.operands.push(operand);
  if (state.operands.length > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
}

function createEmptyOptions(): {
  set: Set<string>;
  unset: Set<string>;
  hasPlusOption: boolean;
  invalidOption?: string;
} {
  return { set: new Set(), unset: new Set(), hasPlusOption: false };
}

function consumeOptionToken(
  builtin: string,
  token: string,
  options: { set: Set<string>; unset: Set<string>; hasPlusOption: boolean; invalidOption?: string }
): boolean {
  if (token === '--') return false;
  if (!/^[-+]./.test(token)) return false;
  const sign = token[0] as '-' | '+';
  if (sign === '+') options.hasPlusOption = true;
  for (const ch of token.slice(1)) {
    if (!OPTIONS[builtin].includes(ch)) {
      options.invalidOption ??= `${sign}${ch}`;
      return true;
    }
    if (ch === 'I' || ch === 'p') {
      options.set.add(ch);
      continue;
    }
    if (sign === '+') {
      options.unset.add(ch);
      options.set.delete(ch);
    } else if (!options.unset.has(ch)) {
      options.set.add(ch);
    }
  }
  return true;
}

function applyBuiltinImpliedFlags(builtin: string, options: { set: Set<string>; unset: Set<string> }): void {
  if (builtin === 'readonly') options.set.add('r');
  else if (builtin === 'export') {
    if (options.set.delete('n')) options.unset.add('x');
    else options.set.add('x');
  }
}

function snapshotEffectiveOptions(builtin: string, rawOptions: ParsedOptions): ParsedOptions {
  const copy = {
    set: new Set(rawOptions.set),
    unset: new Set(rawOptions.unset),
    hasPlusOption: rawOptions.hasPlusOption,
    ...(rawOptions.invalidOption ? { invalidOption: rawOptions.invalidOption } : {}),
  };
  applyBuiltinImpliedFlags(builtin, copy);
  return copy;
}

function* braceExpandAssignment(shell: Shell, arg: Assignment): Generator<Assignment> {
  if (arg.array) {
    yield arg;
    return;
  }
  const spend = (): void => shell.runtime.spend();
  const subPartsList = arg.subscript ? expandBraces(arg.subscript.parts, spend) : [undefined];
  const valPartsList = arg.value ? expandBraces(arg.value.parts, spend) : [undefined];
  for (const subParts of subPartsList) {
    for (const valParts of valPartsList) {
      spend();
      yield {
        ...arg,
        ...(subParts && arg.subscript ? { subscript: { ...arg.subscript, parts: subParts } } : {}),
        ...(valParts && arg.value ? { value: { ...arg.value, parts: valParts } } : {}),
      };
    }
  }
}

function planAssignmentOperand(
  shell: Shell,
  builtin: string,
  arg: Assignment,
  state: PlanBuilderState
): PlannedOperand {
  const effective = snapshotEffectiveOptions(builtin, state.options);
  if (arg.array) {
    const isAssocFlag = effective.set.has('A') && !effective.set.has('a');
    const rawItems = shell.expander.expandRawCompoundItems(arg.array, isAssocFlag);
    pushCompoundElementRoots(state.roots, rawItems);
    return commitPhase1Compound(shell, builtin, arg, effective, rawItems);
  }
  const { value, text } = expandAssignmentOperand(shell, arg);
  state.roots.push(value, text);
  return {
    kind: 'assignment',
    name: arg.name,
    ...(arg.subscript ? { subscript: arg.subscript } : {}),
    append: arg.append,
    value,
    text,
  };
}

function expandAssignmentOperand(shell: Shell, arg: Assignment): { value: string; text: string } {
  const lhs = arg.subscript ? `${arg.name}[${shell.expander.expandAssignmentSubscript(arg.subscript)}]` : arg.name;
  const value = arg.value ? shell.expander.expandAssignmentValue(arg.value, true) : '';
  const text = `${lhs}${arg.append ? '+=' : '='}${value}`;
  if (text.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  return { value, text };
}

function commitPhase1Compound(
  shell: Shell,
  builtin: string,
  arg: Assignment,
  effective: ParsedOptions,
  rawItems: CompoundElement[]
): PlannedOperand {
  if (
    effective.invalidOption ||
    (effective.set.has('A') && effective.set.has('a')) ||
    (builtin === 'local' && !shell.isInFunction)
  ) {
    return { kind: 'deferredCompound', name: arg.name, text: arg.name };
  }
  rejectUnsupportedDeclarationOptions(builtin, effective.set, effective.unset, effective.hasPlusOption);
  const intent = destinationIntentOf(shell, builtin, effective.set);
  if (arg.subscript) {
    rejectUnsupportedDeclarationOperand(builtin, arg.name, effective.set, {
      isSubscripted: true,
      isCompound: true,
      append: arg.append,
      hasScalarValue: false,
      hasEnclosingTempBinding: shell.store.hasTemporaryBinding(arg.name),
      isUnreadHostTarget: isUnreadHostAtIntent(shell, arg.name, intent),
    });
  }
  const failCtx =
    shell.isInFunction && builtin !== 'readonly' && builtin !== 'export'
      ? 'declarationFunctionCompoundPhase1'
      : 'declarationCompoundPhase1';
  const committed = executeCompoundOperation(shell, {
    builtin,
    name: arg.name,
    subscript: arg.subscript,
    append: arg.append,
    words: arg.array as Word[],
    rawItems,
    intent,
    set: effective.set,
    context: failCtx,
  });
  if (!committed) return { kind: 'failedCompound', name: arg.name, text: arg.name };
  return {
    kind: 'completedCompound',
    name: arg.name,
    cell: committed.cell,
    materializedArray: committed.materializedArray,
    text: arg.name,
  };
}

// ---------------------------------------------------------------- Phase 2: plan validation & operand completion

function runDeclarationPlan(shell: Shell, plan: DeclarationPlan, onMaterialize?: () => void): number {
  const { builtin, options, operands } = plan;
  if (options.invalidOption !== undefined) {
    shell.reportError(`${builtin}: ${options.invalidOption}: invalid option`);
    shell.fd2.write(`${builtin}: usage: ${USAGES[builtin]}\n`);
    return 2;
  }
  if (options.set.has('A') && options.set.has('a')) {
    shell.reportError(`${builtin}: -a: invalid option`);
    return 2;
  }
  if (builtin === 'local' && !shell.isInFunction) {
    shell.reportError('local: can only be used in a function');
    return 1;
  }
  rejectUnsupportedDeclarationOptions(builtin, options.set, options.unset, options.hasPlusOption);
  if (operands.length === 0) rejectUnsupportedDeclarationListing(builtin);
  if (options.set.has('p') && builtin !== 'readonly' && builtin !== 'export') {
    return printDeclarations(
      shell,
      builtin,
      operands.map((op) => (op.kind === 'word' ? op.text : op.name))
    );
  }
  const intent = destinationIntentOf(shell, builtin, options.set);
  let status = 0;
  for (const operand of operands) {
    if (!executePlannedOperand(shell, builtin, operand, options.set, intent, onMaterialize)) status = 1;
  }
  return status;
}

function destinationIntentOf(shell: Shell, builtin: string, set: ReadonlySet<string>): DestinationIntent {
  if (shell.isInFunction && !set.has('g') && (builtin === 'local' || builtin === 'declare' || builtin === 'typeset')) {
    return 'local';
  }
  return set.has('g') ? 'global' : 'visible';
}

function executePlannedOperand(
  shell: Shell,
  builtin: string,
  operand: PlannedOperand,
  set: ReadonlySet<string>,
  intent: DestinationIntent,
  onMaterialize?: () => void
): boolean {
  if (operand.kind === 'failedCompound' || operand.kind === 'deferredCompound') return false;
  if (operand.kind === 'completedCompound') {
    if (operand.materializedArray) onMaterialize?.();
    if (set.has('r')) {
      const err = shell.store.applyAttributes(operand.cell, new Set<Attribute>(['r']), true);
      if (err) return shell.failures.handleStoreFailure('declarationOperand', err, builtin);
    }
    return true;
  }
  const normalized: NormalizedScalarOperand =
    operand.kind === 'word'
      ? parseWordOperand(operand.text)
      : {
          name: operand.name,
          isSubscripted: operand.subscript !== undefined,
          append: operand.append,
          value: operand.value,
          rawText: operand.text,
        };
  return executeScalarDeclarationOperand(shell, builtin, normalized, set, intent, onMaterialize);
}

interface NormalizedScalarOperand {
  readonly name: string;
  readonly isSubscripted: boolean;
  readonly append: boolean;
  readonly value: string | undefined;
  readonly rawText: string;
}

function executeScalarDeclarationOperand(
  shell: Shell,
  builtin: string,
  op: NormalizedScalarOperand,
  set: ReadonlySet<string>,
  intent: DestinationIntent,
  onMaterialize?: () => void
): boolean {
  if (!isIdentifier(op.name)) {
    return shell.failures.handleStoreFailure(
      'declarationOperand',
      { ok: false, reason: 'invalidIdentifier', message: `\`${op.rawText}': not a valid identifier` },
      builtin
    );
  }
  const effectiveSet = builtin === 'readonly' && op.value === undefined ? new Set<string>(['r']) : set;
  const existingOwn = priorDestinationView(shell, op.name, intent);
  rejectUnsupportedDeclarationOperand(builtin, op.name, effectiveSet, {
    isSubscripted: op.isSubscripted,
    isCompound: false,
    append: op.append,
    hasScalarValue: op.value !== undefined && !effectiveSet.has('n'),
    hasEnclosingTempBinding: shell.store.hasTemporaryBinding(op.name),
    isUnreadHostTarget: isUnreadHostAtIntent(shell, op.name, intent),
    existing: existingOwn,
  });
  const outerRo = intent === 'local' ? shell.store.outerReadonlyFailure(op.name) : undefined;
  if (outerRo) return shell.failures.handleStoreFailure('declarationOperand', outerRo, builtin);
  if (effectiveSet.has('n')) return bindPlannedNamerefOperand(shell, builtin, op.name, op.value, intent);
  return executeUnsubscriptedDeclaration(shell, builtin, op, effectiveSet, intent, onMaterialize);
}

function bindPlannedNamerefOperand(
  shell: Shell,
  builtin: string,
  name: string,
  value: string | undefined,
  intent: DestinationIntent
): boolean {
  const selected = shell.store.selectDestination(intent, name);
  const bound = shell.store.bindNameref(selected.cell, value, shell.isInFunction);
  if (!bound.ok) return shell.failures.handleStoreFailure('declarationOperand', bound, builtin);
  if (bound.cycleWarning) shell.reportError(bound.cycleWarning);
  return true;
}

function executeUnsubscriptedDeclaration(
  shell: Shell,
  builtin: string,
  op: NormalizedScalarOperand,
  effectiveSet: ReadonlySet<string>,
  intent: DestinationIntent,
  onMaterialize?: () => void
): boolean {
  const targetName = resolveUnsubscriptedDeclareTarget(shell, builtin, op.name, intent);
  if (targetName === undefined) return false;
  const priorView = priorDestinationView(shell, targetName, intent);
  if (targetName !== op.name) {
    rejectUnsupportedDeclarationOperand(builtin, targetName, effectiveSet, {
      isSubscripted: false,
      isCompound: false,
      append: op.append,
      hasScalarValue: op.value !== undefined,
      hasEnclosingTempBinding: shell.store.hasTemporaryBinding(targetName),
      isUnreadHostTarget: isUnreadHostAtIntent(shell, targetName, intent),
      existing: priorView,
    });
  }
  const wasMaterialized = priorView?.kind === 'indexed' || priorView?.kind === 'associative';
  const declaredArrayKind = effectiveSet.has('A') ? 'associative' : effectiveSet.has('a') ? 'indexed' : undefined;
  const selected = shell.store.selectDestination(intent, targetName, undefined, op.append, declaredArrayKind);
  if (!applyPreWriteAttributes(shell, builtin, selected.cell, effectiveSet, op.value === undefined)) return false;
  if (op.value !== undefined) {
    const outcome = shell.store.writeScalar(
      selected.cell,
      op.value,
      op.append,
      (expr) => shell.evaluateFatalReadonly(expr, false, builtin),
      targetName
    );
    if (!outcome.ok) return shell.failures.handleStoreFailure('declarationOperand', outcome, builtin);
  }
  return finalizeDeclaredCell(shell, builtin, selected.cell, effectiveSet, wasMaterialized, onMaterialize);
}

function resolveUnsubscriptedDeclareTarget(
  shell: Shell,
  builtin: string,
  rawName: string,
  intent: DestinationIntent
): string | undefined {
  if (intent !== 'visible') return rawName;
  const resolved = resolveTargetName(shell, rawName);
  if (resolved === undefined) return undefined;
  if (!isIdentifier(resolved)) {
    shell.failures.handleStoreFailure(
      'declarationOperand',
      { ok: false, reason: 'invalidIdentifier', message: `\`${resolved}': not a valid identifier` },
      builtin
    );
    return undefined;
  }
  rejectSpecialVariableMutation(resolved, false);
  return resolved;
}

function priorDestinationView(shell: Shell, name: string, intent: DestinationIntent): VariableView | undefined {
  if (intent === 'global') return shell.store.ownView(name, 0);
  const own = shell.store.ownView(name);
  return intent === 'local' ? (own?.isCurrentLocal ? own : undefined) : own;
}

function isUnreadHostAtIntent(shell: Shell, name: string, intent: DestinationIntent): boolean {
  if (intent === 'local') return false;
  return shell.store.isUnreadHostEnv(name, intent === 'global' ? 0 : undefined);
}

function applyPreWriteAttributes(
  shell: Shell,
  builtin: string,
  cell: CellHandle,
  set: ReadonlySet<string>,
  allowReadonlyAlreadySet: boolean
): boolean {
  const attrFailure = shell.store.applyAttributes(cell, nonReadonlyValueAttributes(set), allowReadonlyAlreadySet);
  if (!attrFailure) return true;
  return shell.failures.handleStoreFailure('declarationOperand', attrFailure, builtin);
}

function finalizeDeclaredCell(
  shell: Shell,
  builtin: string,
  cell: CellHandle,
  set: ReadonlySet<string>,
  wasMaterialized: boolean,
  onMaterialize?: () => void
): boolean {
  if (set.has('r')) {
    const roFailure = shell.store.applyAttributes(cell, new Set<Attribute>(['r']), true);
    if (roFailure) return shell.failures.handleStoreFailure('declarationOperand', roFailure, builtin);
  }
  const nextKind = shell.store.viewOfHandle(cell).kind;
  if (!wasMaterialized && (nextKind === 'indexed' || nextKind === 'associative')) onMaterialize?.();
  return true;
}

function nonReadonlyValueAttributes(set: ReadonlySet<string>): Set<Attribute> {
  return new Set<Attribute>([...set].filter((f): f is Attribute => VALUE_ATTRIBUTES.has(f) && f !== 'r'));
}

function planAssignsAnswer(plan: DeclarationPlan): boolean {
  const setsNameref = plan.builtin !== 'export' && plan.options.set.has('n');
  if (setsNameref) return false;
  return plan.operands.some((op) => {
    if (op.kind === 'completedCompound') return true;
    if (op.kind === 'assignment') return op.value !== undefined;
    if (op.kind === 'word') return op.text.includes('=');
    return false;
  });
}

function parseWordOperand(word: string): NormalizedScalarOperand {
  const eqIndex = findOperandEquals(word);
  if (eqIndex === -1) {
    return { ...splitDeclareLhs(word, true), append: false, value: undefined, rawText: word };
  }
  const append = eqIndex > 0 && word[eqIndex - 1] === '+';
  const lhs = word.slice(0, append ? eqIndex - 1 : eqIndex);
  return { ...splitDeclareLhs(lhs, false), append, value: word.slice(eqIndex + 1), rawText: word };
}

function splitDeclareLhs(lhs: string, nonEmptySubscript: boolean): { name: string; isSubscripted: boolean } {
  const open = lhs.indexOf('[');
  const valid =
    open !== -1 && (!nonEmptySubscript || open + 1 < lhs.length - 1) && skipSubscript(lhs, open) === lhs.length - 1;
  return valid ? { name: lhs.slice(0, open), isSubscripted: true } : { name: lhs, isSubscripted: false };
}

function findOperandEquals(word: string): number {
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '[') {
      const close = skipSubscript(word, i);
      if (close > i) i = close;
      continue;
    }
    if (word[i] === '=') return i;
  }
  return -1;
}
