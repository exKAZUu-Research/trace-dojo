import { skipSubscript } from './arithmetic';
import type { Assignment, StaticDeclarationOptions, Word } from './ast';
import { expandBraces } from './braces';
import { appendMetered, pushMeteredItem } from './budget';
import {
  type Attribute,
  DECLARATION_OPTIONS,
  rejectUnsupportedDeclarationListing,
  rejectUnsupportedDeclarationOperand,
  rejectUnsupportedDeclarationOptions,
  rejectUnsupportedShadowedCompound,
  rejectUnsupportedVariableMutation,
} from './capabilities';
import { printDeclarations } from './declarePrint';
import type { FailureContext } from './failurePolicy';
import type { Shell } from './shell';
import { resolveTargetName } from './targets';
import { type DestinationIntent, isIdentifier } from './variables';

const USAGES: Record<string, string> = {
  declare: 'declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]',
  typeset: 'typeset [-aAfFgiIlnrtux] name[=value] ... or typeset -p [-aAfFilnrtux] [name ...]',
  local: 'local [option] name[=value] ...',
  readonly: 'readonly [-aAf] [name[=value] ...] or readonly -p',
  export: 'export [-fn] [name[=value] ...] or export -p [-f]',
};

const VALUE_ATTRIBUTES = new Set<string>(['a', 'A', 'i', 'x', 'r']);

export interface ParsedOptions {
  readonly set: Set<string>;
  readonly unset: Set<string>;
  hasPlusOption: boolean;
  invalidOption?: string;
}

interface NormalizedScalarOperand {
  readonly name: string;
  readonly isSubscripted: boolean;
  readonly append: boolean;
  readonly value: string | undefined;
  readonly rawText: string;
}

type ReadyOperand =
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'scalar'; readonly parsed: NormalizedScalarOperand }
  | { readonly kind: 'compound'; readonly arg: Assignment };

interface DeclarationRunState {
  status: number;
  assignsAnswer: boolean;
  lastArgText: string;
}

