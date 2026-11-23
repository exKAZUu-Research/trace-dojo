import type { Runtime } from '../runtime';
import { coreTypes, interfaceType, makeNullable } from '../types';
import { DartList, DartObject, type Value } from '../values';
import { BoundedStringParts, detachShorterString, stringSlice } from './boundedStringParts';
import { newSet } from './nativeCollections';
import { define, defineConstructor, index, intArg, listElement, listLength, named, stringArg } from './nativeSupport';

/** A match of a pattern: where it is and the texts of its groups. */
export interface MatchState {
  start: number;
  end: number;
  /** The texts of the groups by their numbers, when the match keeps them. */
  groups?: RegExpExecArray;
  input: string;
  pattern: Value;
}

interface RegExpState {
  source: string;
  multiLine: boolean;
  caseSensitive: boolean;
  unicode: boolean;
  dotAll: boolean;
  /** The host expression that searches from its `lastIndex`. */
  search: RegExp;
  /** The host expression that matches only at its `lastIndex`. */
  sticky: RegExp;
  groupCount: number;
  /** The group names, in the order they first appear. */
  names: readonly string[];
  values(): Iterable<Value>;
}

function stateOf(value: Value): RegExpState {
  return (value as DartObject).native as unknown as RegExpState;
}

export function isRegExp(runtime: Runtime, value: Value): boolean {
  return value instanceof DartObject && value.cls === runtime.links.classNamed('_RegExp');
}

defineConstructor('RegExp.new', (runtime, _instance, args) => {
  const source = stringArg(runtime, args.positional[0], 'source');
  const multiLine = named(args.named, 'multiLine', false) === true;
  const caseSensitive = named(args.named, 'caseSensitive', true) !== false;
  const unicode = named(args.named, 'unicode', false) === true;
  const dotAll = named(args.named, 'dotAll', false) === true;
  // The VM caches regular expressions, so equal sources and flags give the identical object.
  const flags = `${multiLine ? 'm' : ''}${caseSensitive ? '' : 'i'}${unicode ? 'u' : ''}${dotAll ? 's' : ''}`;
  const key = `${flags}/${source}`;
  let cache = regExpCaches.get(runtime);
  if (!cache) {
    cache = new Map();
    regExpCaches.set(runtime, cache);
  }
  const cached = cache.get(key);
  if (cached) return cached;
  const object = new DartObject(runtime.links.classNamed('_RegExp'), [], []);
  object.native = { source, multiLine, caseSensitive, unicode, dotAll, ...compile(runtime, source, flags) };
  cache.set(key, object);
  return object;
});

function compile(
  runtime: Runtime,
  source: string,
  flags: string
): Pick<RegExpState, 'search' | 'sticky' | 'groupCount' | 'names' | 'values'> {
  // The host compiles without interruption, so reserve its work before entering it.
  runtime.spend(1 + 32 * source.length);
  let search: RegExp;
  let groups: RegExpExecArray;
  try {
    search = new RegExp(source, `${flags}g`);
    // The empty alternative matches the empty text whatever the pattern is, which reveals the pattern's groups.
    groups = new RegExp(`${source}|`, flags).exec('') as RegExpExecArray;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // The VM's engine words its syntax errors as V8 does, after this prefix; other hosts word them their own way.
    const message = error.message.replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, '');
    return runtime.throwError('FormatException', '', [message, source]);
  }
  runtime.budget.checkClock();
  const groupCount = groups.length - 1;
  runtime.allocate(1 + source.length + 2 * groupCount);
  return {
    search,
    sticky: new RegExp(source, `${flags}y`),
    groupCount,
    names: Object.keys(groups.groups ?? {}),
    values: () => [],
  };
}

const regExpCaches = new WeakMap<Runtime, Map<string, DartObject>>();

/** The first match at `start` (`sticky`) or after it, keeping the texts of its groups when `capture`. */
function execAt(
  runtime: Runtime,
  state: RegExpState,
  input: string,
  start: number,
  sticky: boolean,
  capture = false
): MatchState | undefined {
  const regExp = sticky ? state.sticky : state.search;
  regExp.lastIndex = start;
  const found = regExp.exec(input);
  const end = found ? found.index + found[0].length : input.length;
  // A failed sticky match tried one position only, while a failed search went through the rest of the text.
  const scanned = found || !sticky ? end - start : 0;
  runtime.spend(1 + Math.ceil(Math.max(0, scanned) / CODE_UNITS_PER_OPERATION));
  runtime.budget.checkClock();
  if (!found) return undefined;
  if (capture) runtime.allocate(2 * state.groupCount);
  return { start: found.index, end, groups: capture ? found : undefined, input, pattern: undefined };
}

/** Code units of the text a match scans that cost one operation. */
const CODE_UNITS_PER_OPERATION = 8;

