import { skipSubscript } from './arithmetic';
import type { Assignment, Word } from './ast';
import { expandBraces } from './braces';
import {
  type Attribute,
  rejectSpecialVariableMutation,
  rejectUnsupportedDeclarationOperand,
  rejectUnsupportedDeclarationOptions,
} from './capabilities';
import { printDeclarations } from './declarePrint';
import type { Shell } from './shell';
import { resolveSubscriptTarget, resolveTargetName, writeResolvedTarget } from './targets';
import { UnsupportedFeatureError } from './unsupported';
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

const VALUE_ATTRIBUTES = new Set<string>(['a', 'A', 'i', 'l', 'u', 'x', 'r']);

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

/** Runs a static `declaration_command` (`declare`, `typeset`, `local`, `readonly`, `export`) via an explicit two-phase plan. */
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
        state.lastArgText = braced.text;
        state.operands.push(planAssignmentOperand(shell, builtin, braced, state));
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
    state.operands.push({ kind: 'word', text: word });
  }
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

function braceExpandAssignment(shell: Shell, arg: Assignment): Assignment[] {
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
  const value = arg.value ? shell.expander.expandAssignmentValue(arg.value, true) : undefined;
  if (value !== undefined) state.roots.push(value);
  return {
    kind: 'assignment',
    name: arg.name,
    ...(arg.subscript ? { subscript: arg.subscript } : {}),
    append: arg.append,
    value,
    text: arg.text,
  };
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
    return { kind: 'deferredCompound', name: arg.name, text: arg.text };
  }
  rejectUnsupportedDeclarationOptions(builtin, effective.set, effective.unset, effective.hasPlusOption);
  const intent = destinationIntentOf(shell, builtin, effective.set);
  const existingOwn = intent === 'local' ? undefined : shell.store.ownView(arg.name);
  rejectUnsupportedDeclarationOperand(builtin, arg.name, effective.set, {
    isSubscripted: Boolean(arg.subscript),
    isCompound: true,
    append: arg.append,
    existingIsNameref: Boolean(existingOwn?.attributes.has('n') && intent === 'global'),
  });
  const failCtx =
    shell.isInFunction && builtin !== 'readonly' && builtin !== 'export'
      ? 'declarationFunctionCompoundPhase1'
      : 'declarationCompoundPhase1';
  if (arg.subscript) {
    shell.failures.handleStoreFailure(failCtx, {
      ok: false,
      reason: 'cannotAssign',
      message: `${arg.name}[${arg.subscript.text}]: cannot assign list to array member`,
    });
    return { kind: 'failedCompound', name: arg.name, text: arg.text };
  }
  const targetName = resolvePhase1CompoundTarget(shell, arg.name, intent, failCtx);
  if (targetName === undefined) return { kind: 'failedCompound', name: arg.name, text: arg.text };
  return writePhase1CompoundToCell(shell, arg, effective, rawItems, intent, targetName, failCtx);
}

function resolvePhase1CompoundTarget(
  shell: Shell,
  rawName: string,
  intent: DestinationIntent,
  failCtx: 'declarationFunctionCompoundPhase1' | 'declarationCompoundPhase1'
): string | undefined {
  const targetName = intent === 'visible' ? resolveTargetName(shell, rawName) : rawName;
  if (targetName === undefined) return undefined;
  rejectSpecialVariableMutation(targetName, false);
  if (!isIdentifier(targetName)) {
    shell.failures.handleStoreFailure(failCtx, {
      ok: false,
      reason: 'invalidIdentifier',
      message: `\`${targetName}': not a valid identifier`,
    });
    return undefined;
  }
  return targetName;
}

