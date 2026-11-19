// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { defineNatives, type NativeCall } from '../natives';
import type { NativeState } from '../runtime';
import { CsObject, type Value } from '../values';
import { type EnumerableState, LibraryEnumerator } from './iteration';
import { evaluatorOf, failNull, failOutOfRange, libraryType, newArray, unsupportedCall } from './support';

const NAMESPACE = 'System.Text.RegularExpressions';

const OPTION = {
  ignoreCase: 1,
  multiline: 2,
  explicitCapture: 4,
  singleline: 16,
  ignorePatternWhitespace: 32,
  rightToLeft: 64,
  ecmaScript: 256,
  nonBacktracking: 1024,
} as const;

/** .NET's word characters, which `\w` and `\b` mean in every culture. */
const WORD = String.raw`\p{L}\p{Mn}\p{Nd}\p{Pc}`;
const SPACE = String.raw`\f\n\r\t\v\x85\p{Z}`;
const END = String.raw`(?![\s\S])`;
const START = String.raw`(?<![\s\S])`;

/** A pattern rewritten into a JavaScript regular expression that matches what .NET's would. */
interface CompiledPattern {
  pattern: string;
  options: number;
  regex: RegExp;
  /** The .NET number of each JavaScript capture group, by its index. */
  numberOfIndex: number[];
  /** The group names in .NET's order of numbers: unnamed groups first, then named ones. */
  names: string[];
}

class UnsupportedPattern extends Error {}

/**
 * Rewrites a .NET pattern for JavaScript's `u` mode, translating what the two read differently: `.`, `^`, `$`, and
 * the character classes, which .NET defines over Unicode, and the group numbers, which .NET gives unnamed groups first.
 */
function compilePattern(pattern: string, options: number): CompiledPattern {
  if (options & (OPTION.rightToLeft | OPTION.ecmaScript | OPTION.nonBacktracking)) throw new UnsupportedPattern();
  const ignoreWhitespace = (options & OPTION.ignorePatternWhitespace) !== 0;
  const multiline = (options & OPTION.multiline) !== 0;
  const groups: { name: string | undefined }[] = [];
  let output = '';
  let inClass = false;
  let index = 0;
  const next = (): string => pattern[index++] ?? '';
  while (index < pattern.length) {
    const char = next();
    if (inClass) {
      if (char === ']') inClass = false;
      if (char === '[' && pattern[index] === ':') throw new UnsupportedPattern();
      if (char === '-' && pattern[index] === '[') throw new UnsupportedPattern();
      output +=
        char === '\\'
          ? escapeOf(
              next(),
              true,
              pattern,
              () => index,
              (value) => (index = value)
            )
          : char;
      continue;
    }
    if (ignoreWhitespace && /\s/.test(char)) continue;
    if (ignoreWhitespace && char === '#') {
      while (index < pattern.length && pattern[index] !== '\n') index++;
      continue;
    }
    switch (char) {
      case '\\': {
        output += escapeOf(
          next(),
          false,
          pattern,
          () => index,
          (value) => (index = value)
        );
        break;
      }
      case '[': {
        inClass = true;
        output += '[';
        if (pattern[index] === '^') output += next();
        // A `]` that opens a class is a member of it in .NET.
        if (pattern[index] === ']') {
          next();
          output += String.raw`\]`;
        }
        break;
      }
      case '.': {
        output += options & OPTION.singleline ? String.raw`[\s\S]` : String.raw`[^\n]`;
        break;
      }
      case '^': {
        output += multiline ? String.raw`(?:${START}|(?<=\n))` : START;
        break;
      }
      case '$': {
        output += multiline ? String.raw`(?=\n|${END})` : String.raw`(?=\n?${END})`;
        break;
      }
      case '(': {
        output += groupOpening();
        break;
      }
      case '{': {
        const quantifier = /^\d+(?:,\d*)?\}/.exec(pattern.slice(index));
        output += quantifier ? `{${quantifier[0]}` : String.raw`\{`;
        if (quantifier) index += quantifier[0].length;
        break;
      }
      case '}':
      case ']': {
        output += `\\${char}`;
        break;
      }
      default: {
        output += char;
      }
    }
  }
  const numbered = numberGroups(groups);
  const finalPattern = output.replaceAll(/(\d+)/g, (_match, number: string) => {
    const jsIndex = numbered.numberOfIndex.indexOf(Number(number));
    if (jsIndex === -1) throw new UnsupportedPattern();
    return `\\${jsIndex}`;
  });
  let regex: RegExp;
  try {
    regex = new RegExp(finalPattern, `dgu${options & OPTION.ignoreCase ? 'i' : ''}`);
  } catch {
    throw new UnsupportedPattern();
  }
  return { pattern, options, regex, ...numbered };

  function groupOpening(): string {
    if (pattern[index] !== '?') {
      if (options & OPTION.explicitCapture) return '(?:';
      groups.push({ name: undefined });
      return '(';
    }
    const rest = pattern.slice(index + 1);
    const named = /^(?:<([A-Za-z_]\w*)>|'([A-Za-z_]\w*)')/.exec(rest);
    if (named) {
      const name = named[1] ?? named[2];
      if (groups.some((group) => group.name === name)) throw new UnsupportedPattern();
      groups.push({ name });
      index += 1 + named[0].length;
      return `(?<${name}>`;
    }
    for (const opening of ['?:', '?=', '?!', '?<=', '?<!']) {
      if (pattern.startsWith(opening, index)) {
        index += opening.length;
        return `(${opening}`;
      }
    }
    if (pattern.startsWith('?#', index)) {
      const close = pattern.indexOf(')', index);
      if (close === -1) throw new UnsupportedPattern();
      index = close + 1;
      return '';
    }
    // Atomic groups, conditionals, balancing groups, and inline options have no JavaScript equivalent.
    throw new UnsupportedPattern();
  }
}

