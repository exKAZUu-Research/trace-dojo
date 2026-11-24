// code-gauge-allow-file fileNcss -- The nativesRegex module keeps one stage of the C# interpreter together.
// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { MeteredText } from '../meteredText';
import { defineNatives, defineNativesKeepingStrings, type NativeCall } from '../natives';
import type { NativeState } from '../runtime';
import { CsObject, type CsString, freshString, plainString, stringText, type Value } from '../values';
import { type EnumerableState, LibraryEnumerator } from './iteration';
import { type CompiledRegExp, compileRegExp, execRegExp } from './regexEngine';
import { evaluatorOf, fail, failNull, failOutOfRange, libraryType, newArray, unsupportedCall } from './support';

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
  /** The rewritten pattern on a matcher that charges the run's budget, which the host's RegExp could not. */
  matcher: CompiledRegExp;
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
  const translator = new PatternTranslator(pattern, options);
  const output = translator.translate();
  const numbered = numberGroups(translator.groups);
  // Lookup tables keep a pattern with many groups and backreferences linear in its length.
  const jsIndexOfNumber = new Map(numbered.numberOfIndex.map((number, jsIndex) => [number, jsIndex]));
  const jsIndexOfName = new Map<string, number>();
  for (const [index, group] of translator.groups.entries())
    if (group.name !== undefined) jsIndexOfName.set(group.name, index + 1);
  const finalPattern = output
    .replaceAll(/(\d+)/g, (_match, number: string) => {
      const jsIndex = jsIndexOfNumber.get(Number(number));
      if (jsIndex === undefined) throw new UnsupportedPattern();
      return `\\${jsIndex}`;
    })
    .replaceAll(/(\w+)/g, (_match, name: string) => {
      const jsIndex = jsIndexOfName.get(name);
      if (jsIndex === undefined) throw new UnsupportedPattern();
      return `\\${jsIndex}`;
    });
  const ignoreCase = (options & OPTION.ignoreCase) !== 0;
  try {
    // The host's parser accepts or rejects the rewritten pattern first, as the matcher's parser expects.
    new RegExp(finalPattern, `u${ignoreCase ? 'i' : ''}`);
  } catch {
    throw new UnsupportedPattern();
  }
  const matcher = compileRegExp(finalPattern, {
    unicode: true,
    ignoreCase,
    multiLine: false,
    dotAll: false,
    codeUnits: true,
  });
  return { pattern, options, matcher, ...numbered };
}

/** The escapes that stand for a set of characters rather than one, after `\\`. */
const SET_ESCAPES = new Set(['w', 'W', 'd', 'D', 's', 'S', 'p', 'P']);

/** Translates a .NET pattern into JavaScript's syntax one construct at a time, recording its capture groups. */
class PatternTranslator {
  readonly groups: { name: string | undefined }[] = [];
  private readonly names = new Set<string>();
  private index = 0;
  private inClass = false;
  /** Whether the class item just translated is a set (`\w`, `\d`, `\s`, `\p{..}`), which a `-` cannot end a range at. */
  private isAfterClassSet = false;

  constructor(
    private readonly pattern: string,
    private readonly options: number
  ) {}

  translate(): string {
    let output = '';
    while (this.index < this.pattern.length) output += this.translateNext();
    return output;
  }

  private translateNext(): string {
    const char = this.next();
    if (this.inClass) return this.translateInClass(char);
    if (this.options & OPTION.ignorePatternWhitespace) {
      if (/\s/.test(char)) return '';
      if (char === '#') {
        while (this.index < this.pattern.length && this.pattern[this.index] !== '\n') this.index++;
        return '';
      }
    }
    return this.translateOutsideClass(char);
  }

  private translateInClass(char: string): string {
    if (char === ']') this.inClass = false;
    if (char === '[' && this.pattern[this.index] === ':') throw new UnsupportedPattern();
    if (char === '-' && this.pattern[this.index] === '[') throw new UnsupportedPattern();
    const isAfterSet = this.isAfterClassSet;
    this.isAfterClassSet = char === '\\' && SET_ESCAPES.has(this.pattern[this.index] ?? '');
    // .NET reads a `-` after a set as a literal, where JavaScript's `u` flag would reject the range.
    if (char === '-' && isAfterSet) return String.raw`\-`;
    return char === '\\' ? this.escape(true) : char;
  }