// code-gauge-allow functionParameterCount -- Commits validated Phase-1 compound elements onto the selected destination cell.
function writePhase1CompoundToCell(
  shell: Shell,
  arg: Assignment,
  effective: ParsedOptions,
  rawItems: CompoundElement[],
  intent: DestinationIntent,
  targetName: string,
  failCtx: 'declarationFunctionCompoundPhase1' | 'declarationCompoundPhase1'
): PlannedOperand {
  const containerKind = effective.set.has('A') ? 'associative' : 'indexed';
  const priorKind = intent === 'local' ? undefined : shell.store.ownView(targetName)?.kind;
  const wasMaterialized = priorKind === 'indexed' || priorKind === 'associative';
  const selected = shell.store.selectDestination(intent, targetName, containerKind, arg.append);
  const attrFailure = shell.store.applyAttributes(selected.cell, nonReadonlyValueAttributes(effective.set), false);
  if (attrFailure) {
    shell.failures.handleStoreFailure(failCtx, attrFailure);
    return { kind: 'failedCompound', name: arg.name, text: arg.text };
  }
  const viewAfterAttr = shell.store.viewOfHandle(selected.cell);
  const isAssoc = viewAfterAttr.kind === 'associative' || viewAfterAttr.attributes.has('A');
  const { elements, error } = shell.expander.validateCompoundItems(rawItems, isAssoc, true, arg.name);
  const outcome = shell.store.writeCompound(selected.cell, elements, {
    append: arg.append,
    reportedName: arg.name,
    evalIndex: (cellHandle, rawKey) => shell.evaluateCompoundIndex(cellHandle, rawKey),
    evalInt: (expr) => shell.evaluateFatalReadonly(expr, false),
    onItemError: (msg) => shell.reportError(msg),
  });
  if (error !== undefined) shell.discard(error);
  if (!outcome.ok) {
    shell.failures.handleStoreFailure('declarationCompoundPhase1', outcome);
    return { kind: 'failedCompound', name: arg.name, text: arg.text };
  }
  const finalKind = shell.store.viewOfHandle(selected.cell).kind;
  const materializedArray = !wasMaterialized && (finalKind === 'indexed' || finalKind === 'associative');
  return {
    kind: 'completedCompound',
    name: arg.name,
    cell: selected.cell,
    materializedArray,
    text: arg.text,
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
  if (operands.length === 0) throw new UnsupportedFeatureError(`${builtin} の変数の一覧`);
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
      if (err) return shell.failures.handleStoreFailure(builtinFailureContext(builtin), err, builtin);
    }
    return true;
  }
  if (operand.kind === 'word') {
    const parsed = parseWordOperand(operand.text);
    return executeScalarOrElementOperand(
      shell,
      builtin,
      {
        name: parsed.name,
        subscriptText: parsed.subscript,
        append: parsed.append,
        value: parsed.value,
        rawText: operand.text,
      },
      set,
      intent,
      onMaterialize
    );
  }
  return executeScalarOrElementOperand(
    shell,
    builtin,
    {
      name: operand.name,
      subscriptWord: operand.subscript,
      append: operand.append,
      value: operand.value,
      rawText: operand.text,
    },
    set,
    intent,
    onMaterialize
  );
}

interface NormalizedOperand {
  readonly name: string;
  readonly subscriptWord?: Word;
  readonly subscriptText?: string;
  readonly append: boolean;
  readonly value: string | undefined;
  readonly rawText: string;
}

function executeScalarOrElementOperand(
  shell: Shell,
  builtin: string,
  op: NormalizedOperand,
  set: ReadonlySet<string>,
  intent: DestinationIntent,
  onMaterialize?: () => void
): boolean {
  const isSubscripted = op.subscriptWord !== undefined || op.subscriptText !== undefined;
  const failCtx = builtinFailureContext(builtin);
  if (!isIdentifier(op.name)) {
    return shell.failures.handleStoreFailure(
      failCtx,
      { ok: false, reason: 'invalidIdentifier', message: `\`${op.rawText}': not a valid identifier` },
      builtin
    );
  }
  const existingForCheck = priorDestinationView(shell, op.name, intent);
  rejectUnsupportedDeclarationOperand(builtin, op.name, set, {
    isSubscripted,
    isCompound: false,
    append: op.append,
    existingIsNameref: Boolean(existingForCheck?.attributes.has('n')),
  });
  if (set.has('n')) {
    const selected = shell.store.selectDestination(intent, op.name);
    const bound = shell.store.bindNameref(selected.cell, op.value, shell.isInFunction);
    if (!bound.ok) return shell.failures.handleStoreFailure(failCtx, bound, builtin);
    if (bound.cycleWarning) shell.reportError(bound.cycleWarning);
    return true;
  }
  if (isSubscripted) {
    return executeSubscriptedDeclaration(shell, builtin, op, set, intent, onMaterialize);
  }
  return executeUnsubscriptedDeclaration(shell, builtin, op, set, intent, onMaterialize);
}

function executeUnsubscriptedDeclaration(
  shell: Shell,
  builtin: string,
  op: NormalizedOperand,
  set: ReadonlySet<string>,
  intent: DestinationIntent,
  onMaterialize?: () => void
): boolean {
  const failCtx = builtinFailureContext(builtin);
  const targetName = resolveUnsubscriptedDeclareTarget(shell, builtin, op.name, intent);
  if (targetName === undefined) return false;
  const priorKind = priorDestinationView(shell, targetName, intent)?.kind;
  const wasMaterialized = priorKind === 'indexed' || priorKind === 'associative';
  const createsArray = set.has('a') || set.has('A');
  const selected = shell.store.selectDestination(intent, targetName, undefined, op.append, !createsArray);
  if (!applyPreWriteAttributes(shell, builtin, selected.cell, set, op.value === undefined)) return false;
  if (op.value !== undefined) {
    const outcome = shell.store.writeScalar(
      selected.cell,
      op.value,
      op.append,
      (expr) => shell.evaluateFatalReadonly(expr, false),
      targetName
    );
    if (!outcome.ok) return shell.failures.handleStoreFailure(failCtx, outcome, builtin);
  }
  return finalizeDeclaredCell(shell, builtin, selected.cell, set, wasMaterialized, onMaterialize);
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
      builtinFailureContext(builtin),
      { ok: false, reason: 'invalidIdentifier', message: `\`${resolved}': not a valid identifier` },
      builtin
    );
    return undefined;
  }
  rejectSpecialVariableMutation(resolved, false);
  return resolved;
}