function numberGroups(groups: { name: string | undefined }[]): Pick<CompiledPattern, 'numberOfIndex' | 'names'> {
  const unnamedCount = groups.filter((group) => group.name === undefined).length;
  const names = ['0', ...Array.from({ length: unnamedCount }, (_, offset) => String(offset + 1))];
  const numberOfIndex = [0];
  let unnamed = 0;
  let named = 0;
  for (const group of groups) {
    if (group.name === undefined) {
      unnamed++;
      numberOfIndex.push(unnamed);
    } else {
      named++;
      numberOfIndex.push(unnamedCount + named);
      names.push(group.name);
    }
  }
  return { numberOfIndex, names };
}

function escapeOf(
  char: string,
  inClass: boolean,
  pattern: string,
  position: () => number,
  move: (index: number) => void
): string {
  switch (char) {
    case 'd': {
      return String.raw`\p{Nd}`;
    }
    case 'D': {
      return String.raw`\P{Nd}`;
    }
    case 'w': {
      return inClass ? WORD : `[${WORD}]`;
    }
    case 'W': {
      if (inClass) throw new UnsupportedPattern();
      return `[^${WORD}]`;
    }
    case 's': {
      return inClass ? SPACE : `[${SPACE}]`;
    }
    case 'S': {
      if (inClass) throw new UnsupportedPattern();
      return `[^${SPACE}]`;
    }
    case 'b': {
      if (inClass) return String.raw`\x08`;
      return `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
    }
    case 'B': {
      return `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
    }
    case 'A': {
      return START;
    }
    case 'z': {
      return END;
    }
    case 'Z': {
      return String.raw`(?=\n?${END})`;
    }
    case 'e': {
      return String.raw`\x1B`;
    }
    case 'k': {
      const name = /^<([A-Za-z_]\w*)>/.exec(pattern.slice(position()));
      if (!name) throw new UnsupportedPattern();
      move(position() + name[0].length);
      return String.raw`\k${name[0]}`;
    }
    case 'p':
    case 'P': {
      const category = /^\{([A-Z][a-z]?)\}/.exec(pattern.slice(position()));
      if (!category) throw new UnsupportedPattern();
      move(position() + category[0].length);
      return `\\${char}${category[0]}`;
    }
    case 'x':
    case 'u':
    case 'c':
    case 't':
    case 'n':
    case 'r':
    case 'f':
    case 'v': {
      return `\\${char}`;
    }
    default: {
      if (/\d/.test(char) && !inClass && char !== '0') {
        const digits = /^\d*/.exec(pattern.slice(position()))?.[0] ?? '';
        move(position() + digits.length);
        return `${char}${digits}`;
      }
      if (/[A-Za-z\d]/.test(char) || char === '') throw new UnsupportedPattern();
      return String.raw`\u{${char.charCodeAt(0).toString(16)}}`;
    }
  }
}

// ---- Matching ----

interface GroupResult {
  number: number;
  name: string;
  success: boolean;
  index: number;
  length: number;
  value: string;
}