  private escape(inClass: boolean): string {
    return escapeOf(
      this.next(),
      inClass,
      this.pattern,
      () => this.index,
      (value) => (this.index = value)
    );
  }

  private translateOutsideClass(char: string): string {
    const multiline = (this.options & OPTION.multiline) !== 0;
    switch (char) {
      case '\\': {
        return this.escape(false);
      }
      case '[': {
        return this.openClass();
      }
      case '.': {
        return this.options & OPTION.singleline ? String.raw`[\s\S]` : String.raw`[^\n]`;
      }
      case '^': {
        return multiline ? String.raw`(?:${START}|(?<=\n))` : START;
      }
      case '$': {
        return multiline ? String.raw`(?=\n|${END})` : String.raw`(?=\n?${END})`;
      }
      case '(': {
        return this.groupOpening();
      }
      case '{': {
        return this.quantifierOpening();
      }
      case '}':
      case ']': {
        return `\\${char}`;
      }
      default: {
        return char;
      }
    }
  }

  private openClass(): string {
    this.inClass = true;
    this.isAfterClassSet = false;
    let output = '[';
    if (this.pattern[this.index] === '^') output += this.next();
    // A `]` that opens a class is a member of it in .NET.
    if (this.pattern[this.index] === ']') {
      this.next();
      output += String.raw`\]`;
    }
    return output;
  }

  private groupOpening(): string {
    const { pattern } = this;
    if (pattern[this.index] !== '?') {
      if (this.options & OPTION.explicitCapture) return '(?:';
      this.groups.push({ name: undefined });
      return '(';
    }
    // Sticky searches read the pattern in place, since slicing its rest at every group takes quadratic time.
    NAMED_GROUP.lastIndex = this.index + 1;
    const named = NAMED_GROUP.exec(pattern);
    if (named) {
      const name = named[1] ?? named[2];
      if (this.names.has(name)) throw new UnsupportedPattern();
      this.names.add(name);
      this.groups.push({ name });
      this.index += 1 + named[0].length;
      // JavaScriptCore parses named groups in quadratic time, so the host sees only numbered ones.
      return '(';
    }
    for (const opening of ['?:', '?=', '?!', '?<=', '?<!']) {
      if (pattern.startsWith(opening, this.index)) {
        this.index += opening.length;
        return `(${opening}`;
      }
    }
    if (pattern.startsWith('?#', this.index)) {
      const close = pattern.indexOf(')', this.index);
      if (close === -1) throw new UnsupportedPattern();
      this.index = close + 1;
      return '';
    }
    // Atomic groups, conditionals, balancing groups, and inline options have no JavaScript equivalent.
    throw new UnsupportedPattern();
  }

  private quantifierOpening(): string {
    QUANTIFIER.lastIndex = this.index;
    const quantifier = QUANTIFIER.exec(this.pattern);
    if (!quantifier) return String.raw`\{`;
    this.index += quantifier[0].length;
    return `{${quantifier[0]}`;
  }

  private next(): string {
    return this.pattern[this.index++] ?? '';
  }
}

const NAMED_GROUP = /<([A-Za-z_]\w*)>|'([A-Za-z_]\w*)'/y;
const QUANTIFIER = /\d+(?:,\d*)?\}/y;

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

/** The escapes that mean the same inside and outside a character class. */
const FIXED_ESCAPES = new Map<string, string>([
  ['d', String.raw`\p{Nd}`],
  ['D', String.raw`\P{Nd}`],
  ['B', `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`],
  ['A', START],
  ['z', END],
  ['Z', String.raw`(?=\n?${END})`],
  ['e', String.raw`\x1B`],
  ...[...'xuctnrfv'].map((letter): [string, string] => [letter, `\\${letter}`]),
]);

