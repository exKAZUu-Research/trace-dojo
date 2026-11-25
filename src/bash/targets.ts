import type { Word } from './ast';
import {
  rejectDynamicSubscriptSyntax,
  rejectUnsupportedVariableMutation,
  rejectUnsupportedVariableRead,
} from './capabilities';
import type { StoreFailure, StoreOutcome } from './failurePolicy';
import type { Shell } from './shell';
import { type DestinationIntent, isIdentifier, type VariableView } from './variables';

export type ResolvedTarget =
  | { readonly kind: 'randomSeed' }
  | {
      readonly kind: 'scalar';
      readonly name: string;
      readonly reportedName: string;
      readonly intent: DestinationIntent;
      readonly isDynamic: boolean;
    }
  | {
      readonly kind: 'associativeElement';
      readonly name: string;
      readonly reportedName: string;
      readonly intent: DestinationIntent;
      readonly key: string;
    }
  | {
      readonly kind: 'indexedElement';
      readonly name: string;
      readonly reportedName: string;
      readonly intent: DestinationIntent;
      readonly index: bigint;
      readonly isDynamic: boolean;
    }
  | {
      readonly kind: 'wholeArray';
      readonly name: string;
      readonly reportedName: string;
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
  | { readonly kind: 'word'; readonly word: Word; readonly unquoteAnsiC?: boolean }
  | { readonly kind: 'text'; readonly text: string; readonly preExpanded?: boolean };

export type TargetOperation = 'read' | 'write' | 'unset' | 'testSet' | 'arithmeticRead' | 'arithmeticWrite';

export interface SubscriptTargetOptions {
  readonly name: string;
  readonly subscript: SubscriptInput;
  readonly operation: TargetOperation;
  readonly intent?: DestinationIntent;
  readonly append?: boolean;
}

/** Resolves single-hop whole-variable namerefs through `VariableStore`. */
export function resolveTargetName(shell: Shell, name: string): string {
  return shell.store.resolveTargetName(name);
}

/** Resolves an unsubscripted variable target without mutating `VariableStore`. */
export function resolveScalarTarget(
  shell: Shell,
  name: string,
  forWrite: boolean,
  options?: { intent?: DestinationIntent; append?: boolean }
): ResolvedTarget {
  const intent = options?.intent ?? 'visible';
  const append = options?.append ?? false;
  if (!isIdentifier(name)) {
    return invalidTarget(name, 'invalidIdentifier', `\`${name}': not a valid identifier`);
  }
  if (forWrite && intent !== 'visible') {
    rejectUnsupportedVariableMutation(name, false);
    return { kind: 'scalar', name, reportedName: name, intent, isDynamic: false };
  }
  const resolved = resolveTargetName(shell, name);
  if (!isIdentifier(resolved)) {
    return invalidTarget(resolved, 'invalidIdentifier', `\`${resolved}': not a valid identifier`);
  }
  if (forWrite) {
    rejectUnsupportedVariableMutation(resolved, !append);
    if (resolved === 'RANDOM' && !shell.store.ownView('RANDOM')) return { kind: 'randomSeed' };
    return { kind: 'scalar', name: resolved, reportedName: name, intent: 'visible', isDynamic: false };
  }
  rejectUnsupportedVariableRead(resolved);
  const view = shell.store.ownView(resolved);
  return {
    kind: 'scalar',
    name: resolved,
    reportedName: name,
    intent: 'visible',
    isDynamic: !view && shell.store.isDynamic(resolved),
  };
}

/**
 * Resolves a subscripted variable target once across assignments, arithmetic, expansions, builtins, and tests
 * without creating cells before write commit.
 */
export function resolveSubscriptTarget(shell: Shell, opts: SubscriptTargetOptions): ResolvedTarget {
  const { name, subscript, operation } = opts;
  const intent = opts.intent ?? 'visible';
  const rawSubText = rawSubscriptText(subscript);
  if (!isIdentifier(name)) {
    return invalidTarget(`${name}[${rawSubText}]`, 'invalidIdentifier', `\`${name}': not a valid identifier`);
  }
  const emptyArith = rawSubText === '' ? emptyArithmeticSubscriptTarget(shell, name, operation) : undefined;
  if (emptyArith) return emptyArith;
  const resolved = intent === 'visible' ? resolveTargetName(shell, name) : name;
  if (!isIdentifier(resolved)) {
    return invalidTarget(resolved, 'invalidIdentifier', `\`${resolved}': not a valid identifier`);
  }
  const forWrite = operation === 'write' || operation === 'arithmeticWrite';
  if (forWrite || operation === 'unset') rejectUnsupportedVariableMutation(resolved, false);
  else rejectUnsupportedVariableRead(resolved);
  const isAssoc = shell.store.isAssociativeName(resolved);
  if (!isAssoc && (rawSubText === '@' || rawSubText === '*')) {
    return resolveWholeArraySubscript(shell, name, resolved, rawSubText, operation);
  }
  return isAssoc
    ? resolveAssociativeSubscript(shell, opts, resolved, rawSubText, forWrite)
    : resolveIndexedSubscript(shell, opts, resolved, rawSubText, forWrite);
}

function emptyArithmeticSubscriptTarget(
  shell: Shell,
  name: string,
  operation: TargetOperation
): ResolvedTarget | undefined {
  if (operation === 'arithmeticRead') {
    shell.reportError(`${name}[]: bad array subscript`);
    shell.reportError(`${name}[]: bad array subscript`);
    return invalidTarget(`${name}[]`, 'badSubscript', '');
  }
  if (operation === 'arithmeticWrite') {
    return {
      kind: 'invalid',
      raw: `${name}[]`,
      emptyArithmeticWrite: true,
      failure: { ok: false, reason: 'invalidIdentifier', message: `\`${name}[]': not a valid identifier` },
    };
  }
  return undefined;
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
  return {
    kind: 'wholeArray',
    name: resolved,
    reportedName,
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
  if (!own && !forWrite) {
    return invalidTarget(`${opts.name}[${rawSubText}]`, 'badSubscript', `${resolved}: bad array subscript`);
  }
  return {
    kind: 'associativeElement',
    name: resolved,
    reportedName: opts.name,
    intent: opts.intent ?? 'visible',
    key,
  };
}

function resolveIndexedSubscript(
  shell: Shell,
  opts: SubscriptTargetOptions,
  resolved: string,
  rawSubText: string,
  forWrite: boolean
): ResolvedTarget {
  if (rawSubText === '') return emptyIndexedSubscriptTarget(opts.name, resolved, opts.operation);
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
  return {
    kind: 'indexedElement',
    name: resolved,
    reportedName: opts.name,
    intent: opts.intent ?? 'visible',
    index,
    isDynamic: !own && shell.store.isDynamic(resolved),
  };
}

function emptyIndexedSubscriptTarget(
  writtenName: string,
  resolved: string,
  operation: TargetOperation
): ResolvedTarget {
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
  if (input.preExpanded) return unquoteArithmeticAssociativeKey(input.text);
  rejectDynamicSubscriptSyntax(input.text);
  return input.text;
}

function expandIndexedSubscript(shell: Shell, input: SubscriptInput): string {
  if (input.kind === 'word') return shell.expander.expandSubscriptString(input.word, Boolean(input.unquoteAnsiC));
  if (input.preExpanded) return input.text;
  rejectDynamicSubscriptSyntax(input.text);
  return input.text;
}

/** Strips source-written `'...'` and `\x` escapes from a pre-expanded arithmetic associative subscript. */
function unquoteArithmeticAssociativeKey(raw: string): string {
  let out = '';
  let inSingle = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else out += c;
    } else if (c === "'") {
      inSingle = true;
    } else if (c === '\\' && i + 1 < raw.length) {
      const next = raw[++i];
      if (next !== '\n') out += next;
    } else {
      out += c;
    }
  }
  return out;
}