class GroupState implements NativeState {
  constructor(readonly group: GroupResult) {}

  references(): Value[] {
    return [];
  }
}

class MatchState extends GroupState {
  groupObjects: CsObject[] | undefined;

  constructor(
    group: GroupResult,
    readonly groups: GroupResult[],
    readonly compiled: CompiledPattern | undefined,
    readonly input: string,
    /** Where the next match starts, past an empty match as .NET moves on. */
    readonly nextStart: number
  ) {
    super(group);
  }
}

class MatchListState implements EnumerableState {
  constructor(readonly matches: CsObject[]) {}

  enumerate(): Iterable<Value> {
    return this.matches;
  }

  references(): Value[] {
    return this.matches;
  }
}

const compiledPatterns = new Map<string, CompiledPattern>();

function patternOf(call: NativeCall, pattern: Value, options: Value = 0): CompiledPattern {
  if (pattern === undefined) failNull('pattern');
  const key = `${options as number}:${pattern as string}`;
  let compiled = compiledPatterns.get(key);
  if (!compiled) {
    try {
      compiled = compilePattern(pattern as string, options as number);
    } catch (error) {
      if (error instanceof UnsupportedPattern) unsupportedCall(call, `正規表現のパターン「${pattern as string}」`);
      throw error;
    }
    compiledPatterns.set(key, compiled);
  }
  return compiled;
}

function regexOf(value: Value): CompiledPattern {
  return (value as CsObject).native as CompiledPattern;
}

function inputOf(value: Value): string {
  if (value === undefined) failNull('input');
  return value as string;
}

function findMatch(call: NativeCall, compiled: CompiledPattern, input: string, start: number): CsObject {
  compiled.regex.lastIndex = start;
  const found = compiled.regex.exec(input);
  if (!found) return emptyMatch(call);
  const groups: GroupResult[] = Array.from({ length: compiled.names.length });
  for (const [jsIndex, number] of compiled.numberOfIndex.entries()) {
    const span = found.indices?.[jsIndex];
    groups[number] = {
      number,
      name: compiled.names[number],
      success: span !== undefined,
      index: span?.[0] ?? 0,
      length: span ? span[1] - span[0] : 0,
      value: found[jsIndex] ?? '',
    };
  }
  const whole = groups[0];
  const nextStart = whole.length === 0 ? whole.index + 1 : whole.index + whole.length;
  const match = new CsObject(libraryType(call, `${NAMESPACE}.Match`), []);
  match.native = new MatchState(whole, groups, compiled, input, nextStart);
  return match;
}

function emptyMatch(call: NativeCall): CsObject {
  const match = new CsObject(libraryType(call, `${NAMESPACE}.Match`), []);
  const group: GroupResult = { number: 0, name: '0', success: false, index: 0, length: 0, value: '' };
  match.native = new MatchState(group, [group], undefined, '', 0);
  return match;
}

function allMatches(call: NativeCall, compiled: CompiledPattern, input: string, start = 0): CsObject[] {
  const matches: CsObject[] = [];
  for (let position = start; position <= input.length;) {
    const match = findMatch(call, compiled, input, position);
    const state = match.native as MatchState;
    if (!state.group.success) break;
    matches.push(match);
    position = state.nextStart;
  }
  call.frame.runtime.allocateSlots(matches.length);
  return matches;
}

function matchStateOf(value: Value): MatchState {
  if (value === undefined) failNull('match');
  return (value as CsObject).native as MatchState;
}

function groupOf(value: Value): GroupResult {
  if (value === undefined) failNull('group');
  return ((value as CsObject).native as GroupState).group;
}

function groupObjectsOf(call: NativeCall, state: MatchState, match: CsObject): CsObject[] {
  state.groupObjects ??= state.groups.map((group, number) => {
    if (number === 0) return match;
    const object = new CsObject(libraryType(call, `${NAMESPACE}.Group`), []);
    object.native = new GroupState(group);
    return object;
  });
  return state.groupObjects;
}

function missingGroup(call: NativeCall): CsObject {
  const object = new CsObject(libraryType(call, `${NAMESPACE}.Group`), []);
  object.native = new GroupState({ number: -1, name: '', success: false, index: 0, length: 0, value: '' });
  return object;
}

