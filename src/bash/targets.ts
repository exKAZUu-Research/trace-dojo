import type { Word } from './ast';
import { rejectSpecialVariableMutation } from './capabilities';
import type { StoreFailure, StoreOutcome } from './failurePolicy';
import type { Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import { type CellHandle, type DestinationIntent, isIdentifier, type VariableView } from './variables';

export type ResolvedTarget =
  | { readonly kind: 'randomSeed' }
  | {
      readonly kind: 'scalar';
      readonly name: string;
      readonly reportedName: string;
      readonly cell?: CellHandle;
      readonly isDynamic: boolean;
    }
  | {
      readonly kind: 'associativeElement';
      readonly name: string;
      readonly reportedName: string;
      readonly cell: CellHandle;
      readonly key: string;
    }
  | {
      readonly kind: 'indexedElement';
      readonly name: string;
      readonly reportedName: string;
      readonly cell?: CellHandle;
      readonly index: bigint;
      readonly isDynamic: boolean;
    }
  | {
      readonly kind: 'wholeArray';
      readonly name: string;
      readonly reportedName: string;
      readonly cell?: CellHandle;
      readonly star: boolean;
      readonly isDynamic: boolean;
    }
  | {
      readonly kind: 'invalid';
      readonly raw: string;
      readonly failure: StoreFailure;
      readonly emptyArithmeticWrite?: boolean;
    };

export type SubscriptInput =
  | { readonly kind: 'word'; readonly word: Word }
  | { readonly kind: 'text'; readonly text: string; readonly preExpanded?: boolean };

export type TargetOperation = 'read' | 'write' | 'unset' | 'testSet' | 'arithmeticRead' | 'arithmeticWrite';

export interface SubscriptTargetOptions {
  readonly name: string;
  readonly subscript: SubscriptInput;
  readonly operation: TargetOperation;
  readonly intent?: DestinationIntent;
  readonly append?: boolean;
}

/** Resolves whole-variable nameref chains through `VariableStore`, reporting circular references when requested. */
export function resolveTargetName(shell: Shell, name: string, warnCycle = true): string | undefined {
  const res = shell.store.resolveChain(name);
  if (res.kind === 'resolved') return res.name;
  if (warnCycle) shell.reportError(`warning: ${res.cyclicName}: circular name reference`);
  return undefined;
}

/** Resolves an unsubscripted variable target for reads or writes. */
export function resolveScalarTarget(
  shell: Shell,
  name: string,
  forWrite: boolean,
  options?: { intent?: DestinationIntent; append?: boolean; warnCycle?: boolean }
): ResolvedTarget | undefined {
  const intent = options?.intent ?? 'visible';
  const append = options?.append ?? false;
  if (!isIdentifier(name)) {
    return {
      kind: 'invalid',
      raw: name,
      failure: { ok: false, reason: 'invalidIdentifier', message: `\`${name}': not a valid identifier` },
    };
  }
  if (forWrite && intent !== 'visible') {
    rejectSpecialVariableMutation(name, false);
    const selected = shell.store.selectDestination(intent, name, undefined, append);
    return { kind: 'scalar', name, reportedName: name, cell: selected.cell, isDynamic: false };
  }
  const resolved = resolveTargetName(shell, name, options?.warnCycle ?? true);
  if (resolved === undefined) return undefined;
  if (!isIdentifier(resolved)) {
    return {
      kind: 'invalid',
      raw: resolved,
      failure: { ok: false, reason: 'invalidIdentifier', message: `\`${resolved}': not a valid identifier` },
    };
  }
  if (forWrite) {
    const allowRandom = !append;
    rejectSpecialVariableMutation(resolved, allowRandom);
    if (resolved === 'RANDOM' && !shell.store.ownView('RANDOM')) return { kind: 'randomSeed' };
    const selected = shell.store.selectDestination('visible', resolved, undefined, append);
    return { kind: 'scalar', name: resolved, reportedName: name, cell: selected.cell, isDynamic: false };
  }
  const view = shell.store.ownView(resolved);
  return {
    kind: 'scalar',
    name: resolved,
    reportedName: name,
    ...(view?.handle ? { cell: view.handle } : {}),
    isDynamic: !view && shell.store.isDynamic(resolved),
  };
}

/**
 * Resolves a subscripted variable target once across assignments, arithmetic, expansions, builtins, and tests.
 */
// code-gauge-allow functionCognitiveComplexity -- Unifies nameref traversal, capability gating, whole-array markers, associative keys, and single-evaluated indexed subscripts.
export function resolveSubscriptTarget(shell: Shell, opts: SubscriptTargetOptions): ResolvedTarget | undefined {
  const { name, subscript, operation } = opts;
  const intent = opts.intent ?? 'visible';
  const rawSubText = rawSubscriptText(subscript);
  const forWrite = operation === 'write' || operation === 'arithmeticWrite';
  const forMutation = forWrite || operation === 'unset';
  if (!isIdentifier(name)) {
    return invalidTarget(`${name}[${rawSubText}]`, 'invalidIdentifier', `\`${name}': not a valid identifier`);
  }
  if (operation === 'arithmeticRead' && rawSubText === '') {
    shell.reportError(`${name}[]: bad array subscript`);
    shell.reportError(`${name}[]: bad array subscript`);
    return invalidTarget(`${name}[]`, 'badSubscript', '');
  }
  if (operation === 'arithmeticWrite' && rawSubText === '') {
    return {
      kind: 'invalid',
      raw: `${name}[]`,
      emptyArithmeticWrite: true,
      failure: { ok: false, reason: 'invalidIdentifier', message: `\`${name}[]': not a valid identifier` },
    };
  }
  const resolved = intent === 'visible' ? resolveTargetName(shell, name, operation !== 'testSet') : name;
  if (resolved === undefined) return undefined;
  if (!isIdentifier(resolved)) {
    return invalidTarget(resolved, 'invalidIdentifier', `\`${resolved}': not a valid identifier`);
  }
  if (forMutation) rejectSpecialVariableMutation(resolved, false);
  const isAssoc = shell.store.isAssociativeName(resolved);
  if ((rawSubText === '@' || rawSubText === '*') && !(operation === 'unset' && isAssoc)) {
    return resolveWholeArraySubscript(shell, name, resolved, rawSubText, operation);
  }
  if (isAssoc) return resolveAssociativeSubscript(shell, opts, resolved, rawSubText, forWrite);
  return resolveIndexedSubscript(shell, opts, resolved, rawSubText, forWrite);
}

function resolveWholeArraySubscript(
  shell: Shell,
  reportedName: string,
  resolved: string,
  rawSubText: '@' | '*',
  operation: TargetOperation
): ResolvedTarget {
  if (operation === 'write') {
    return invalidTarget(
      `${reportedName}[${rawSubText}]`,
      'badSubscript',
      `${reportedName}[${rawSubText}]: bad array subscript`
    );
  }
  if (operation === 'arithmeticRead' || operation === 'arithmeticWrite') {
    if (operation === 'arithmeticRead') shell.reportError(`${resolved}[${rawSubText}]: bad array subscript`);
    return invalidTarget(
      `${reportedName}[${rawSubText}]`,
      'badSubscript',
      `${reportedName}[${rawSubText}]: bad array subscript`
    );
  }
  const own = shell.store.ownView(resolved);
  if (!own && shell.store.isUnreadHostEnv(resolved)) throw new UnsupportedFeatureError(`環境変数（${resolved}）`);
  return {
    kind: 'wholeArray',
    name: resolved,
    reportedName,
    ...(own?.handle ? { cell: own.handle } : {}),
    star: rawSubText === '*',
    isDynamic: !own && shell.store.isDynamic(resolved),
  };
}

function resolveAssociativeSubscript(
  shell: Shell,
  opts: SubscriptTargetOptions,
  resolved: string,
  rawSubText: string,
  forWrite: boolean
): ResolvedTarget {
  const key = expandAssociativeSubscript(shell, opts.subscript);
  if (key === '') {
    const label =
      opts.operation === 'unset'
        ? `[${rawSubText}]`
        : opts.operation === 'testSet'
          ? resolved
          : `${opts.name}[${rawSubText}]`;
    if (opts.operation === 'arithmeticRead') shell.reportError(`${opts.name}[${rawSubText}]: bad array subscript`);
    return invalidTarget(`${opts.name}[${rawSubText}]`, 'badSubscript', `${label}: bad array subscript`);
  }
  const own = shell.store.ownView(resolved);
  const cell =
    own?.handle ??
    (forWrite
      ? shell.store.selectDestination(opts.intent ?? 'visible', resolved, 'associative', Boolean(opts.append)).cell
      : undefined);
  if (!cell) {
    return invalidTarget(`${opts.name}[${rawSubText}]`, 'badSubscript', `${resolved}: bad array subscript`);
  }
  return { kind: 'associativeElement', name: resolved, reportedName: opts.name, cell, key };
}

function resolveIndexedSubscript(
  shell: Shell,
  opts: SubscriptTargetOptions,
  resolved: string,
  rawSubText: string,
  forWrite: boolean
): ResolvedTarget {
  if (rawSubText === '') return emptyIndexedSubscriptTarget(shell, opts.name, resolved, opts.operation);
  if (!shell.store.ownView(resolved) && shell.store.isUnreadHostEnv(resolved)) {
    throw new UnsupportedFeatureError(`環境変数（${resolved}）`);
  }
  const expanded = expandIndexedSubscript(shell, opts.subscript);
  const normalized = expanded === '' ? '0' : expanded;
  const rawIndex = shell.evaluateFatalReadonly(normalized, true);
  const index = rawIndex >= 0n ? rawIndex : shell.store.translateNegativeIndex(resolved, rawIndex, forWrite);
  if (index === undefined) {
    if (opts.operation === 'arithmeticRead') shell.reportError(`${resolved}: bad array subscript`);
    const label = formatBadIndexedLabel(opts.name, resolved, rawSubText, normalized, opts.operation);
    return invalidTarget(`${opts.name}[${rawSubText}]`, 'badSubscript', `${label}: bad array subscript`);
  }
  const own = shell.store.ownView(resolved);
  const cell = forWrite
    ? (own?.handle ??
      shell.store.selectDestination(opts.intent ?? 'visible', resolved, undefined, Boolean(opts.append)).cell)
    : own?.handle;
  return {
    kind: 'indexedElement',
    name: resolved,
    reportedName: opts.name,
    ...(cell ? { cell } : {}),
    index,
    isDynamic: !own && shell.store.isDynamic(resolved),
  };
}

function emptyIndexedSubscriptTarget(
  shell: Shell,
  writtenName: string,
  resolved: string,
  operation: TargetOperation
): ResolvedTarget {
  if (operation === 'unset' && !shell.store.ownView(resolved) && shell.store.isUnreadHostEnv(resolved)) {
    throw new UnsupportedFeatureError(`環境変数（${resolved}）`);
  }
  const label = operation === 'unset' ? '[]' : operation === 'testSet' ? resolved : `${writtenName}[]`;
  return invalidTarget(`${writtenName}[]`, 'badSubscript', `${label}: bad array subscript`);
}

function formatBadIndexedLabel(
  writtenName: string,
  resolvedName: string,
  rawSubText: string,
  evaluatedSub: string,
  operation: TargetOperation
): string {
  if (operation === 'unset') return `[${rawSubText}]`;
  if (operation === 'read' || operation === 'testSet') return resolvedName;
  if (operation === 'arithmeticRead' || operation === 'arithmeticWrite') return `${writtenName}[${rawSubText}]`;
  return `${resolvedName}[${evaluatedSub}]`;
}

function rawSubscriptText(input: SubscriptInput): string {
  return input.kind === 'word' ? input.word.text : input.text;
}

function expandAssociativeSubscript(shell: Shell, input: SubscriptInput): string {
  if (input.kind === 'word') return shell.expander.expandAssociativeKey(input.word);
  return input.preExpanded ? input.text : shell.expander.expandSubscriptText(input.text);
}

function expandIndexedSubscript(shell: Shell, input: SubscriptInput): string {
  if (input.kind === 'word') return shell.expander.expandSubscriptString(input.word);
  return input.preExpanded ? input.text : shell.expander.expandSubscriptText(input.text);
}

function invalidTarget(raw: string, reason: StoreFailure['reason'], message: string): ResolvedTarget {
  return { kind: 'invalid', raw, failure: { ok: false, reason, message } };
}

// ---------------------------------------------------------------- target operations

export function readResolvedTarget(shell: Shell, target: ResolvedTarget): string | undefined {
  switch (target.kind) {
    case 'scalar': {
      return shell.store.readScalar(target.name, (c) => shell.reportError(`warning: ${c}: circular name reference`));
    }
    case 'associativeElement': {
      return shell.store.readAssociativeElement(target.cell, target.key);
    }
    case 'indexedElement': {
      return shell.store.readIndexedElement(target.name, target.index);
    }
    case 'wholeArray':
    case 'randomSeed':
    case 'invalid': {
      return undefined;
    }
  }
}

export function writeResolvedTarget(shell: Shell, target: ResolvedTarget, value: string, append = false): StoreOutcome {
  const evalInt = (expr: string): bigint => shell.evaluateFatalReadonly(expr, false);
  switch (target.kind) {
    case 'randomSeed': {
      const seed = shell.tryEvaluate(value, undefined);
      if (seed !== undefined) shell.store.seedRandom(seed);
      return { ok: true, stored: value };
    }
    case 'scalar': {
      rejectSpecialVariableMutation(target.name, false);
      const cell = target.cell ?? shell.store.selectDestination('visible', target.name, undefined, append).cell;
      return shell.store.writeScalar(cell, value, append, evalInt, target.name);
    }
    case 'associativeElement': {
      rejectSpecialVariableMutation(target.name, false);
      return shell.store.writeAssociativeElement(target.cell, target.key, value, append, evalInt, target.name);
    }
    case 'indexedElement': {
      rejectSpecialVariableMutation(target.name, false);
      const cell = target.cell ?? shell.store.selectDestination('visible', target.name, undefined, append).cell;
      return shell.store.writeIndexedElement(cell, target.index, value, append, evalInt, target.name);
    }
    case 'wholeArray': {
      return {
        ok: false,
        reason: 'cannotAssign',
        message: `${target.reportedName}[${target.star ? '*' : '@'}]: cannot assign in this way`,
      };
    }
    case 'invalid': {
      return target.failure;
    }
  }
}

export function unsetResolvedElement(shell: Shell, target: ResolvedTarget): StoreFailure | undefined {
  if (target.kind === 'invalid') return target.failure;
  if (target.kind === 'associativeElement') {
    return shell.store.unsetElement(target.cell, { kind: 'associative', key: target.key }, target.name);
  }
  if (target.kind === 'wholeArray') {
    if (!target.cell) return undefined;
    return shell.store.unsetElement(target.cell, { kind: 'wholeArray' }, target.name);
  }
  if (target.kind === 'indexedElement') {
    if (!target.cell) return undefined;
    return shell.store.unsetElement(target.cell, { kind: 'indexed', index: target.index }, target.name);
  }
  return undefined;
}

export function isResolvedTargetSet(shell: Shell, target: ResolvedTarget): boolean {
  if (target.kind === 'invalid') {
    if (target.failure.message !== '') shell.reportError(target.failure.message);
    return false;
  }
  if (target.kind === 'wholeArray') {
    return shell.store.readArrayValues(target.name).length > 0;
  }
  if (target.kind === 'scalar') {
    const own: VariableView | undefined = shell.store.ownView(target.name);
    if (own?.attributes.has('n')) return false;
    return shell.store.readScalar(target.name) !== undefined;
  }
  return readResolvedTarget(shell, target) !== undefined;
}