function invalidTarget(raw: string, reason: StoreFailure['reason'], message: string): ResolvedTarget {
  return { kind: 'invalid', raw, failure: { ok: false, reason, message } };
}

// ---------------------------------------------------------------- target operations

export function readResolvedTarget(shell: Shell, target: ResolvedTarget): string | undefined {
  switch (target.kind) {
    case 'scalar': {
      return shell.store.readScalar(target.name);
    }
    case 'associativeElement': {
      return shell.store.readAssociativeElement(target.name, target.key);
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

export function writeResolvedTarget(
  shell: Shell,
  target: ResolvedTarget,
  value: string,
  append = false,
  builtinPrefix?: string
): StoreOutcome {
  const evalInt = (expr: string): bigint => shell.evaluateFatalReadonly(expr, false, builtinPrefix);
  switch (target.kind) {
    case 'randomSeed': {
      const seed = shell.tryEvaluate(value, undefined);
      if (seed !== undefined) shell.store.seedRandom(seed);
      return { ok: true, stored: value };
    }
    case 'scalar': {
      return shell.store.writeScalarNamed(target.name, value, {
        intent: target.intent,
        append,
        evalInt,
        reportedName: target.name,
      });
    }
    case 'associativeElement': {
      return shell.store.writeAssociativeElementNamed(target.name, target.key, value, {
        intent: target.intent,
        append,
        evalInt,
        reportedName: target.name,
      });
    }
    case 'indexedElement': {
      return shell.store.writeIndexedElementNamed(target.name, target.index, value, {
        intent: target.intent,
        append,
        evalInt,
        reportedName: target.name,
      });
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
    return shell.store.unsetElementNamed(target.name, { kind: 'associative', key: target.key }, target.name);
  }
  if (target.kind === 'wholeArray') {
    return shell.store.unsetElementNamed(target.name, { kind: 'wholeArray' }, target.name);
  }
  if (target.kind === 'indexedElement') {
    return shell.store.unsetElementNamed(target.name, { kind: 'indexed', index: target.index }, target.name);
  }
  return undefined;
}

export function isResolvedTargetSet(shell: Shell, target: ResolvedTarget): boolean {
  if (target.kind === 'invalid') {
    if (target.failure.message !== '') shell.reportError(target.failure.message);
    return false;
  }
  if (target.kind === 'wholeArray') {
    return shell.store.readArrayLength(target.name) > 0;
  }
  if (target.kind === 'scalar') {
    const own: VariableView | undefined = shell.store.ownView(target.name);
    if (own?.attributes.has('n')) return false;
    return shell.store.readScalar(target.name) !== undefined;
  }
  return readResolvedTarget(shell, target) !== undefined;
}