/** Every match of a regular expression, after an empty match moving on by one, as Dart does. */
export function* allMatchesOf(
  runtime: Runtime,
  pattern: Value,
  input: string,
  start: number
): IterableIterator<MatchState> {
  const state = stateOf(pattern);
  let position = start;
  while (position <= input.length) {
    const match = execAt(runtime, state, input, position, false, true);
    if (!match) break;
    match.pattern = pattern;
    runtime.spend();
    yield match;
    // After an empty match the search moves on by a character, a code point in Unicode mode.
    position =
      match.end === match.start
        ? match.end + (state.unicode && isSurrogatePairAt(input, match.end) ? 2 : 1)
        : match.end;
  }
}

export function isSurrogatePairAt(input: string, position: number): boolean {
  if (position < 0 || position + 1 >= input.length) return false;
  // oxlint-disable-next-line unicorn/prefer-code-point -- Surrogates are UTF-16 code units.
  const high = input.charCodeAt(position);
  // oxlint-disable-next-line unicorn/prefer-code-point -- Surrogates are UTF-16 code units.
  const low = input.charCodeAt(position + 1);
  return high >= 0xd8_00 && high <= 0xdb_ff && low >= 0xdc_00 && low <= 0xdf_ff;
}

export function patternIndex(runtime: Runtime, pattern: Value, input: string, position: number): number {
  if (typeof pattern === 'string') return input.indexOf(pattern, position);
  if (isRegExp(runtime, pattern)) {
    const match = execAt(runtime, stateOf(pattern), input, position, false);
    return match ? Math.max(position, match.start) : -1;
  }
  for (let at = position; at <= input.length; at++) {
    if (hasPrefixMatch(runtime, pattern, input, at)) return at;
  }
  return -1;
}

export function hasPrefixMatch(runtime: Runtime, pattern: Value, input: string, position: number): boolean {
  if (typeof pattern === 'string') return input.startsWith(pattern, position);
  if (isRegExp(runtime, pattern)) return execAt(runtime, stateOf(pattern), input, position, true) !== undefined;
  runtime.spend();
  return (
    runtime.invoke(
      pattern,
      'matchAsPrefix',
      { positional: [input, BigInt(position)], named: undefined },
      [],
      undefined
    ) !== undefined
  );
}

export function newMatch(runtime: Runtime, state: MatchState): DartObject {
  runtime.allocate(1);
  const object = new DartObject(runtime.links.classNamed('_RegExpMatch'), [], []);
  object.native = { ...state, values: () => [state.pattern] } as unknown as DartObject['native'];
  return object;
}

export function matchText(runtime: Runtime, state: MatchState, group = 0): string | undefined {
  if (group === 0) {
    runtime.spend(Math.ceil((state.end - state.start) / 1024));
    return stringSlice(runtime, state.input, state.start, state.end);
  }
  const text = state.groups?.[group];
  if (text === undefined) return undefined;
  runtime.spend(Math.ceil(text.length / 1024));
  return detachShorterString(runtime, state.input, text);
}

function matchState(value: Value): MatchState {
  return (value as DartObject).native as unknown as MatchState;
}

define('RegExp.escape', (runtime, _receiver, [text]) => {
  const result = new BoundedStringParts(runtime);
  result.appendEscaped(stringArg(runtime, text, 'text'), /[$()*+.?[\\\]^{|}]/g, (character) => '\\' + character);
  return result.text();
});
define('RegExp.firstMatch', (runtime, receiver, [input]) => {
  const match = execAt(runtime, stateOf(receiver), stringArg(runtime, input, 'input'), 0, false, true);
  if (!match) return;
  match.pattern = receiver;
  return newMatch(runtime, match);
});
define('RegExp.allMatches', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'input');
  const at = matchStart(runtime, start, text.length);
  const iterable = new DartObject(runtime.links.classNamed('_AllMatchesIterable'), [], []);
  iterable.native = { pattern: receiver, text, start: at, values: () => [receiver] };
  return iterable;
});

define('_AllMatchesIterable.iterator', (runtime, receiver) => {
  const { pattern, text, start } = (receiver as DartObject).native as unknown as {
    pattern: Value;
    text: string;
    start: number;
  };
  const iterator = new DartObject(runtime.links.classNamed('_RegExpMatchIterator'), [], []);
  const state: RegExpMatchIterator = {
    matches: allMatchesOf(runtime, pattern, text, start),
    current: undefined,
    values: () => [pattern, state.current],
  };
  iterator.native = state;
  return iterator;
});

interface RegExpMatchIterator {
  [key: string]: unknown;
  matches: IterableIterator<MatchState>;
  current: DartObject | undefined;
  values(): Iterable<Value>;
}

define('_RegExpMatchIterator.moveNext', (runtime, receiver) => {
  const state = (receiver as DartObject).native as RegExpMatchIterator;
  const next = state.matches.next();
  state.current = next.done ? undefined : newMatch(runtime, next.value);
  return !next.done;
});
define('_RegExpMatchIterator.current', (runtime, receiver) => {
  const { current } = (receiver as DartObject).native as RegExpMatchIterator;
  if (!current) runtime.throwTypeError('Null check operator used on a null value');
  return current;
});
define('RegExp.matchAsPrefix', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'string');
  const at = matchStart(runtime, start, text.length);
  const match = execAt(runtime, stateOf(receiver), text, at, true, true);
  if (!match) return;
  match.pattern = receiver;
  return newMatch(runtime, match);
});