/** Consumes one leading option token into `options`, or returns `false` when `token` begins operands. */
export function consumeDeclarationOptionToken(builtin: string, token: string, options: ParsedOptions): boolean {
  if (token === '--' || !/^[-+]./.test(token)) return false;
  const sign = token[0] as '-' | '+';
  if (sign === '+') options.hasPlusOption = true;
  const allowed = DECLARATION_OPTIONS[builtin] ?? '';
  for (const ch of token.slice(1)) {
    if (!allowed.includes(ch)) {
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

/** Runs a static `declaration` statement directly through per-operand `VariableStore` transactions. */
export function executeDeclarationCommand(
  shell: Shell,
  builtin: string,
  staticOptions: StaticDeclarationOptions | undefined,
  args: readonly (Word | Assignment)[],
  withRedirects: <T>(run: () => T) => T
): { status: number; assignsAnswer: boolean } {
  const savedGuards = shell.store.compoundGuardDepth();
  try {
    const prepared = staticOptions
      ? prepareNormalizedDeclaration(builtin, staticOptions, args)
      : prepareRuntimeOptionDeclaration(shell, builtin, args);
    const state: DeclarationRunState = {
      status: 0,
      assignsAnswer: false,
      lastArgText: prepared.initialLastArg,
    };
    if (hasValidBuiltinContext(shell, builtin, prepared.options)) {
      rejectUnsupportedDeclarationOptions(
        builtin,
        prepared.options.set,
        prepared.options.unset,
        prepared.options.hasPlusOption
      );
    }
    const operands = collectReadyOperands(shell, prepared.operandArgs, state);
    shell.store.leaveCompoundGuards(savedGuards);
    const headerCode = withRedirects(() => validateDeclarationHeader(shell, builtin, prepared.options));
    if (headerCode !== undefined) {
      withRedirects(() => {
        shell.store.lastArgument = state.lastArgText;
      });
      return { status: headerCode, assignsAnswer: false };
    }
    if (operands.length === 0) rejectUnsupportedDeclarationListing(builtin);
    if (prepared.options.set.has('p') && builtin !== 'readonly' && builtin !== 'export') {
      const status = withRedirects(() => {
        const names = operands.map((op) =>
          op.kind === 'word' ? op.text : op.kind === 'scalar' ? op.parsed.name : op.arg.name
        );
        const code = printDeclarations(shell, builtin, names);
        shell.store.lastArgument = state.lastArgText;
        return code;
      });
      return { status, assignsAnswer: false };
    }
    executeReadyOperands(shell, builtin, prepared.options.set, operands, state, withRedirects);
    return { status: state.status, assignsAnswer: state.assignsAnswer };
  } finally {
    shell.store.leaveCompoundGuards(savedGuards);
  }
}

/** Runs a declaration builtin invoked through an expanded command word (`cmd=declare; $cmd x=1`). */
export function runDynamicDeclarationBuiltin(shell: Shell, builtin: string, args: readonly string[]): number {
  const options = createEmptyOptions();
  const operands: ReadyOperand[] = [];
  let optionsDone = false;
  for (const arg of args) {
    if (!optionsDone && arg === '--') {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && consumeDeclarationOptionToken(builtin, arg, options)) continue;
    optionsDone = true;
    pushMeteredItem(operands, { kind: 'word', text: arg }, shell.runtime.step);
  }
  applyBuiltinImpliedFlags(builtin, options);
  const headerCode = validateDeclarationHeader(shell, builtin, options);
  if (headerCode !== undefined) return headerCode;
  if (operands.length === 0) rejectUnsupportedDeclarationListing(builtin);
  if (options.set.has('p') && builtin !== 'readonly' && builtin !== 'export') {
    return printDeclarations(
      shell,
      builtin,
      operands.map((op) => (op as Extract<ReadyOperand, { kind: 'word' }>).text)
    );
  }
  const state: DeclarationRunState = { status: 0, assignsAnswer: false, lastArgText: args.at(-1) ?? builtin };
  executeReadyOperands(shell, builtin, options.set, operands, state, (run) => run());
  return state.status;
}

/** Expands a static declaration command's arguments when a shell function shadows the builtin name. */
export function expandShadowedDeclarationArgs(
  shell: Shell,
  builtin: string,
  rawArgs: readonly (Word | Assignment)[]
): string[] {
  const argv = [builtin];
  for (const arg of rawArgs) appendShadowedArg(shell, builtin, arg, argv);
  return argv;
}

/** Executes an ordinary `name=(...)` or `name+=(...)` compound assignment through the store's transactional writer. */
export function executeCompoundAssignment(shell: Shell, assignment: Assignment, context: 'scriptAssignment'): boolean {
  const savedGuards = shell.store.compoundGuardDepth();
  try {
    return commitCompoundOperand(shell, {
      name: assignment.name,
      subscript: assignment.subscript,
      append: assignment.append,
      words: assignment.array as Word[],
      intent: 'visible',
      set: new Set(),
      context,
    }).ok;
  } finally {
    shell.store.leaveCompoundGuards(savedGuards);
  }
}

// ---------------------------------------------------------------- option preparation & direct operand execution

function prepareNormalizedDeclaration(
  builtin: string,
  staticOptions: StaticDeclarationOptions,
  args: readonly (Word | Assignment)[]
): { options: ParsedOptions; operandArgs: readonly (Word | Assignment | ReadyOperand)[]; initialLastArg: string } {
  const options: ParsedOptions = {
    set: new Set(staticOptions.set),
    unset: new Set(staticOptions.unset),
    hasPlusOption: staticOptions.hasPlusOption,
    ...(staticOptions.invalidOption ? { invalidOption: staticOptions.invalidOption } : {}),
  };
  applyBuiltinImpliedFlags(builtin, options);
  return { options, operandArgs: args, initialLastArg: builtin };
}

function prepareRuntimeOptionDeclaration(
  shell: Shell,
  builtin: string,
  args: readonly (Word | Assignment)[]
): { options: ParsedOptions; operandArgs: readonly (Word | Assignment | ReadyOperand)[]; initialLastArg: string } {
  const options = createEmptyOptions();
  const remaining: (Word | Assignment | ReadyOperand)[] = [];
  let optionsDone = false;
  let lastArg = builtin;
  for (const arg of args) {
    if (optionsDone || 'append' in arg) {
      optionsDone = true;
      remaining.push(arg);
      continue;
    }
    for (const expanded of shell.expander.expandWords([arg])) {
      lastArg = expanded;
      if (!optionsDone && expanded === '--') {
        optionsDone = true;
        continue;
      }
      if (!optionsDone && consumeDeclarationOptionToken(builtin, expanded, options)) continue;
      optionsDone = true;
      pushMeteredItem(remaining, { kind: 'word', text: expanded }, shell.runtime.step);
    }
  }
  applyBuiltinImpliedFlags(builtin, options);
  return { options, operandArgs: remaining, initialLastArg: lastArg };
}

function createEmptyOptions(): ParsedOptions {
  return { set: new Set(), unset: new Set(), hasPlusOption: false };
}

function applyBuiltinImpliedFlags(builtin: string, options: ParsedOptions): void {
  if (builtin === 'readonly') options.set.add('r');
  else if (builtin === 'export') {
    if (options.set.delete('n')) options.unset.add('x');
    else options.set.add('x');
  }
}

function hasValidBuiltinContext(shell: Shell, builtin: string, options: ParsedOptions): boolean {
  return (
    options.invalidOption === undefined &&
    !(options.set.has('A') && options.set.has('a')) &&
    !(builtin === 'local' && !shell.isInFunction)
  );
}

function validateDeclarationHeader(shell: Shell, builtin: string, options: ParsedOptions): number | undefined {
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
  return undefined;
}

function collectReadyOperands(
  shell: Shell,
  operandArgs: readonly (Word | Assignment | ReadyOperand)[],
  state: DeclarationRunState
): ReadyOperand[] {
  const ready: ReadyOperand[] = [];
  for (const item of operandArgs) {
    if ('kind' in item) {
      pushMeteredItem(ready, item, shell.runtime.step);
      continue;
    }
    if ('append' in item) {
      if (item.array) {
        state.lastArgText = item.name;
        shell.store.enterCompoundGuard(item.name);
        pushMeteredItem(ready, { kind: 'compound', arg: item }, shell.runtime.step);
        continue;
      }
      for (const braced of braceExpandAssignment(shell, item)) {
        const expanded = expandAssignmentOperand(shell, braced);
        state.lastArgText = expanded.text;
        pushMeteredItem(
          ready,
          {
            kind: 'scalar',
            parsed: {
              name: braced.name,
              isSubscripted: braced.subscript !== undefined,
              append: braced.append,
              value: expanded.value,
              rawText: expanded.text,
            },
          },
          shell.runtime.step
        );
      }
      continue;
    }
    for (const word of shell.expander.expandWords([item])) {
      state.lastArgText = word;
      pushMeteredItem(ready, { kind: 'word', text: word }, shell.runtime.step);
    }
  }
  return ready;
}

function executeReadyOperands(
  shell: Shell,
  builtin: string,
  set: ReadonlySet<string>,
  operands: readonly ReadyOperand[],
  state: DeclarationRunState,
  withRedirects: <T>(run: () => T) => T
): void {
  const intent = destinationIntentOf(shell, builtin, set);
  const setsNameref = builtin !== 'export' && set.has('n');
  for (const operand of operands) {
    const ok =
      operand.kind === 'compound'
        ? executeCompoundDeclarationOperand(shell, builtin, operand.arg, set, intent, setsNameref, state, withRedirects)
        : executePreparedScalarOperand(
            shell,
            builtin,
            operand.kind === 'scalar' ? operand.parsed : parseWordOperand(operand.text),
            set,
            intent,
            setsNameref,
            state,
            withRedirects
          );
    if (!ok) state.status = 1;
  }
  withRedirects(() => {
    shell.store.lastArgument = state.lastArgText;
  });
}

// code-gauge-allow functionParameterCount -- Threads static compound AST assignment, declaration flags, state, and redirect wrapper.
function executeCompoundDeclarationOperand(
  shell: Shell,
  builtin: string,
  arg: Assignment,
  set: ReadonlySet<string>,
  intent: DestinationIntent,
  setsNameref: boolean,
  state: DeclarationRunState,
  withRedirects: <T>(run: () => T) => T
): boolean {
  state.lastArgText = arg.name;
  if (!setsNameref) state.assignsAnswer = true;
  const failCtx: FailureContext =
    shell.isInFunction && builtin !== 'readonly' && builtin !== 'export'
      ? 'declarationLocalCompound'
      : 'declarationGlobalCompound';
  const committed = withRedirects(() =>
    commitCompoundOperand(shell, {
      builtin,
      name: arg.name,
      subscript: arg.subscript,
      append: arg.append,
      words: arg.array as Word[],
      intent,
      set,
      context: failCtx,
    })
  );
  if (committed.materialized) state.assignsAnswer = true;
  return committed.ok;
}

// code-gauge-allow functionParameterCount -- Threads prepared scalar operand, declaration flags, state, and redirect wrapper.
function executePreparedScalarOperand(
  shell: Shell,
  builtin: string,
  parsed: NormalizedScalarOperand,
  set: ReadonlySet<string>,
  intent: DestinationIntent,
  setsNameref: boolean,
  state: DeclarationRunState,
  withRedirects: <T>(run: () => T) => T
): boolean {
  state.lastArgText = parsed.rawText;
  if (!setsNameref && parsed.value !== undefined) state.assignsAnswer = true;
  return withRedirects(() =>
    executeScalarDeclarationOperand(shell, builtin, parsed, set, intent, () => {
      state.assignsAnswer = true;
    })
  );
}

function destinationIntentOf(shell: Shell, builtin: string, set: ReadonlySet<string>): DestinationIntent {
  if (shell.isInFunction && !set.has('g') && (builtin === 'local' || builtin === 'declare' || builtin === 'typeset')) {
    return 'local';
  }
  return set.has('g') ? 'global' : 'visible';
}

interface CompoundOperandRequest {
  readonly builtin?: string;
  readonly name: string;
  readonly subscript?: Word;
  readonly append: boolean;
  readonly words: Word[];
  readonly intent: DestinationIntent;
  readonly set: ReadonlySet<string>;
  readonly context: FailureContext;
}

function commitCompoundOperand(shell: Shell, req: CompoundOperandRequest): { ok: boolean; materialized: boolean } {
  if (req.subscript) {
    if (req.builtin !== undefined) {
      rejectUnsupportedDeclarationOperand(req.builtin, req.name, req.set, {
        isSubscripted: true,
        isCompound: true,
        append: req.append,
        hasScalarValue: false,
        hasEnclosingTempBinding: shell.store.hasTemporaryBinding(req.name),
      });
    }
    shell.failures.handleStoreFailure(req.context, {
      ok: false,
      reason: 'cannotAssign',
      message: `${req.name}[${req.subscript.text}]: cannot assign list to array member`,
    });
    return { ok: false, materialized: false };
  }
  const targetName = resolveCompoundTargetName(shell, req);
  if (targetName === undefined) return { ok: false, materialized: false };
  const priorView = shell.store.priorViewAtIntent(targetName, req.intent);
  if (req.builtin !== undefined) {
    rejectUnsupportedDeclarationOperand(req.builtin, req.name, req.set, {
      isSubscripted: false,
      isCompound: true,
      append: req.append,
      hasScalarValue: false,
      hasEnclosingTempBinding: shell.store.hasTemporaryBinding(req.name),
      existing: priorView,
    });
  } else if (priorView?.attributes.has('r')) {
    shell.failures.handleStoreFailure(req.context, {
      ok: false,
      reason: 'readonly',
      message: `${targetName}: readonly variable`,
    });
    return { ok: false, materialized: false };
  }
  const existingIsAssoc = priorView?.kind === 'associative' || priorView?.attributes.has('A') === true;
  const isAssoc = req.set.has('A') || existingIsAssoc;
  if (req.builtin === undefined && req.append && existingIsAssoc) {
    return streamAssociativeAppend(shell, targetName, req.words, req.name, req.context);
  }
  return expandAndCommitCompound(shell, req, targetName, isAssoc);
}

function resolveCompoundTargetName(shell: Shell, req: CompoundOperandRequest): string | undefined {
  const targetName = req.intent === 'visible' ? resolveTargetName(shell, req.name) : req.name;
  rejectUnsupportedVariableMutation(targetName, false);
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
  targetName: string,
  words: Word[],
  reportedName: string,
  context: FailureContext
): { ok: boolean; materialized: boolean } {
  const { outcome, syntaxError, materializedArray } = shell.store.writeAssociativeCompoundStreamNamed(
    targetName,
    reportedName,
    (expr) => shell.evaluateFatalReadonly(expr, false),
    (commitPair) => shell.expander.expandAssociativeAppend(words, reportedName, commitPair)
  );
  if (syntaxError !== undefined) shell.discard(syntaxError);
  if (!outcome.ok) {
    shell.failures.handleStoreFailure(context, outcome);
    return { ok: false, materialized: false };
  }
  return { ok: true, materialized: materializedArray };
}

function expandAndCommitCompound(
  shell: Shell,
  req: CompoundOperandRequest,
  targetName: string,
  isAssoc: boolean
): { ok: boolean; materialized: boolean } {
  const isDeclaration = req.builtin !== undefined;
  const beforeExpandDepth = shell.store.enterCompoundGuard(targetName, false);
  const expanded = shell.expander.expandCompound(req.words, isAssoc, isDeclaration, req.name);
  shell.store.leaveCompoundGuards(beforeExpandDepth);
  const { outcome, materializedArray } = shell.store.writeCompoundNamed({
    resolvedName: targetName,
    intent: req.intent,
    isAssoc,
    preAttrs: nonReadonlyValueAttributes(req.set),
    postReadonly: req.set.has('r'),
    elements: expanded.elements,
    hooks: {
      append: req.append,
      reportedName: req.name,
      evalIndex: (resolvedName, rawKey) => shell.evaluateCompoundIndex(resolvedName, rawKey),
      evalInt: (expr) => shell.evaluateFatalReadonly(expr, false),
      onItemError: (msg) => shell.reportError(msg),
    },
  });
  if (isDeclaration) shell.store.enterCompoundGuard(targetName);
  if (expanded.error !== undefined) shell.discard(expanded.error);
  if (!outcome.ok) {
    shell.failures.handleStoreFailure(req.context, outcome);
    return { ok: false, materialized: false };
  }
  return { ok: true, materialized: materializedArray };
}

function executeScalarDeclarationOperand(
  shell: Shell,
  builtin: string,
  op: NormalizedScalarOperand,
  set: ReadonlySet<string>,
  intent: DestinationIntent,
  onMaterialize: () => void
): boolean {
  if (!isIdentifier(op.name)) {
    return shell.failures.handleStoreFailure(
      'declarationOperand',
      { ok: false, reason: 'invalidIdentifier', message: `\`${op.rawText}': not a valid identifier` },
      builtin
    );
  }
  const effectiveSet = builtin === 'readonly' && op.value === undefined ? new Set<string>(['r']) : set;
  const existingOwn = shell.store.priorViewAtIntent(op.name, intent);
  rejectUnsupportedDeclarationOperand(builtin, op.name, effectiveSet, {
    isSubscripted: op.isSubscripted,
    isCompound: false,
    append: op.append,
    hasScalarValue: op.value !== undefined && !effectiveSet.has('n'),
    hasEnclosingTempBinding: shell.store.hasTemporaryBinding(op.name),
    existing: existingOwn,
  });
  const outerRo = intent === 'local' ? shell.store.outerReadonlyFailure(op.name) : undefined;
  if (outerRo) return shell.failures.handleStoreFailure('declarationOperand', outerRo, builtin);
  if (effectiveSet.has('n')) {
    const namerefFailure = shell.store.declareNamerefNamed(builtin, op.name, op.value);
    return namerefFailure ? shell.failures.handleStoreFailure('declarationOperand', namerefFailure, builtin) : true;
  }
  return executeUnsubscriptedDeclaration(shell, builtin, op, effectiveSet, intent, onMaterialize);
}

function executeUnsubscriptedDeclaration(
  shell: Shell,
  builtin: string,
  op: NormalizedScalarOperand,
  effectiveSet: ReadonlySet<string>,
  intent: DestinationIntent,
  onMaterialize: () => void
): boolean {
  const targetName = resolveUnsubscriptedDeclareTarget(shell, builtin, op.name, intent);
  if (targetName === undefined) return false;
  if (targetName !== op.name) {
    rejectUnsupportedDeclarationOperand(builtin, targetName, effectiveSet, {
      isSubscripted: false,
      isCompound: false,
      append: op.append,
      hasScalarValue: op.value !== undefined,
      hasEnclosingTempBinding: shell.store.hasTemporaryBinding(targetName),
      existing: shell.store.priorViewAtIntent(targetName, intent),
    });
  }
  const attrs = new Set<Attribute>([...effectiveSet].filter((f): f is Attribute => VALUE_ATTRIBUTES.has(f)));
  const { failure, materializedArray } = shell.store.declareScalarNamed({
    builtin,
    targetName,
    intent,
    effectiveSet: attrs,
    value: op.value,
    append: op.append,
    evalInt: (expr) => shell.evaluateFatalReadonly(expr, false, builtin),
  });
  if (failure) return shell.failures.handleStoreFailure('declarationOperand', failure, builtin);
  if (materializedArray) onMaterialize();
  return true;
}

function resolveUnsubscriptedDeclareTarget(
  shell: Shell,
  builtin: string,
  rawName: string,
  intent: DestinationIntent
): string | undefined {
  if (intent !== 'visible') return rawName;
  const resolved = resolveTargetName(shell, rawName);
  if (!isIdentifier(resolved)) {
    shell.failures.handleStoreFailure(
      'declarationOperand',
      { ok: false, reason: 'invalidIdentifier', message: `\`${resolved}': not a valid identifier` },
      builtin
    );
    return undefined;
  }
  rejectUnsupportedVariableMutation(resolved, false);
  return resolved;
}

function nonReadonlyValueAttributes(set: ReadonlySet<string>): Set<Attribute> {
  return new Set<Attribute>([...set].filter((f): f is Attribute => VALUE_ATTRIBUTES.has(f) && f !== 'r'));
}

function appendShadowedArg(shell: Shell, builtin: string, arg: Word | Assignment, argv: string[]): void {
  if (!('append' in arg)) {
    for (const word of shell.expander.expandWords([arg])) {
      pushMeteredItem(argv, word, shell.runtime.step);
    }
    return;
  }
  if (arg.array) rejectUnsupportedShadowedCompound(builtin);
  for (const braced of braceExpandAssignment(shell, arg)) {
    pushMeteredItem(argv, expandAssignmentOperand(shell, braced).text, shell.runtime.step);
  }
}

function* braceExpandAssignment(shell: Shell, arg: Assignment): Generator<Assignment> {
  if (arg.array) {
    yield arg;
    return;
  }
  const step = shell.runtime.step;
  const subPartsList = arg.subscript ? expandBraces(arg.subscript.parts, step) : [undefined];
  const valPartsList = arg.value ? expandBraces(arg.value.parts, step) : [undefined];
  for (const subParts of subPartsList) {
    for (const valParts of valPartsList) {
      step();
      yield {
        ...arg,
        ...(subParts && arg.subscript ? { subscript: { ...arg.subscript, parts: subParts } } : {}),
        ...(valParts && arg.value ? { value: { ...arg.value, parts: valParts } } : {}),
      };
    }
  }
}

function expandAssignmentOperand(shell: Shell, arg: Assignment): { value: string; text: string } {
  const spend = (cost?: number): void => shell.runtime.spend(cost);
  const lhs = arg.subscript ? `${arg.name}[${shell.expander.expandAssignmentSubscript(arg.subscript)}]` : arg.name;
  const value = arg.value ? shell.expander.expandAssignmentValue(arg.value, true) : '';
  const head = appendMetered(lhs, arg.append ? '+=' : '=', spend);
  const text = appendMetered(head, value, spend);
  return { value, text };
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
  if (open === -1) return { name: lhs, isSubscripted: false };
  const close = skipSubscript(lhs, open);
  const hasValidBrackets = close === lhs.length - 1 && (!nonEmptySubscript || close > open + 1);
  if (!hasValidBrackets) return { name: lhs, isSubscripted: false };
  const base = lhs.slice(0, open);
  return isIdentifier(base) ? { name: base, isSubscripted: true } : { name: lhs, isSubscripted: false };
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
