import { quoteForError } from '../format';
import type { Runtime } from '../runtime';
import { coreTypes, interfaceType, makeNullable } from '../types';
import { type DartList, DartObject, type Value } from '../values';
import { define, defineConstructor, index, intArg, named, newList, stringArg } from './nativeSupport';

/** A match of a pattern: where it is and the texts of its groups. */
export interface MatchState {
  start: number;
  end: number;
  groups: (string | undefined)[];
  names: Record<string, string | undefined> | undefined;
  input: string;
  pattern: Value;
  /** The match object a pattern of the program returned, used as is. */
  object?: Value;
}

interface RegExpState {
  source: string;
  multiLine: boolean;
  caseSensitive: boolean;
  unicode: boolean;
  dotAll: boolean;
  regex: RegExp;
  values(): Iterable<Value>;
}

function stateOf(value: Value): RegExpState {
  return (value as DartObject).native as unknown as RegExpState;
}

export function isRegExp(value: Value): boolean {
  return value instanceof DartObject && (value.native as { regex?: RegExp } | undefined)?.regex instanceof RegExp;
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
  let regex: RegExp;
  try {
    regex = new RegExp(
      source,
      `g${multiLine ? 'm' : ''}${caseSensitive ? '' : 'i'}${unicode ? 'u' : ''}${dotAll ? 's' : ''}d`
    );
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const reason = error.message.replace(/^Invalid regular expression: (\/.*\/[a-z]*: )?/, '');
    return runtime.throwError('FormatException', '', [IRREGEXP_MESSAGES[reason] ?? reason, source]);
  }
  const object = new DartObject(runtime.links.classNamed('_RegExp'), [], []);
  object.native = { source, multiLine, caseSensitive, unicode, dotAll, regex, values: () => [] };
  cache.set(key, object);
  return object;
});

const regExpCaches = new WeakMap<Runtime, Map<string, DartObject>>();

function execAt(state: RegExpState, input: string, start: number, sticky: boolean): MatchState | undefined {
  const regex = new RegExp(state.regex.source, state.regex.flags.replace('g', '') + (sticky ? 'y' : 'g'));
  regex.lastIndex = start;
  const found = regex.exec(input);
  if (!found) return undefined;
  return {
    start: found.index,
    end: found.index + found[0].length,
    groups: [...found],
    names: found.groups ? { ...found.groups } : undefined,
    input,
    pattern: undefined,
  };
}

/** Every match of a regular expression, after an empty match moving on by one, as Dart does. */
export function allMatchesOf(runtime: Runtime, pattern: Value, input: string, start: number): MatchState[] {
  const state = stateOf(pattern);
  const matches: MatchState[] = [];
  let position = start;
  while (position <= input.length) {
    const match = execAt(state, input, position, false);
    if (!match) break;
    match.pattern = pattern;
    matches.push(match);
    runtime.spend();
    position = match.end === match.start ? match.end + 1 : match.end;
  }
  return matches;
}

/** A match of a pattern at a position (`anchored`) or anywhere after it. */
// code-gauge-allow functionCognitiveComplexity 17 -- A transcription of the SDK's algorithm, case by case.
export function matchAt(
  runtime: Runtime,
  pattern: Value,
  input: string,
  position: number,
  anchored: boolean
): MatchState | undefined {
  if (typeof pattern === 'string') {
    const found = anchored ? (input.startsWith(pattern, position) ? position : -1) : input.indexOf(pattern, position);
    return found < 0
      ? undefined
      : { start: found, end: found + pattern.length, groups: [pattern], names: undefined, input, pattern };
  }
  if (isRegExp(pattern)) {
    const match = execAt(stateOf(pattern), input, position, anchored);
    if (match) match.pattern = pattern;
    return match;
  }
  if (anchored) {
    const match = runtime.invoke(
      pattern,
      'matchAsPrefix',
      { positional: [input, BigInt(position)], named: undefined },
      [],
      undefined
    );
    if (match === undefined) return undefined;
    return {
      start: Number(runtime.getProperty(match, 'start', undefined)),
      end: Number(runtime.getProperty(match, 'end', undefined)),
      groups: [],
      names: undefined,
      input,
      pattern,
      object: match,
    };
  }
  for (let at = position; at <= input.length; at++) {
    const match = matchAt(runtime, pattern, input, at, true);
    if (match) return match;
  }
  return undefined;
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
  const match = execAt(stateOf(receiver), stringArg(runtime, input, 'input'), 0, false);
  if (!match) return;
  match.pattern = receiver;
  return newMatch(runtime, match);
});
define('RegExp.allMatches', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'input');
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length))
    runtime.throwError('RangeError', 'range', [at, 0n, BigInt(text.length), 'start']);
  const matches = allMatchesOf(runtime, receiver, text, index(at)).map((match) => newMatch(runtime, match));
  const list = newList(runtime, interfaceType(runtime.links.classNamed('RegExpMatch')), matches, false);
  return runtime.links.construct(runtime, '_AllMatchesIterable', '_', [list]);
});
define('RegExp.matchAsPrefix', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'string');
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length))
    runtime.throwError('RangeError', 'range', [at, 0n, BigInt(text.length), 'start']);
  const match = execAt(stateOf(receiver), text, index(at), true);
  if (!match) return;
  match.pattern = receiver;
  return newMatch(runtime, match);
});
define(
  'RegExp.hasMatch',
  (runtime, receiver, [input]) => execAt(stateOf(receiver), stringArg(runtime, input, 'input'), 0, false) !== undefined
);
define(
  'RegExp.stringMatch',
  (runtime, receiver, [input]) => execAt(stateOf(receiver), stringArg(runtime, input, 'input'), 0, false)?.groups[0]
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
  'nothing to repeat': 'Nothing to repeat',
  'missing terminating ] for character class': 'Unterminated character class',
  'duplicate group specifier name': 'Duplicate capture group name',
  'invalid \\k<> named backreference': 'Invalid named capture referenced',
  'range out of order in character class': 'Range out of order in character class',
  'invalid group specifier name': 'Invalid capture group name',
};

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
  const list = indices as DartList;
  return newList(
    runtime,
    makeNullable(interfaceType(coreTypes.string)),
    list.elements.map((which) => group(runtime, receiver, which))
  );
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