function matchStart(runtime: Runtime, value: Value, length: number): number {
  const start = intArg(runtime, value, 'start');
  if (start < 0n || start > BigInt(length)) runtime.throwError('RangeError', 'range', [start, 0n, BigInt(length)]);
  return index(start);
}

define(
  'RegExp.hasMatch',
  (runtime, receiver, [input]) =>
    execAt(runtime, stateOf(receiver), stringArg(runtime, input, 'input'), 0, false) !== undefined
);
define('RegExp.stringMatch', (runtime, receiver, [input]) => {
  const match = execAt(runtime, stateOf(receiver), stringArg(runtime, input, 'input'), 0, false);
  return match ? matchText(runtime, match) : undefined;
});
define('RegExp.pattern', (_runtime, receiver) => stateOf(receiver).source);
define('RegExp.isMultiLine', (_runtime, receiver) => stateOf(receiver).multiLine);
define('RegExp.isCaseSensitive', (_runtime, receiver) => stateOf(receiver).caseSensitive);
define('RegExp.isUnicode', (_runtime, receiver) => stateOf(receiver).unicode);
define('RegExp.isDotAll', (_runtime, receiver) => stateOf(receiver).dotAll);

define('RegExp.toString', (runtime, receiver) => {
  const output = new BoundedStringParts(runtime);
  appendRegExpDescription(output, receiver);
  return output.text();
});

export function appendRegExpDescription(output: BoundedStringParts, receiver: Value): void {
  const { source, caseSensitive, multiLine, dotAll, unicode } = stateOf(receiver);
  output.append('RegExp: pattern=');
  output.appendVmCString(source);
  output.append(` flags=${caseSensitive ? '' : 'i'}${multiLine ? 'm' : ''}${dotAll ? 's' : ''}${unicode ? 'u' : ''}`);
}

function group(runtime: Runtime, receiver: Value, which: Value): Value {
  const state = matchState(receiver);
  const at = intArg(runtime, which, 'group');
  if (at < 0n || at > BigInt(stateOf(state.pattern).groupCount)) runtime.throwError('RangeError', 'value', [at]);
  return matchText(runtime, state, index(at));
}

define('RegExpMatch.start', (_runtime, receiver) => BigInt(matchState(receiver).start));
define('RegExpMatch.end', (_runtime, receiver) => BigInt(matchState(receiver).end));
define('RegExpMatch.group', (runtime, receiver, [which]) => group(runtime, receiver, which));
define('RegExpMatch.[]', (runtime, receiver, [which]) => group(runtime, receiver, which));
define('RegExpMatch.groups', (runtime, receiver, [indices]) => {
  const frame = runtime.currentFrame;
  frame?.temporaries.push(indices);
  try {
    const length = listLength(runtime, indices);
    if (length < 0n) runtime.throwError('RangeError', 'value', [length, 'length']);
    runtime.allocate(Number(length) + 1);
    const groups: Value[] = Array.from({ length: Number(length) });
    for (let position = 0n; position < listLength(runtime, indices); position++) {
      runtime.spend();
      const value = group(runtime, receiver, listElement(runtime, indices, position));
      if (position >= length) runtime.throwError('RangeError', 'range', [position, 0n, length - 1n, 'index']);
      groups[Number(position)] = value;
    }
    return new DartList(coreTypes.list, makeNullable(interfaceType(coreTypes.string)), groups, false);
  } finally {
    frame?.temporaries.pop();
  }
});
define('RegExpMatch.groupCount', (_runtime, receiver) => BigInt(stateOf(matchState(receiver).pattern).groupCount));
define('RegExpMatch.input', (_runtime, receiver) => matchState(receiver).input);
define('RegExpMatch.pattern', (_runtime, receiver) => matchState(receiver).pattern);
define('RegExpMatch.namedGroup', (runtime, receiver, [name]) => {
  const state = matchState(receiver);
  const key = stringArg(runtime, name, 'name');
  if (!stateOf(state.pattern).names.includes(key)) {
    return runtime.throwError('ArgumentError', '', [`Not a capture group name: ${key}`]);
  }
  // Of the groups sharing a name, the host reports the one that took part in the match.
  const text = state.groups?.groups?.[key];
  if (text === undefined) return;
  runtime.spend(1 + Math.ceil(text.length / 1024));
  return detachShorterString(runtime, state.input, text);
});
define('RegExpMatch.groupNames', (runtime, receiver) => {
  const { names } = stateOf(matchState(receiver).pattern);
  const stringType = interfaceType(coreTypes.string);
  if (names.length === 0) {
    return runtime.links.canonicalize(runtime, new DartList(coreTypes.list, stringType, [], false, true));
  }
  runtime.allocate(1);
  const result = newSet(runtime, stringType);
  for (const name of names) {
    runtime.invoke(result, 'add', { positional: [name], named: undefined }, [], undefined);
  }
  return result;
});