function escapeOf(
  char: string,
  inClass: boolean,
  pattern: string,
  position: () => number,
  move: (index: number) => void
): string {
  const fixed = FIXED_ESCAPES.get(char) ?? classDependentEscapeOf(char, inClass);
  if (fixed !== undefined) return fixed;
  switch (char) {
    case 'k': {
      const name = /^<([A-Za-z_]\w*)>/.exec(pattern.slice(position()));
      if (!name) throw new UnsupportedPattern();
      move(position() + name[0].length);
      return `${name[1]}`;
    }
    case 'p':
    case 'P': {
      const category = /^\{([A-Z][a-z]?)\}/.exec(pattern.slice(position()));
      if (!category) throw new UnsupportedPattern();
      move(position() + category[0].length);
      return `\\${char}${category[0]}`;
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

/** The escapes whose meaning inside a character class differs from outside. */
function classDependentEscapeOf(char: string, inClass: boolean): string | undefined {
  switch (char) {
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
    default: {
      return undefined;
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
  /** The input string itself when the group spans all of it, which .NET's `Value` returns as `Substring` does. */
  whole?: string | CsString;
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
    /** The input string, which `NextMatch` searches on with its identity. */
    readonly source: string | CsString,
    /** Where the next match starts, past an empty match as .NET moves on. */
    readonly nextStart: number
  ) {
    super(group);
  }

  get input(): string {
    return stringText(this.source);
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

/** The patterns each run compiled, which the run keeps, so that a program's patterns go away with it. */
const compiledPatterns = new WeakMap<object, Map<string, CompiledPattern>>();

/** The first error that .NET's parser reports for the common mistakes in a pattern, with its offset. */
function patternError(pattern: string): PatternError | undefined {
  const scan: PatternScan = { depth: 0, canQuantify: false, quantified: false };
  for (let index = 0; index < pattern.length;) {
    const step = scanPatternAt(pattern, index, scan);
    if (typeof step !== 'number') return step;
    index = step;
  }
  return scan.depth > 0 ? { offset: pattern.length, reason: "Not enough )'s." } : undefined;
}

interface PatternError {
  offset: number;
  reason: string;
}

interface PatternScan {
  depth: number;
  /** Whether the last element can take a quantifier, which an opening parenthesis or `|` cannot. */
  canQuantify: boolean;
  quantified: boolean;
}

/** Scans the element of a pattern at an index, returning the index after it or the error it makes. */
function scanPatternAt(pattern: string, index: number, scan: PatternScan): number | PatternError {
  const char = pattern[index];
  if (char === '\\') return scanEscape(pattern, index, scan);
  if (char === '[') {
    const close = pattern.indexOf(']', index + (pattern[index + 1] === ']' ? 2 : 1));
    if (close === -1) return { offset: pattern.length, reason: 'Unterminated [] set.' };
    scan.canQuantify = true;
    scan.quantified = false;
    return close + 1;
  }
  const quantifier = /^(?:[*+?]|\{(\d+)(?:,(\d*))?\})/.exec(pattern.slice(index));
  if (quantifier && !(char === '?' && scan.quantified)) return scanQuantifier(quantifier, index, scan);
  scan.quantified = false;
  if (char === '(') {
    scan.depth++;
    scan.canQuantify = false;
    // `(?` starts a group construct, such as `(?:`, `(?<name>`, or `(?=`, whose `?` is no quantifier.
    return pattern[index + 1] === '?' ? index + 2 : index + 1;
  }
  if (char === ')') {
    if (scan.depth === 0) return { offset: index + 1, reason: "Too many )'s." };
    scan.depth--;
  }
  scan.canQuantify = char !== '|';
  return index + 1;
}

function scanEscape(pattern: string, index: number, scan: PatternScan): number | PatternError {
  if (index + 1 >= pattern.length)
    return {
      offset: index + 1,
      reason: String.raw`Illegal \ at end of pattern.`,
    };
  const escaped = pattern[index + 1];
  if (/[A-Za-z]/.test(escaped) && !/[dDwWsSbBAzZGntrfvaeuxcpPk]/.test(escaped))
    return {
      offset: index + 2,
      reason: `Unrecognized escape sequence \\${escaped}.`,
    };
  scan.canQuantify = true;
  scan.quantified = false;
  return index + 2;
}

function scanQuantifier(quantifier: RegExpExecArray, index: number, scan: PatternScan): number | PatternError {
  const [text, low, high] = quantifier;
  if (!scan.canQuantify)
    return {
      offset: index + 1,
      reason: `Quantifier '${text[0] === '{' ? text : text[0]}' following nothing.`,
    };
  if (scan.quantified) return { offset: index + 1, reason: `Nested quantifier '${text[0]}'.` };
  if (high !== undefined && high !== '' && Number(low) > Number(high))
    return { offset: index + text.length, reason: 'Illegal {x,y} with x > y.' };
  scan.quantified = true;
  return index + text.length;
}

function patternOf(call: NativeCall, patternString: Value, options: Value = 0): CompiledPattern {
  if (patternString === undefined) failNull('pattern');
  const pattern = plainString(patternString);
  const key = `${options as number}:${pattern as string}`;
  let patterns = compiledPatterns.get(call.frame.runtime);
  if (!patterns) {
    patterns = new Map();
    compiledPatterns.set(call.frame.runtime, patterns);
  }
  let compiled = patterns.get(key);
  if (!compiled) {
    call.frame.runtime.spend(Math.ceil((pattern as string).length / 16));
    const invalid = patternError(pattern as string);
    if (invalid) {
      fail(
        'System.Text.RegularExpressions.RegexParseException',
        `Invalid pattern '${pattern as string}' at offset ${invalid.offset}. ${invalid.reason}`
      );
    }
    try {
      compiled = compilePattern(pattern as string, options as number);
    } catch (error) {
      if (error instanceof UnsupportedPattern) unsupportedCall(call, `正規表現のパターン「${pattern as string}」`);
      throw error;
    }
    patterns.set(key, compiled);
  }
  return compiled;
}

function regexOf(value: Value): CompiledPattern {
  return (value as CsObject).native as CompiledPattern;
}

function inputOf(value: Value): string | CsString {
  if (value === undefined) failNull('input');
  return value as string | CsString;
}

const STEPS_PER_OPERATION = 8;

function findMatch(call: NativeCall, compiled: CompiledPattern, source: string | CsString, start: number): CsObject {
  const input = stringText(source);
  let steps = 0;
  // A step of the matcher costs little next to an operation of the program.
  const found = execRegExp(compiled.matcher, input, start, false, () => {
    if (++steps % STEPS_PER_OPERATION === 0) call.frame.runtime.spend();
  });
  if (!found) return emptyMatch(call);
  // A match keeps its groups for as long as the program holds it, so they are charged as an allocation.
  call.frame.runtime.allocateSlots(compiled.names.length);
  const groups: GroupResult[] = Array.from({ length: compiled.names.length });
  for (const [jsIndex, number] of compiled.numberOfIndex.entries()) {
    const span = found.spans[jsIndex];
    groups[number] = {
      number,
      name: compiled.names[number],
      success: span !== undefined,
      index: span?.[0] ?? 0,
      length: span ? span[1] - span[0] : 0,
      value: span ? input.slice(span[0], span[1]) : '',
      whole: span?.[0] === 0 && span[1] === input.length ? source : undefined,
    };
  }
  const whole = groups[0];
  const nextStart = whole.length === 0 ? whole.index + 1 : whole.index + whole.length;
  const match = new CsObject(libraryType(call, `${NAMESPACE}.Match`), []);
  match.native = new MatchState(whole, groups, compiled, source, nextStart);
  return match;
}

function emptyMatch(call: NativeCall): CsObject {
  const match = new CsObject(libraryType(call, `${NAMESPACE}.Match`), []);
  const group: GroupResult = {
    number: 0,
    name: '0',
    success: false,
    index: 0,
    length: 0,
    value: '',
  };
  match.native = new MatchState(group, [group], undefined, '', 0);
  return match;
}

function allMatches(
  call: NativeCall,
  compiled: CompiledPattern,
  input: string | CsString,
  start = 0,
  /** The most matches wanted, as Replace's count gives; -1 for all of them. */
  limit = -1
): CsObject[] {
  const matches: CsObject[] = [];
  for (let position = start; position <= stringText(input).length && matches.length !== limit;) {
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
  object.native = new GroupState({
    number: -1,
    name: '',
    success: false,
    index: 0,
    length: 0,
    value: '',
  });
  return object;
}

/** Expands a replacement pattern's substitutions (`$1`, `${name}`, `$&`, ...) for a match into the output, as .NET does. */
// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function substitute(output: MeteredText, replacement: string, state: MatchState): void {
  const groupValue = (number: number): string => state.groups[number]?.value ?? '';
  const whole = state.group;
  for (let index = 0; index < replacement.length; index++) {
    const char = replacement[index];
    output.read(1);
    if (char !== '$' || index + 1 >= replacement.length) {
      output.append(char);
      continue;
    }
    const rest = replacement.slice(index + 1);
    const digits = /^\d+/.exec(rest)?.[0];
    if (digits) {
      output.read(digits.length);
      // .NET reads all the digits as one group number, and leaves the text as it is when that group does not exist
      // (only RegexOptions.ECMAScript, which this grader rejects, takes the longest prefix that names a group).
      const number = Number(digits);
      if (number < state.groups.length) {
        output.append(groupValue(number));
        index += digits.length;
        continue;
      }
      output.append(char);
      continue;
    }
    const braced = /^\{(\w+)\}/.exec(rest);
    if (braced) {
      output.read(braced[0].length);
      const name = braced[1];
      const number = /^\d+$/.test(name) ? Number(name) : (state.compiled?.names.indexOf(name) ?? -1);
      if (number >= 0 && number < state.groups.length) {
        output.append(groupValue(number));
        index += braced[0].length;
        continue;
      }
      output.append(char);
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
      output.append(expand());
      index++;
    } else output.append(char);
  }
}

/** `Replace`, which returns the input itself when it replaces nothing. */
function replaceMatches(
  call: NativeCall,
  compiled: CompiledPattern,
  source: string | CsString,
  replace: (match: CsObject, state: MatchState, output: MeteredText) => void,
  count = -1
): string | CsString {
  if (count < -1) failOutOfRange(call, 'count', 'Count cannot be less than -1.', String(count));
  const matches = count === 0 ? [] : allMatches(call, compiled, source, 0, count);
  if (matches.length === 0) return source;
  const input = stringText(source);
  const output = new MeteredText(call.frame.runtime);
  let position = 0;
  let replaced = 0;
  for (const match of matches) {
    const state = match.native as MatchState;
    output.append(input.slice(position, state.group.index));
    replace(match, state, output);
    position = state.group.index + state.group.length;
    if (++replaced === count) break;
  }
  output.append(input.slice(position));
  return freshString(output.toString());
}

/** `Split`, whose only part is the input itself when nothing matches. */
function split(call: NativeCall, compiled: CompiledPattern, source: string | CsString): Value {
  const matches = allMatches(call, compiled, source);
  if (matches.length === 0) return newArray(call, stringType(call), [source]);
  const input = stringText(source);
  const parts: string[] = [];
  let position = 0;
  for (const match of matches) {
    const state = match.native as MatchState;
    parts.push(input.slice(position, state.group.index));
    position = state.group.index + state.group.length;
    for (const group of state.groups.slice(1)) if (group.success) parts.push(group.value);
  }
  parts.push(input.slice(position));
  return newArray(
    call,
    stringType(call),
    parts.map((part) => freshString(part))
  );
}

const stringType = (call: NativeCall): ReturnType<typeof libraryType> => libraryType(call, 'System.String');

function replacementOf(value: Value): string {
  if (value === undefined) failNull('replacement');
  return plainString(value) as string;
}

function evaluate(call: NativeCall, evaluator: Value, match: CsObject): string {
  if (evaluator === undefined) failNull('evaluator');
  const result = evaluatorOf(call).invokeDelegate(call.frame, evaluator, [match], call.row);
  return (plainString(result) as string | undefined) ?? '';
}

function newMatchCollection(call: NativeCall, matches: CsObject[]): CsObject {
  const collection = new CsObject(libraryType(call, `${NAMESPACE}.MatchCollection`), []);
  collection.native = new MatchListState(matches);
  return collection;
}

const REGEX = `${NAMESPACE}.Regex`;

defineNatives({
  [`${REGEX}.get_Options`]: (_call, receiver) => regexOf(receiver).options,
  [`${REGEX}.GetGroupNames`]: (call, receiver) => newArray(call, stringType(call), [...regexOf(receiver).names]),
  [`${REGEX}.IsMatch(string)`]: (call, receiver, [input]) =>
    groupOf(findMatch(call, regexOf(receiver), inputOf(input as Value), 0)).success,
  [`${REGEX}.IsMatch(string, string)`]: (call, _receiver, [input, pattern]) =>
    groupOf(findMatch(call, patternOf(call, pattern as Value), inputOf(input as Value), 0)).success,
  [`${REGEX}.IsMatch(string, string, RegexOptions)`]: (call, _receiver, [input, pattern, options]) =>
    groupOf(findMatch(call, patternOf(call, pattern as Value, options as Value), inputOf(input as Value), 0)).success,
  [`${NAMESPACE}.Capture.get_Index`]: (_call, receiver) => groupOf(receiver).index,
  [`${NAMESPACE}.Capture.get_Length`]: (_call, receiver) => groupOf(receiver).length,
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
    return findMatch(call, state.compiled, state.source, state.nextStart);
  },
  [`${NAMESPACE}.Match.Result`]: (call, receiver, [replacement]) => {
    const output = new MeteredText(call.frame.runtime);
    substitute(output, replacementOf(replacement as Value), matchStateOf(receiver));
    return output.toString();
  },
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

// These take the input string with its identity, which a result that is all of it is, as .NET returns it.
defineNativesKeepingStrings({
  [`${REGEX}..ctor(string)`]: (call, receiver, [pattern]) => {
    (receiver as CsObject).native = patternOf(call, pattern as Value);
    patternStrings.set(receiver as CsObject, pattern as string | CsString);
    return;
  },
  [`${REGEX}..ctor(string, RegexOptions)`]: (call, receiver, [pattern, options]) => {
    (receiver as CsObject).native = patternOf(call, pattern as Value, options as Value);
    patternStrings.set(receiver as CsObject, pattern as string | CsString);
    return;
  },
  [`${REGEX}.ToString`]: (_call, receiver) => patternStrings.get(receiver as CsObject) ?? regexOf(receiver).pattern,
  [`${REGEX}.Match(string)`]: (call, receiver, [input]) =>
    findMatch(call, regexOf(receiver), inputOf(input as Value), 0),
  [`${REGEX}.Match(string, int)`]: (call, receiver, [input, start]) => {
    const text = inputOf(input as Value);
    if ((start as number) < 0 || (start as number) > stringText(text).length) {
      failOutOfRange(call, 'startat', 'Start index cannot be less than 0 or greater than input length.', String(start));
    }
    return findMatch(call, regexOf(receiver), text, start as number);
  },
  [`${REGEX}.Matches(string)`]: (call, receiver, [input]) =>
    newMatchCollection(call, allMatches(call, regexOf(receiver), inputOf(input as Value))),
  [`${REGEX}.Replace(string, string)`]: (call, receiver, [input, replacement]) => {
    const text = replacementOf(replacement as Value);
    return replaceMatches(call, regexOf(receiver), inputOf(input as Value), (_match, state, output) =>
      substitute(output, text, state)
    );
  },
  [`${REGEX}.Replace(string, string, int)`]: (call, receiver, [input, replacement, count]) => {
    const text = replacementOf(replacement as Value);
    return replaceMatches(
      call,
      regexOf(receiver),
      inputOf(input as Value),
      (_match, state, output) => substitute(output, text, state),
      count as number
    );
  },
  [`${REGEX}.Replace(string, MatchEvaluator)`]: (call, receiver, [input, evaluator]) =>
    replaceMatches(call, regexOf(receiver), inputOf(input as Value), (match, _state, output) =>
      output.append(evaluate(call, evaluator as Value, match))
    ),
  [`${REGEX}.Split(string)`]: (call, receiver, [input]) => split(call, regexOf(receiver), inputOf(input as Value)),
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
    return replaceMatches(call, patternOf(call, pattern as Value), inputOf(input as Value), (_match, state, output) =>
      substitute(output, text, state)
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
      (_match, state, output) => substitute(output, text, state)
    );
  },
  [`${REGEX}.Replace(string, string, MatchEvaluator)`]: (call, _receiver, [input, pattern, evaluator]) =>
    replaceMatches(call, patternOf(call, pattern as Value), inputOf(input as Value), (match, _state, output) =>
      output.append(evaluate(call, evaluator as Value, match))
    ),
  [`${REGEX}.Split(string, string)`]: (call, _receiver, [input, pattern]) =>
    split(call, patternOf(call, pattern as Value), inputOf(input as Value)),
  [`${REGEX}.Split(string, string, RegexOptions)`]: (call, _receiver, [input, pattern, options]) =>
    split(call, patternOf(call, pattern as Value, options as Value), inputOf(input as Value)),
  [`${REGEX}.Escape`]: (_call, _receiver, [text]) => {
    if (text === undefined) failNull('str');
    return keptUnlessChanged(text as string | CsString, (plain) =>
      plain.replaceAll(/[\\*+?|{[()^$.# \t\n\r\f]/g, (char) => {
        const named: Record<string, string> = {
          ' ': String.raw`\ `,
          '\t': String.raw`\t`,
          '\n': String.raw`\n`,
          '\r': String.raw`\r`,
          '\f': String.raw`\f`,
        };
        return named[char] ?? `\\${char}`;
      })
    );
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
    // An escape is a name (\n), \xHH, \uHHHH, up to three octal digits (whose value wraps at a byte, as .NET's
    // does), or \c with a control designator from @ to _ (a letter in either case); any other escaped character
    // stands for itself.
    return keptUnlessChanged(text as string | CsString, (plain) =>
      plain.replaceAll(
        /\\(?:x([\da-fA-F]{2})|u([\da-fA-F]{4})|([0-7]{1,3})|c([@-_a-z])|(.))/gs,
        (_match, hex?: string, unicode?: string, octal?: string, control?: string, char?: string) => {
          if (hex !== undefined || unicode !== undefined)
            return String.fromCharCode(Number.parseInt(hex ?? unicode ?? '', 16));
          if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
          if (control !== undefined) return String.fromCharCode(control.toUpperCase().charCodeAt(0) - 64);
          return named[char as string] ?? (char as string);
        }
      )
    );
  },
  [`${NAMESPACE}.Capture.get_Value`]: (_call, receiver) => captureString(receiver),
  [`${NAMESPACE}.Capture.ToString`]: (_call, receiver) => captureString(receiver),
});

/** The pattern string that each `Regex` was made from, which its `ToString()` returns. */
const patternStrings = new WeakMap<CsObject, string | CsString>();

/** A capture's text, which .NET takes with `Substring`: the input itself when it is all of it, or a new string. */
function captureString(capture: Value): string | CsString {
  const group = groupOf(capture);
  return group.whole ?? freshString(group.value);
}

/** The result of `Escape` or `Unescape`, which is the string itself when there is nothing to change. */
function keptUnlessChanged(text: string | CsString, change: (plain: string) => string): string | CsString {
  const changed = change(stringText(text));
  return changed === stringText(text) ? text : freshString(changed);
}

function listOf(value: Value): CsObject[] {
  if (value === undefined) failNull('collection');
  return ((value as CsObject).native as MatchListState).matches;
}

function itemAt(call: NativeCall, items: CsObject[], index: number): CsObject {
  if (index < 0 || index >= items.length) {
    failOutOfRange(call, 'i', 'Specified argument was out of the range of valid values.');
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