function executeSubscriptedDeclaration(
  shell: Shell,
  builtin: string,
  op: NormalizedOperand,
  set: ReadonlySet<string>,
  intent: DestinationIntent,
  onMaterialize?: () => void
): boolean {
  const failCtx = builtinFailureContext(builtin);
  const scopedIntent = intent === 'local' ? 'local' : 'visible';
  const prepared = prepareSubscriptedDestination(shell, builtin, op, set, scopedIntent);
  if (!prepared) return false;
  const subInput =
    op.subscriptWord !== undefined
      ? ({ kind: 'word', word: op.subscriptWord } as const)
      : ({ kind: 'text', text: op.subscriptText ?? '' } as const);
  const target = resolveSubscriptTarget(shell, {
    name: op.name,
    subscript: subInput,
    operation: op.value === undefined ? 'read' : 'write',
    intent: scopedIntent,
    append: op.append,
  });
  if (!target) return false;
  if (target.kind === 'invalid') return shell.failures.handleStoreFailure(failCtx, target.failure, builtin);
  if (op.value !== undefined) {
    const outcome = writeResolvedTarget(shell, target, op.value, op.append);
    if (!outcome.ok) return shell.failures.handleStoreFailure(failCtx, outcome, builtin);
  }
  return finalizeDeclaredCell(shell, builtin, prepared.cell, set, prepared.wasMaterialized, onMaterialize);
}

function prepareSubscriptedDestination(
  shell: Shell,
  builtin: string,
  op: NormalizedOperand,
  set: ReadonlySet<string>,
  scopedIntent: 'local' | 'visible'
): { cell: CellHandle; wasMaterialized: boolean } | undefined {
  const targetName = resolveUnsubscriptedDeclareTarget(shell, builtin, op.name, scopedIntent);
  if (targetName === undefined) return undefined;
  const priorView = priorDestinationView(shell, targetName, scopedIntent);
  const wasMaterialized = priorView?.kind === 'indexed' || priorView?.kind === 'associative';
  const existingAssoc = priorView?.kind === 'associative' || priorView?.attributes.has('A') === true;
  const isAssoc = set.has('A') || (existingAssoc && !set.has('a'));
  const containerKind = op.value === undefined ? undefined : isAssoc ? 'associative' : 'indexed';
  const selected = shell.store.selectDestination(scopedIntent, targetName, containerKind, op.append, false);
  const effectiveSet = isAssoc ? set : new Set([...set, 'a']);
  if (!applyPreWriteAttributes(shell, builtin, selected.cell, effectiveSet, op.value === undefined)) return undefined;
  return { cell: selected.cell, wasMaterialized };
}

function priorDestinationView(shell: Shell, name: string, intent: DestinationIntent): VariableView | undefined {
  if (intent === 'global') return shell.store.ownView(name, 0);
  const own = shell.store.ownView(name);
  return intent === 'local' ? (own?.isCurrentLocal ? own : undefined) : own;
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
  return shell.failures.handleStoreFailure(builtinFailureContext(builtin), attrFailure, builtin);
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
    if (roFailure) return shell.failures.handleStoreFailure(builtinFailureContext(builtin), roFailure, builtin);
  }
  const nextKind = shell.store.viewOfHandle(cell).kind;
  if (!wasMaterialized && (nextKind === 'indexed' || nextKind === 'associative')) onMaterialize?.();
  return true;
}

function nonReadonlyValueAttributes(set: ReadonlySet<string>): Set<Attribute> {
  return new Set<Attribute>([...set].filter((f): f is Attribute => VALUE_ATTRIBUTES.has(f) && f !== 'r'));
}

function builtinFailureContext(builtin: string): 'declarationFatalBuiltin' | 'declarationOperand' {
  return builtin === 'readonly' || builtin === 'export' ? 'declarationFatalBuiltin' : 'declarationOperand';
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

function parseWordOperand(word: string): { name: string; subscript?: string; append: boolean; value?: string } {
  const eqIndex = findOperandEquals(word);
  if (eqIndex === -1) {
    const open = word.indexOf('[');
    if (open !== -1 && open + 1 < word.length - 1 && skipSubscript(word, open) === word.length - 1) {
      return { name: word.slice(0, open), subscript: word.slice(open + 1, -1), append: false };
    }
    return { name: word, append: false };
  }
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