/** Expands a replacement pattern's substitutions (`$1`, `${name}`, `$&`, ...) for a match, as .NET does. */
function substitute(replacement: string, state: MatchState): string {
  const groupValue = (number: number): string => state.groups[number]?.value ?? '';
  const whole = state.group;
  let result = '';
  for (let index = 0; index < replacement.length; index++) {
    const char = replacement[index];
    if (char !== '$' || index + 1 >= replacement.length) {
      result += char;
      continue;
    }
    const rest = replacement.slice(index + 1);
    const digits = /^\d+/.exec(rest)?.[0];
    if (digits) {
      // .NET takes the longest prefix of the digits that names a group.
      let length = digits.length;
      while (length > 0 && Number(digits.slice(0, length)) >= state.groups.length) length--;
      if (length > 0) {
        result += groupValue(Number(digits.slice(0, length)));
        index += length;
        continue;
      }
      result += char;
      continue;
    }
    const braced = /^\{(\w+)\}/.exec(rest);
    if (braced) {
      const name = braced[1];
      const number = /^\d+$/.test(name) ? Number(name) : (state.compiled?.names.indexOf(name) ?? -1);
      if (number >= 0 && number < state.groups.length) {
        result += groupValue(number);
        index += braced[0].length;
        continue;
      }
      result += char;
      continue;
    }
    const special = rest[0];
    const replaced: Record<string, () => string> = {
      $: () => '$',
      '&': () => whole.value,
      '`': () => state.input.slice(0, whole.index),
      "'": () => state.input.slice(whole.index + whole.length),
      '+': () => groupValue(state.groups.length - 1),
      _: () => state.input,
    };
    const expand = replaced[special];
    if (expand) {
      result += expand();
      index++;
    } else result += char;
  }
  return result;
}

function replaceMatches(
  call: NativeCall,
  compiled: CompiledPattern,
  input: string,
  replace: (match: CsObject, state: MatchState) => string,
  count = -1
): string {
  if (count < -1) failOutOfRange(call, 'count', 'Count cannot be less than -1.', String(count));
  if (count === 0) return input;
  let result = '';
  let position = 0;
  let replaced = 0;
  for (const match of allMatches(call, compiled, input)) {
    const state = match.native as MatchState;
    result += input.slice(position, state.group.index) + replace(match, state);
    position = state.group.index + state.group.length;
    if (++replaced === count) break;
  }
  return result + input.slice(position);
}

function split(call: NativeCall, compiled: CompiledPattern, input: string): Value {
  const parts: string[] = [];
  let position = 0;
  for (const match of allMatches(call, compiled, input)) {
    const state = match.native as MatchState;
    parts.push(input.slice(position, state.group.index));
    position = state.group.index + state.group.length;
    for (const group of state.groups.slice(1)) if (group.success) parts.push(group.value);
  }
  parts.push(input.slice(position));
  return newArray(call, stringType(call), parts);
}

const stringType = (call: NativeCall): ReturnType<typeof libraryType> => libraryType(call, 'System.String');

function replacementOf(value: Value): string {
  if (value === undefined) failNull('replacement');
  return value as string;
}

function evaluate(call: NativeCall, evaluator: Value, match: CsObject): string {
  if (evaluator === undefined) failNull('evaluator');
  const result = evaluatorOf(call).invokeDelegate(call.frame, evaluator, [match], call.row);
  return (result as string | undefined) ?? '';
}

function newMatchCollection(call: NativeCall, matches: CsObject[]): CsObject {
  const collection = new CsObject(libraryType(call, `${NAMESPACE}.MatchCollection`), []);
  collection.native = new MatchListState(matches);
  return collection;
}

const REGEX = `${NAMESPACE}.Regex`;

