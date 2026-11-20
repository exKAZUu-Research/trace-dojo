import { quoteForError } from '../format';
import type { Runtime } from '../runtime';
import { coreTypes, interfaceType, makeNullable } from '../types';
import { DartList, DartObject, type Value } from '../values';
import {
  define,
  defineConstructor,
  index,
  intArg,
  listElement,
  listLength,
  named,
  newList,
  stringArg,
} from './nativeSupport';
import { type CompiledRegExp, compileRegExp, execRegExp, isSurrogatePairAt } from './regExpEngine';

/** A match of a pattern: where it is and the texts of its groups. */
export interface MatchState {
  start: number;
  end: number;
  groups: (string | undefined)[];
  names: Record<string, string | undefined> | undefined;
  input: string;
  pattern: Value;
}

interface RegExpState {
  source: string;
  multiLine: boolean;
  caseSensitive: boolean;
  unicode: boolean;
  dotAll: boolean;
  compiled: CompiledRegExp;
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
  const key = `${multiLine ? 'm' : ''}${caseSensitive ? '' : 'i'}${unicode ? 'u' : ''}${dotAll ? 's' : ''}/${source}`;
  let cache = regExpCaches.get(runtime);
  if (!cache) {
    cache = new Map();
    regExpCaches.set(runtime, cache);
  }
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    // Only to report syntax errors: matching runs on the interpreter's own engine, which the budget can stop.
    new RegExp(source, `${multiLine ? 'm' : ''}${caseSensitive ? '' : 'i'}${unicode ? 'u' : ''}${dotAll ? 's' : ''}`);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return runtime.throwError('FormatException', '', [regExpSyntaxMessage(error.message, source), source]);
  }
  const object = new DartObject(runtime.links.classNamed('_RegExp'), [], []);
  const compiled = compileRegExp(source, { multiLine, ignoreCase: !caseSensitive, unicode, dotAll });
  object.native = { source, multiLine, caseSensitive, unicode, dotAll, compiled, values: () => [] };
  cache.set(key, object);
  return object;
});

const regExpCaches = new WeakMap<Runtime, Map<string, DartObject>>();

function execAt(
  runtime: Runtime,
  state: RegExpState,
  input: string,
  start: number,
  sticky: boolean
): MatchState | undefined {
  let steps = 0;
  const found = execRegExp(state.compiled, input, start, sticky, () => {
    if (++steps % STEPS_PER_OPERATION === 0) runtime.spend();
  });
  if (!found) return undefined;
  let names: Record<string, string | undefined> | undefined;
  if (state.compiled.names.size > 0) {
    names = Object.create(null) as Record<string, string | undefined>;
    for (const [name, numbers] of state.compiled.names) {
      names[name] = numbers.map((number) => found.groups[number]).find((text) => text !== undefined);
    }
  }
  return { start: found.start, end: found.end, groups: found.groups, names, input, pattern: undefined };
}

/** Matcher steps that cost one operation, a rate at which ordinary patterns stay well within the budget. */
const STEPS_PER_OPERATION = 8;

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
    const match = execAt(runtime, state, input, position, false);
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

export function patternIndex(runtime: Runtime, pattern: Value, input: string, position: number): number {
  if (typeof pattern === 'string') return input.indexOf(pattern, position);
  if (isRegExp(runtime, pattern)) return execAt(runtime, stateOf(pattern), input, position, false)?.start ?? -1;
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
  const object = new DartObject(runtime.links.classNamed('_RegExpMatch'), [], []);
  object.native = { ...state, values: () => [] } as unknown as DartObject['native'];
  return object;
}

function matchState(value: Value): MatchState {
  return (value as DartObject).native as unknown as MatchState;
}

define('RegExp.escape', (runtime, _receiver, [text]) =>
  stringArg(runtime, text, 'text').replaceAll(/[$()*+./?[\\\]^{|}-]/g, String.raw`\$&`)
);
define('RegExp.firstMatch', (runtime, receiver, [input]) => {
  const match = execAt(runtime, stateOf(receiver), stringArg(runtime, input, 'input'), 0, false);
  if (!match) return;
  match.pattern = receiver;
  return newMatch(runtime, match);
});
define('RegExp.allMatches', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'input');
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length))
    runtime.throwError('RangeError', 'range', [at, 0n, BigInt(text.length), 'start']);
  const iterable = new DartObject(runtime.links.classNamed('_AllMatchesIterable'), [], []);
  iterable.native = { pattern: receiver, text, start: index(at), values: () => [receiver] };
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
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length))
    runtime.throwError('RangeError', 'range', [at, 0n, BigInt(text.length), 'start']);
  const match = execAt(runtime, stateOf(receiver), text, index(at), true);
  if (!match) return;
  match.pattern = receiver;
  return newMatch(runtime, match);
});
define(
  'RegExp.hasMatch',
  (runtime, receiver, [input]) =>
    execAt(runtime, stateOf(receiver), stringArg(runtime, input, 'input'), 0, false) !== undefined
);
define(
  'RegExp.stringMatch',
  (runtime, receiver, [input]) =>
    execAt(runtime, stateOf(receiver), stringArg(runtime, input, 'input'), 0, false)?.groups[0]
);
define('RegExp.pattern', (_runtime, receiver) => stateOf(receiver).source);
define('RegExp.isMultiLine', (_runtime, receiver) => stateOf(receiver).multiLine);
define('RegExp.isCaseSensitive', (_runtime, receiver) => stateOf(receiver).caseSensitive);
define('RegExp.isUnicode', (_runtime, receiver) => stateOf(receiver).unicode);
define('RegExp.isDotAll', (_runtime, receiver) => stateOf(receiver).dotAll);
/** The VM's regular expression engine (Irregexp) words its syntax errors differently from the host's. */
const IRREGEXP_MESSAGES: Record<string, string> = {
  'missing )': 'Unterminated group',
  'unmatched parentheses': "Unmatched ')'",
  'missing terminating ] for character class': 'Unterminated character class',
  'duplicate group specifier name': 'Duplicate capture group name',
  'invalid \\k<> named backreference': 'Invalid named capture referenced',
  'range out of order in character class': 'Range out of order in character class',
  'invalid group specifier name': 'Invalid capture group name',
  'unrecognized character after (?': 'Invalid group',
  'invalid Unicode \\u escape': 'Invalid Unicode escape',
  'invalid Unicode code point \\u{} escape': 'Invalid Unicode escape',
  'invalid \\c escape for Unicode pattern': 'Invalid Unicode escape',
  'invalid range in character class for Unicode pattern': 'Invalid character class',
  'invalid octal escape for Unicode pattern': 'Invalid decimal escape',
  'invalid backreference for Unicode pattern': 'Invalid escape',
  'incomplete {} quantifier for Unicode pattern': 'Incomplete quantifier',
  'unmatched ] or } bracket for Unicode pattern': 'Lone quantifier brackets',
};