defineNatives({
  [`${REGEX}..ctor(string)`]: (call, receiver, [pattern]) => {
    (receiver as CsObject).native = patternOf(call, pattern as Value);
    return;
  },
  [`${REGEX}..ctor(string, RegexOptions)`]: (call, receiver, [pattern, options]) => {
    (receiver as CsObject).native = patternOf(call, pattern as Value, options as Value);
    return;
  },
  [`${REGEX}.get_Options`]: (_call, receiver) => regexOf(receiver).options,
  [`${REGEX}.ToString`]: (_call, receiver) => regexOf(receiver).pattern,
  [`${REGEX}.GetGroupNames`]: (call, receiver) => newArray(call, stringType(call), [...regexOf(receiver).names]),
  [`${REGEX}.IsMatch(string)`]: (call, receiver, [input]) =>
    groupOf(findMatch(call, regexOf(receiver), inputOf(input as Value), 0)).success,
  [`${REGEX}.Match(string)`]: (call, receiver, [input]) =>
    findMatch(call, regexOf(receiver), inputOf(input as Value), 0),
  [`${REGEX}.Match(string, int)`]: (call, receiver, [input, start]) => {
    const text = inputOf(input as Value);
    if ((start as number) < 0 || (start as number) > text.length) {
      failOutOfRange(call, 'startat', 'Start index cannot be less than 0 or greater than input length.', String(start));
    }
    return findMatch(call, regexOf(receiver), text, start as number);
  },
  [`${REGEX}.Matches(string)`]: (call, receiver, [input]) =>
    newMatchCollection(call, allMatches(call, regexOf(receiver), inputOf(input as Value))),
  [`${REGEX}.Replace(string, string)`]: (call, receiver, [input, replacement]) => {
    const text = replacementOf(replacement as Value);
    return replaceMatches(call, regexOf(receiver), inputOf(input as Value), (_match, state) => substitute(text, state));
  },
  [`${REGEX}.Replace(string, string, int)`]: (call, receiver, [input, replacement, count]) => {
    const text = replacementOf(replacement as Value);
    return replaceMatches(
      call,
      regexOf(receiver),
      inputOf(input as Value),
      (_match, state) => substitute(text, state),
      count as number
    );
  },
  [`${REGEX}.Replace(string, MatchEvaluator)`]: (call, receiver, [input, evaluator]) =>
    replaceMatches(call, regexOf(receiver), inputOf(input as Value), (match) =>
      evaluate(call, evaluator as Value, match)
    ),
  [`${REGEX}.Split(string)`]: (call, receiver, [input]) => split(call, regexOf(receiver), inputOf(input as Value)),
  [`${REGEX}.IsMatch(string, string)`]: (call, _receiver, [input, pattern]) =>
    groupOf(findMatch(call, patternOf(call, pattern as Value), inputOf(input as Value), 0)).success,
  [`${REGEX}.IsMatch(string, string, RegexOptions)`]: (call, _receiver, [input, pattern, options]) =>
    groupOf(findMatch(call, patternOf(call, pattern as Value, options as Value), inputOf(input as Value), 0)).success,
  [`${REGEX}.Match(string, string)`]: (call, _receiver, [input, pattern]) =>
    findMatch(call, patternOf(call, pattern as Value), inputOf(input as Value), 0),
  [`${REGEX}.Match(string, string, RegexOptions)`]: (call, _receiver, [input, pattern, options]) =>
    findMatch(call, patternOf(call, pattern as Value, options as Value), inputOf(input as Value), 0),
  [`${REGEX}.Matches(string, string)`]: (call, _receiver, [input, pattern]) =>
    newMatchCollection(call, allMatches(call, patternOf(call, pattern as Value), inputOf(input as Value))),
  [`${REGEX}.Matches(string, string, RegexOptions)`]: (call, _receiver, [input, pattern, options]) =>
    newMatchCollection(
      call,
      allMatches(call, patternOf(call, pattern as Value, options as Value), inputOf(input as Value))
    ),
  [`${REGEX}.Replace(string, string, string)`]: (call, _receiver, [input, pattern, replacement]) => {
    const text = replacementOf(replacement as Value);
    return replaceMatches(call, patternOf(call, pattern as Value), inputOf(input as Value), (_match, state) =>
      substitute(text, state)
    );
  },
  [`${REGEX}.Replace(string, string, string, RegexOptions)`]: (
    call,
    _receiver,
    [input, pattern, replacement, options]
  ) => {
    const text = replacementOf(replacement as Value);
    return replaceMatches(
      call,
      patternOf(call, pattern as Value, options as Value),
      inputOf(input as Value),
      (_match, state) => substitute(text, state)
    );
  },
  [`${REGEX}.Replace(string, string, MatchEvaluator)`]: (call, _receiver, [input, pattern, evaluator]) =>
    replaceMatches(call, patternOf(call, pattern as Value), inputOf(input as Value), (match) =>
      evaluate(call, evaluator as Value, match)
    ),
  [`${REGEX}.Split(string, string)`]: (call, _receiver, [input, pattern]) =>
    split(call, patternOf(call, pattern as Value), inputOf(input as Value)),
  [`${REGEX}.Split(string, string, RegexOptions)`]: (call, _receiver, [input, pattern, options]) =>
    split(call, patternOf(call, pattern as Value, options as Value), inputOf(input as Value)),
  [`${REGEX}.Escape`]: (_call, _receiver, [text]) => {
    if (text === undefined) failNull('str');
    return (text as string).replaceAll(/[\\*+?|{[()^$.# \t\n\r\f]/g, (char) => {
      const named: Record<string, string> = {
        ' ': String.raw`\ `,
        '\t': String.raw`\t`,
        '\n': String.raw`\n`,
        '\r': String.raw`\r`,
        '\f': String.raw`\f`,
      };
      return named[char] ?? `\\${char}`;
    });
  },
  [`${REGEX}.Unescape`]: (_call, _receiver, [text]) => {
    if (text === undefined) failNull('str');
    const named: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      f: '\f',
      v: '\v',
      a: '\u0007',
      e: '\u001B',
      b: '\b',
    };
    return (text as string).replaceAll(/\\(.)/gs, (_match, char: string) => named[char] ?? char);
  },
  [`${NAMESPACE}.Capture.get_Index`]: (_call, receiver) => groupOf(receiver).index,
  [`${NAMESPACE}.Capture.get_Length`]: (_call, receiver) => groupOf(receiver).length,
  [`${NAMESPACE}.Capture.get_Value`]: (_call, receiver) => groupOf(receiver).value,
  [`${NAMESPACE}.Capture.ToString`]: (_call, receiver) => groupOf(receiver).value,
  [`${NAMESPACE}.Group.get_Success`]: (_call, receiver) => groupOf(receiver).success,
  [`${NAMESPACE}.Group.get_Name`]: (_call, receiver) => groupOf(receiver).name,
  [`${NAMESPACE}.Match.get_Empty`]: (call) => emptyMatch(call),
  [`${NAMESPACE}.Match.get_Groups`]: (call, receiver) => {
    const collection = new CsObject(libraryType(call, `${NAMESPACE}.GroupCollection`), []);
    collection.native = new MatchListState(groupObjectsOf(call, matchStateOf(receiver), receiver as CsObject));
    return collection;
  },
  [`${NAMESPACE}.Match.NextMatch`]: (call, receiver) => {
    const state = matchStateOf(receiver);
    if (!state.compiled || state.nextStart > state.input.length) return emptyMatch(call);
    return findMatch(call, state.compiled, state.input, state.nextStart);
  },
  [`${NAMESPACE}.Match.Result`]: (_call, receiver, [replacement]) =>
    substitute(replacementOf(replacement as Value), matchStateOf(receiver)),
  [`${NAMESPACE}.MatchCollection.get_Count`]: (_call, receiver) => listOf(receiver).length,
  [`${NAMESPACE}.MatchCollection.get_IsReadOnly`]: () => true,
  [`${NAMESPACE}.MatchCollection.get_Item`]: (call, receiver, [index]) =>
    itemAt(call, listOf(receiver), index as number),
  [`${NAMESPACE}.MatchCollection.GetEnumerator`]: (call, receiver) =>
    enumeratorOf(call, `${NAMESPACE}.Match`, receiver),
  [`${NAMESPACE}.GroupCollection.get_Count`]: (_call, receiver) => listOf(receiver).length,
  [`${NAMESPACE}.GroupCollection.get_IsReadOnly`]: () => true,
  [`${NAMESPACE}.GroupCollection.get_Item(int)`]: (call, receiver, [number]) =>
    listOf(receiver)[number as number] ?? missingGroup(call),
  [`${NAMESPACE}.GroupCollection.get_Item(string)`]: (call, receiver, [name]) =>
    listOf(receiver).find((group) => groupOf(group).name === name) ?? missingGroup(call),
  [`${NAMESPACE}.GroupCollection.GetEnumerator`]: (call, receiver) =>
    enumeratorOf(call, `${NAMESPACE}.Group`, receiver),
});

function listOf(value: Value): CsObject[] {
  if (value === undefined) failNull('collection');
  return ((value as CsObject).native as MatchListState).matches;
}

function itemAt(call: NativeCall, items: CsObject[], index: number): CsObject {
  if (index < 0 || index >= items.length) {
    failOutOfRange(
      call,
      'i',
      'Index was out of range. Must be non-negative and less than the size of the collection.',
      String(index)
    );
  }
  return items[index];
}

function enumeratorOf(call: NativeCall, elementName: string, collection: Value): CsObject {
  const enumerator = new CsObject(
    libraryType(call, 'System.Linq.Internal.Enumerator', [libraryType(call, elementName)]),
    []
  );
  enumerator.native = new LibraryEnumerator(listOf(collection)[Symbol.iterator](), [collection]);
  return enumerator;
}