function regExpSyntaxMessage(message: string, source: string): string {
  const reason = message.replace(/^Invalid regular expression: (\/[\s\S]*\/[a-z]*: )?/, '');
  switch (reason) {
    case 'invalid property expression': {
      return propertyEscapeError(source);
    }
    case 'invalid escaped character for Unicode pattern': {
      for (const match of source.matchAll(/\\[\s\S]/g)) {
        const end = match.index + match[0].length;
        if (match[0] === String.raw`\c` && !/[a-z]/i.test(source[end] ?? '')) return 'Invalid Unicode escape';
        if (match[0] === String.raw`\k` && source[end] === '<' && !source.includes('>', end + 1))
          return 'Invalid capture group name';
      }
      return 'Invalid escape';
    }
    case 'nothing to repeat': {
      return hasQuantifiedLookAhead(source) ? 'Invalid quantifier' : 'Nothing to repeat';
    }
    default: {
      return IRREGEXP_MESSAGES[reason] ?? reason;
    }
  }
}

function propertyEscapeError(source: string): string {
  let inClass = false;
  for (const [token] of source.matchAll(/\\(?:[pP]\{[^}]*\}|[\s\S])|[[\]]/g)) {
    if (token === '[') inClass = true;
    else if (token === ']') inClass = false;
    else if (token.startsWith(String.raw`\p`) || token.startsWith(String.raw`\P`)) {
      try {
        new RegExp(token, 'u');
      } catch {
        return inClass ? 'Invalid property name in character class' : 'Invalid property name';
      }
    }
  }
  return 'Invalid property name';
}

function hasQuantifiedLookAhead(source: string): boolean {
  let inClass = false;
  const groups: boolean[] = [];
  for (const match of source.matchAll(/\\[\s\S]|\(\?[=!]|[()[\]]/g)) {
    const [token] = match;
    if (token === '[') inClass = true;
    else if (token === ']') inClass = false;
    else if (!inClass && token.startsWith('(')) groups.push(token.length > 1);
    else if (
      !inClass &&
      token === ')' &&
      groups.pop() &&
      /^[*+?]|^\{\d+(?:,\d*)?\}/.test(source.slice(match.index + 1))
    )
      return true;
  }
  return false;
}

define(
  'RegExp.toString',
  (_runtime, receiver) =>
    `RegExp: pattern=${stateOf(receiver).source} flags=${stateOf(receiver).caseSensitive ? '' : 'i'}${stateOf(receiver).multiLine ? 'm' : ''}${stateOf(receiver).dotAll ? 's' : ''}${stateOf(receiver).unicode ? 'u' : ''}`
);

function group(runtime: Runtime, receiver: Value, which: Value): Value {
  const state = matchState(receiver);
  const at = intArg(runtime, which, 'group');
  if (at < 0n || at >= BigInt(state.groups.length)) runtime.throwError('RangeError', 'value', [at]);
  return state.groups[index(at)];
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
define('RegExpMatch.groupCount', (_runtime, receiver) => BigInt(matchState(receiver).groups.length - 1));
define('RegExpMatch.input', (_runtime, receiver) => matchState(receiver).input);
define('RegExpMatch.pattern', (_runtime, receiver) => matchState(receiver).pattern);
define('RegExpMatch.namedGroup', (runtime, receiver, [name]) => {
  const state = matchState(receiver);
  const key = stringArg(runtime, name, 'name');
  const { names } = state;
  if (!names || !(key in names)) return runtime.throwError('ArgumentError', '', [`Not a capture group name: ${key}`]);
  return names[key];
});
define('RegExpMatch.groupNames', (runtime, receiver) =>
  newList(runtime, interfaceType(coreTypes.string), Object.keys(matchState(receiver).names ?? {}), false)
);

export { quoteForError };
