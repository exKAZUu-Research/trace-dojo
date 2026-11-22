// code-gauge-allow-file fileNcss -- One converter class walks the pattern, and its cases share its cursor and result.
import { dec, enc } from './bytes';
import {
  ANY,
  BYTE_POSIX_CLASSES,
  BYTE_SETS,
  type CharacterSet,
  UCP_NONPRINTING_FORMATS,
  UCP_POSIX_CLASSES,
  UCP_SETS,
  unicodeBoundary,
  unicodeProperty,
} from './pcreCharacterSets';
import {
  applyModifier,
  PatternError,
  type PatternOption,
  type PatternOptions,
  splitDelimiters,
  validatePatternUtf8,
} from './pcrePatternSource';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';

/**
 * A compiled pattern: JavaScript regexes that match as PCRE does, whether they match UTF-8 text by characters (`u`),
 * and the groups PHP reports, which the regexes capture under the names that `groupName` gives.
 */
export interface Compiled {
  /** Finds the next match from `lastIndex`, or only at `lastIndex` for an anchored pattern. */
  regex: RegExp;
  /** Matches only at `lastIndex` and only a match that does not end there, as PCRE retries after an empty match. */
  retry: RegExp;
  utf8: boolean;
  names: (string | undefined)[];
  groupCount: number;
  /** The capture names of the `\K` points, the last passed of which starts the reported match. */
  keeps: string[];
}

// code-gauge-allow functionCognitiveComplexity -- Threads pattern options, byte offsets and captures through both parsing passes.
export function translate(pattern: string): Compiled {
  if (pattern.length > 32_768) throw new UnsupportedFeatureError('大きすぎる正規表現');
  const { body, modifiers } = splitDelimiters(pattern);
  const options: PatternOptions = {
    caseless: false,
    caselessRestricted: false,
    multiline: false,
    dotAll: false,
    extended: false,
    extendedClass: false,
    ungreedy: false,
    dollarEndOnly: false,
    anchored: false,
    utf8: false,
    noAutoCapture: false,
    duplicateNames: false,
  };
  for (const modifier of modifiers) applyModifier(options, modifier);
  if (options.utf8) validatePatternUtf8(body);
  let source = options.utf8 ? dec(body) : body;
  const leadingFlags = /^\(\?([imsxU]+)\)/.exec(source);
  if (leadingFlags) {
    for (const flag of leadingFlags[1]) applyModifier(options, flag);
    options.extendedClass = leadingFlags[1].includes('xx');
    source = source.slice(leadingFlags[0].length);
  }
  const offsetBase = leadingFlags?.[0].length ?? 0;
  const layout = new PatternConverter(source, options, offsetBase).layout();
  if (layout.names.length > 256) throw new UnsupportedFeatureError('キャプチャが多すぎる正規表現');
  const converter = new PatternConverter(source, options, offsetBase, layout);
  const converted = converter.convert();
  if (converted.length > 65_536) throw new UnsupportedFeatureError('大きすぎる正規表現');
  const flags = `d${options.caseless ? 'i' : ''}${converter.unicode ? 'u' : ''}`;
  if (converter.unavailable) unsupported(converter.unavailable);
  return {
    regex: hostRegex(converted, `${options.anchored || converter.sticky ? 'y' : 'g'}${flags}`),
    retry: hostRegex(String.raw`(?=(?<$r>[\s\S]*))(?:${converted})(?!\k<$r>(?![\s\S]))`, `y${flags}`),
    utf8: options.utf8,
    names: options.utf8 ? converter.names.map((name) => (name === undefined ? undefined : enc(name))) : converter.names,
    groupCount: converter.names.length - 1,
    keeps: converter.keeps,
  };
}

function hostRegex(source: string, flags: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    if (error instanceof SyntaxError) unsupported('ホストエンジンで表せない書き方');
    throw error;
  }
}

/** The name under which the regexes capture a group of the pattern. */
export function groupName(group: number): string {
  return `$${group}`;
}

/** A class member that a range can start or end with. */
interface ClassCharacter {
  text: string;
  value: number;
}

interface ClassLexicalState {
  quoted: boolean;
}

interface ClassMembers {
  content: string;
  /** Regexes of the sets that a JavaScript class cannot nest, such as complements, which the class also matches. */
  alternatives: string[];
}

/** A group open in the pattern. */
interface Frame {
  /** Where the group starts in the result, which a quantifier after it repeats from. */
  start: number;
  /** The options outside the group, which its end restores. */
  outer: PatternOptions;
  /** The text that ends the group in the result. */
  close: string;
  /** The JavaScript modifier groups (`(?i:`) that option settings opened in the group, which `|` closes and reopens. */
  modifiers: string[];
  lookaround?: 'ahead' | 'behind';
  /** What a lookbehind holds so far, in itself or in the groups inside it. */
  captures?: boolean;
  variable?: boolean;
  /** Whether the group holds a `\K`, and an alternative or optional item that lets a match pass through without one. */
  keeps?: boolean;
  passable?: boolean;
  /** Where the group starts in the pattern, which the error of an unlimited lookbehind reports. */
  at: number;
  /** The group that the frame captures, if any, and the groups opened inside it. */
  own?: number;
  groups: number[];
  /** The alternatives that have ended, and where the current one starts in the pattern with the groups opened in it. */
  alternatives: SkippableScope[];
  alternativeAt: number;
  alternativeGroups: number[];
}

/** A part of the pattern that a match can pass without, and the groups opened in it. */
interface SkippableScope {
  groups: number[];
  start: number;
  end: number;
}

/** What the first pass over a pattern finds that the second needs. */
interface Layout {
  names: (string | undefined)[];
  /**
   * The back references, by their order in the pattern, that a match can reach without their group, and the groups
   * of those references, which get markers telling whether they took part: PCRE fails a reference to a group that did
   * not, where JavaScript matches the empty string.
   */
  checked: Set<number>;
  marked: Set<number>;
}

const INLINE_OPTIONS = new Map<string, PatternOption>([
  ['i', 'caseless'],
  ['m', 'multiline'],
  ['n', 'noAutoCapture'],
  ['s', 'dotAll'],
  ['x', 'extended'],
  ['U', 'ungreedy'],
  ['J', 'duplicateNames'],
]);

const SIMPLE_ESCAPES = new Map([
  ['a', 0x07],
  ['e', 0x1b],
  ['f', 0x0c],
  ['n', 0x0a],
  ['r', 0x0d],
  ['t', 0x09],
]);
const DIGITS_MISSING = String.raw`digits missing after \x or in \x{} or \o{} or \N{U+}`;
const UNSUPPORTED_CASE_ESCAPE = String.raw`PCRE2 does not support \F, \L, \l, \N{name}, \U, or \u`;

function bracedQuantifier(
  text: string
): { length: number; endOfMin: number; endOfDigits: number; min: number; max: number | undefined } | undefined {
  const match = /^\{[ \t]*(\d*)[ \t]*(?:(,)[ \t]*(\d*)[ \t]*)?\}/.exec(text);
  if (!match || (match[1] === '' && !match[3])) return undefined;
  return {
    length: match[0].length,
    endOfMin: match[0].indexOf(match[1]) + match[1].length,
    endOfDigits: match[0].slice(0, -1).trimEnd().length,
    min: Number(match[1]),
    max: match[2] && match[3] === '' ? undefined : Number(match[3] ?? match[1]),
  };
}

function unsupported(what: string): never {
  throw new UnsupportedFeatureError(`正規表現の${what}`);
}

/**
 * Rewrites a PCRE pattern into a JavaScript one that matches the same text, reporting PCRE's compilation errors at
 * PCRE's offsets and rejecting what JavaScript cannot express.
 */
class PatternConverter {
  /** Whether the regex needs JavaScript's `u` flag, which `\p` requires even without PHP's `u` modifier. */
  unicode: boolean;
  readonly names: (string | undefined)[] = [undefined];
  readonly keeps: string[] = [];
  /** Whether the pattern starts with `\G`, so that it matches only where the search starts. */
  sticky = false;
  unavailable?: string;
  private index = 0;
  private result = '';
  /** Whether the last item can take a quantifier. */
  private repeatable = false;
  /** Where the last repeatable item starts in the result. */
  private itemStart = 0;
  private readonly frames: Frame[];
  private readonly references: { target: number | string; at: number; position: number; early: boolean }[] = [];
  private hiddenGroups = 0;
  private alternation = false;
  /** The groups that the last repeatable item holds, and where it starts in the pattern if it is a group. */
  private itemGroups: number[] = [];
  private itemAt = 0;
  /** Whether a repetition of the last item can pass a `\K` in one round and not in a later one. */
  private itemCanLoseKeep = false;
  /** The parts that a match can pass without: an alternative, an optional item, or a lookaround. */
  private readonly skippable: SkippableScope[] = [];
  private keepInLookaround = false;
  private readonly source: string;
  private options: PatternOptions;
  /** The bytes of the pattern before `source`, which error offsets count. */
  private readonly offsetBase: number;
  private readonly known: Layout | undefined;

  constructor(source: string, options: PatternOptions, offsetBase: number, known?: Layout) {
    this.source = source;
    this.options = { ...options };
    this.offsetBase = offsetBase;
    this.unicode = options.utf8;
    this.checkCaselessRestriction(options);
    this.known = known;
    this.frames = [
      {
        start: 0,
        outer: this.options,
        close: '',
        modifiers: [],
        at: 0,
        groups: [],
        alternatives: [],
        alternativeAt: 0,
        alternativeGroups: [],
      },
    ];
  }

  /** Converts the pattern to learn its layout, which a second converter needs for references to later groups. */
  layout(): Layout {
    this.convert();
    const checked = new Set<number>();
    const marked = new Set<number>();
    for (const [index, { target, position, early }] of this.references.entries()) {
      const group = typeof target === 'number' ? target : this.names.indexOf(target);
      // A reference inside the part that can be passed, after its group, is passed together with the group.
      const passable = this.skippable.some(
        (scope) => scope.groups.includes(group) && (position < scope.start || position >= scope.end)
      );
      if (!early && !passable) continue;
      checked.add(index);
      marked.add(group);
    }
    return { names: this.names, checked, marked };
  }

  convert(): string {
    while (this.index < this.source.length) {
      rt().spend();
      this.item();
    }
    if (this.frames.length > 1) this.fail('missing closing parenthesis', this.source.length);
    this.endFrame(this.frames[0], Infinity);
    this.result += ')'.repeat(this.frames[0].modifiers.length);
    for (const { target, at } of this.references) {
      const exists = typeof target === 'number' ? target < this.names.length : this.names.includes(target);
      if (!exists) this.fail('reference to non-existent subpattern', at);
    }
    if (this.keepInLookaround) {
      this.fail(
        String.raw`\K is not allowed in lookarounds (but see PCRE2_EXTRA_ALLOW_LOOKAROUND_BSK)`,
        this.source.length
      );
    }
    if (this.sticky && this.alternation) unsupported(String.raw`選択肢の前の \G`);
    return this.result;
  }

  // code-gauge-allow functionNcss -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private item(): void {
    const char = this.source[this.index];
    if (this.options.extended && this.skipExtended(char)) return;
    switch (char) {
      case '\\': {
        this.escape();
        return;
      }
      case '[': {
        this.characterClass();
        return;
      }
      case '(': {
        this.openGroup();
        return;
      }
      case ')': {
        this.closeGroup();
        return;
      }
      case '|': {
        this.alternative();
        return;
      }
      case '*':
      case '+':
      case '?': {
        this.quantifier(char, this.index + 1);
        return;
      }
      case '{': {
        this.brace();
        return;
      }
    }
    const text = this.options.utf8 ? String.fromCodePoint(this.source.codePointAt(this.index) ?? 0) : char;
    this.index += text.length;
    this.emit(this.metaCharacter(text) ?? literal(text), !'^$|'.includes(text));
  }

  private skipExtended(char: string): boolean {
    if (/[ \t\n\r\v\f\u0085]/.test(char) || (this.options.utf8 && /[\u2028\u2029]/.test(char))) {
      this.index++;
      return true;
    }
    if (char !== '#') return false;
    while (this.index < this.source.length && this.source[this.index] !== '\n') this.index++;
    return true;
  }

  private metaCharacter(char: string): string | undefined {
    switch (char) {
      case '^': {
        return this.options.multiline ? String.raw`(?:(?<![\s\S])|(?<=\n)(?=[\s\S]))` : '^';
      }
      case '$': {
        if (this.options.multiline) return String.raw`(?=\n|(?![\s\S]))`;
        return this.options.dollarEndOnly ? String.raw`(?![\s\S])` : String.raw`(?=\n?(?![\s\S]))`;
      }
      case '.': {
        return this.options.dotAll ? ANY : String.raw`[^\n]`;
      }
    }
    return undefined;
  }

  private emit(text: string, repeatable: boolean): void {
    if (repeatable) {
      this.itemStart = this.result.length;
      this.itemGroups = [];
      this.itemCanLoseKeep = false;
    }
    this.result += text;
    this.repeatable = repeatable;
  }

  private openFrame(open: string, close: string, lookaround?: 'ahead' | 'behind', at = this.index): void {
    this.frames.push({
      start: this.result.length,
      outer: this.options,
      close,
      modifiers: [],
      lookaround,
      at,
      groups: [],
      alternatives: [],
      alternativeAt: at,
      alternativeGroups: [],
    });
    this.options = { ...this.options };
    this.emit(open, false);
  }

  private closeGroup(): void {
    if (this.frames.length === 1) this.fail('unmatched closing parenthesis', this.index + 1);
    this.index++;
    const frame = this.frames.pop() as Frame;
    this.result += `${')'.repeat(frame.modifiers.length)}${frame.close}`;
    this.options = frame.outer;
    this.repeatable = true;
    this.itemStart = frame.start;
    this.endFrame(frame, this.index);
    this.itemGroups = frame.own === undefined ? frame.groups : [...frame.groups, frame.own];
    this.itemAt = frame.at;
    this.itemCanLoseKeep = Boolean(frame.keeps && frame.passable);
  }

  private endFrame(frame: Frame, end: number): void {
    if (frame.alternatives.length > 0) {
      this.endAlternative(frame, end);
      this.skippable.push(...frame.alternatives);
    }
    if (frame.lookaround) this.skippable.push({ groups: frame.groups, start: frame.at, end });
  }

  private endAlternative(frame: Frame, end: number): void {
    frame.alternatives.push({ groups: frame.alternativeGroups, start: frame.alternativeAt, end });
    frame.alternativeAt = end;
    frame.alternativeGroups = [];
  }

  /** Emits `|`, where the option settings so far in the group still apply. */
  private alternative(): void {
    this.index++;
    const frame = this.frames.at(-1) as Frame;
    const { modifiers } = frame;
    this.endAlternative(frame, this.index);
    for (const open of this.frames) open.passable = true;
    if (this.frames.length === 1) this.alternation = true;
    this.noteInLookbehind('variable');
    this.emit(`${')'.repeat(modifiers.length)}|${modifiers.join('')}`, false);
  }

  private fail(message: string, index: number): never {
    const offset = this.options.utf8 ? enc(this.source.slice(0, index)).length : index;
    throw new PatternError(`Compilation failed: ${message} at offset ${this.offsetBase + offset}`);
  }

  /** Emits a quantifier ending at `end`, with the lazy (`?`) or possessive (`+`) suffix that follows it. */
  // code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  private quantifier(text: string, end: number): void {
    if (!this.repeatable) this.fail('quantifier does not follow a repeatable item', end);
    this.checkLookbehindQuantifier(text);
    if (/^(?:[*?]|\{0[,}])/.test(text)) {
      this.skippable.push({ groups: this.itemGroups, start: this.itemAt, end: this.index });
      for (const open of this.frames) open.passable = true;
    }
    // JavaScript forgets the capture that marks a `\K` when a later round of a repetition does not pass it.
    if (this.itemCanLoseKeep && text !== '?' && !/^\{[01](?:,1)?\}$/.test(text)) {
      this.unavailable ??= String.raw`繰り返しの中での選択や省略と \K の併用`;
    }
    this.index = end;
    while (this.index < this.source.length) {
      if (this.source.startsWith('(?#', this.index)) this.skipGroupComment();
      else if (!this.options.extended || !this.skipExtended(this.source[this.index])) break;
      rt().spend();
    }
    const suffix = this.source[this.index];
    const optional = text === '?' || text === '{0,1}';
    if (suffix === '+') {
      this.index++;
      if (optional) this.optionalItem(true);
      this.possessive(optional ? '' : text);
      return;
    }
    const lazy = suffix === '?';
    if (lazy) this.index++;
    const greedy = lazy === this.options.ungreedy;
    if (optional) this.optionalItem(greedy);
    else this.emit(greedy ? text : `${text}?`, false);
  }

  /** Repeats the last item atomically, as a lookahead does, which JavaScript does not backtrack into. */
  private possessive(quantifier: string): void {
    this.rejectInLookbehind('絶対最大量指定子');
    const name = `$a${this.hiddenGroups++}`;
    this.wrapItem(`(?:(?=(?<${name}>`, `${quantifier}))\\k<${name}>)`);
  }

  /** Rejects what a lookbehind would get wrong, because JavaScript matches a lookbehind from its end to its start. */
  private rejectInLookbehind(what: string): void {
    if (this.frames.some((frame) => frame.lookaround === 'behind')) this.unavailable ??= `後読みの中の${what}`;
  }

  private checkLookbehindQuantifier(quantifier: string): void {
    // An exact count of an item without captures matches the same text from either end.
    if (!/^\{\d+\}$/.test(quantifier) || this.itemGroups.length > 0) this.noteInLookbehind('variable');
    if (!/^(?:[*+]|\{\d+,\})$/.test(quantifier)) return;
    // A lookahead inside a lookbehind takes no length of it.
    const lookaround = this.frames.findLast((frame) => frame.lookaround);
    if (lookaround?.lookaround === 'behind') this.fail('length of lookbehind assertion is not limited', lookaround.at);
  }

  /**
   * Rejects a lookbehind that captures and also repeats or chooses: JavaScript matches it from the end to the start, so
   * a capture could hold another repetition's or alternative's text than PCRE's.
   */
  private noteInLookbehind(found: 'captures' | 'variable'): void {
    for (const frame of this.frames) {
      if (frame.lookaround !== 'behind') continue;
      frame[found] = true;
      if (frame.captures && frame.variable) this.unavailable ??= '後読みの中での繰り返しや選択とキャプチャの併用';
    }
  }

  private optionalItem(greedy: boolean): void {
    // JavaScript's optional quantifier skips zero-width captures even when the greedy branch succeeds.
    this.wrapItem(greedy ? '(?:' : '(?:|', greedy ? '|)' : ')');
  }

  private wrapItem(open: string, close: string): void {
    const before = this.result.slice(0, this.itemStart);
    this.result = `${before}${open}${this.result.slice(this.itemStart)}${close}`;
    this.repeatable = false;
  }

  /** Reads `{n}`, `{n,}`, `{n,m}`, or `{,m}` (spaces allowed inside since PCRE2 10.43), or a literal `{`. */
  private brace(): void {
    const match = bracedQuantifier(this.source.slice(this.index));
    if (!match) {
      this.index++;
      this.emit(String.raw`\{`, true);
      return;
    }
    const { min, max } = match;
    const close = this.index + match.length - 1;
    this.checkQuantifierRange(min, max, this.index + match.endOfMin, this.index + match.endOfDigits);
    this.quantifier(max === min ? `{${min}}` : `{${min},${max ?? ''}}`, close + 1);
  }

  private checkQuantifierRange(min: number, max: number | undefined, minAt: number, maxAt = minAt): void {
    if (min > 0xff_ff) this.fail('number too big in {} quantifier', minAt);
    if ((max ?? 0) > 0xff_ff) this.fail('number too big in {} quantifier', maxAt);
    if (max !== undefined && max < min) this.fail('numbers out of order in {} quantifier', maxAt);
  }

  private escape(): void {
    const letter = this.escapeLetter();
    if (letter === 'N') {
      const braces = this.source[this.index] === '{';
      const repeat = braces ? bracedQuantifier(this.source.slice(this.index)) : undefined;
      if (repeat) this.checkQuantifierRange(repeat.min, repeat.max, this.index);
      if (!braces || repeat) {
        this.emit(String.raw`[^\n]`, true);
        return;
      }
    }
    const set = this.setEscape(letter);
    if (set) {
      this.emit(`[${set.negated ? '^' : ''}${set.content}]`, true);
      return;
    }
    const assertion = this.assertionEscape(letter);
    if (assertion !== undefined) {
      this.emit(assertion, false);
      return;
    }
    const value = this.characterEscape(letter);
    if (value === undefined) this.otherEscape(letter);
    else this.emit(this.characterText(value), true);
  }

  /** Reads the character after a backslash, leaving the index after it. */
  private escapeLetter(): string {
    const code = this.source.codePointAt(this.index + 1);
    const letter = code === undefined ? '' : String.fromCodePoint(code);
    this.index += 1 + letter.length;
    if (letter === '') this.fail(String.raw`\ at end of pattern`, this.index);
    return letter;
  }

  /** The class that `\d`, `\w`, `\s`, `\h`, `\v`, `\p`, and their negations stand for. */
  private setEscape(letter: string): CharacterSet | undefined {
    if (letter === 'p' || letter === 'P') return this.property(letter);
    const content = (this.options.utf8 ? UCP_SETS : BYTE_SETS).get(letter.toLowerCase());
    return content === undefined ? undefined : { content, negated: letter !== letter.toLowerCase() };
  }

  private property(letter: string): CharacterSet {
    const { name, negated } = this.propertyName();
    this.unicode = true;
    const set = unicodeProperty(name, (letter === 'P') !== negated);
    if (!set) this.fail(String.raw`unknown property after \P or \p`, this.index);
    return set;
  }

  // code-gauge-allow functionCognitiveComplexity -- Uses one cursor for the property name and its diagnostics.
  private propertyName(): { name: string; negated: boolean } {
    const first = this.propertyCharacter();
    let name = '';
    let negated = false;
    if (first === '{') {
      while (name.length < 49 && this.index < this.source.length) {
        const char = this.propertyCharacter();
        if (/[-_ \t-\r]/.test(char)) continue;
        if (char === '^' && name === '' && !negated) negated = true;
        else if (char === '}') return { name, negated };
        else if (char >= '&' && char <= 'z') name += char;
        else break;
      }
    } else if (/[A-Za-z]/.test(first)) return { name: first, negated };
    this.fail(String.raw`malformed \P or \p sequence`, this.index);
  }

  private propertyCharacter(): string {
    const code = this.source.codePointAt(this.index);
    if (code === undefined) return '';
    const char = String.fromCodePoint(code);
    this.index += char.length;
    return char;
  }

  private assertionEscape(letter: string): string | undefined {
    switch (letter) {
      case 'A': {
        return String.raw`(?<![\s\S])`;
      }
      case 'z': {
        return String.raw`(?![\s\S])`;
      }
      case 'Z': {
        return String.raw`(?=\n?(?![\s\S]))`;
      }
      case 'b':
      case 'B': {
        return this.options.utf8 ? unicodeBoundary(letter === 'B') : `\\${letter}`;
      }
      case 'G': {
        // Only a leading \G is a property of the whole match, which a sticky regex has.
        if (this.index !== 2 || this.result !== '') unsupported(String.raw`先頭以外の \G`);
        this.sticky = true;
        return '';
      }
      case 'K': {
        return this.keep();
      }
    }
    return undefined;
  }

  /** Marks where `\K` is passed with an empty capture, from which the reported match starts. */
  private keep(): string {
    if (this.frames.some((frame) => frame.lookaround)) this.keepInLookaround = true;
    for (const open of this.frames) open.keeps = true;
    const name = `$k${this.keeps.length}`;
    this.keeps.push(name);
    return `(?<${name}>)`;
  }

  /** The code point that an escape stands for, or undefined if it stands for something else. */
  private characterEscape(letter: string): number | undefined {
    const simple = SIMPLE_ESCAPES.get(letter);
    if (simple !== undefined) return simple;
    switch (letter) {
      case 'x': {
        if (this.source[this.index] === '{') return this.bracedNumber(16, String.raw`non-hex character in \x{}`);
        const digits = this.readMatch(/^[\dA-Fa-f]{1,2}/);
        if (!digits) this.fail(DIGITS_MISSING, this.index);
        return Number.parseInt(digits[0], 16);
      }
      case 'o': {
        if (this.source[this.index] !== '{') this.fail(String.raw`missing opening brace after \o`, this.index);
        return this.bracedNumber(8, String.raw`non-octal character in \o{}`);
      }
      case '0': {
        return Number.parseInt(`0${this.readMatch(/^[0-7]{0,2}/)?.[0] ?? ''}`, 8);
      }
      case 'c': {
        return this.controlEscape();
      }
      case 'N': {
        if (!this.source.startsWith('{U+', this.index)) this.fail(UNSUPPORTED_CASE_ESCAPE, this.index + 1);
        this.index += 3;
        if (!this.options.utf8) {
          this.readMatch(/^[\dA-Fa-f]*\}?/);
          this.fail(String.raw`\N{U+dddd} is supported only in Unicode (UTF) mode`, this.index);
        }
        return this.readEscapeNumber(16, String.raw`non-hex character in \x{}`);
      }
    }
    return /[\dA-Za-z]/.test(letter) ? undefined : (letter.codePointAt(0) as number);
  }

  /** Reads `{digits}` after `\x` or `\o`. */
  private bracedNumber(radix: 8 | 16, badDigit: string): number {
    this.index++;
    return this.readEscapeNumber(radix, badDigit);
  }

  private readEscapeNumber(radix: 8 | 16, badDigit: string): number {
    const digits = (this.readMatch(radix === 16 ? /^[\dA-Fa-f]*/ : /^[0-7]*/) as RegExpExecArray)[0];
    const next = this.source[this.index];
    if (digits === '' && (next === undefined || next === '}')) this.fail(DIGITS_MISSING, this.index);
    const value = digits === '' ? 0 : this.validateCodePoint(Number.parseInt(digits, radix), this.index);
    if (next !== '}') this.fail(`${badDigit} (closing brace missing?)`, Math.min(this.index + 1, this.source.length));
    this.index++;
    return value;
  }

  private validateCodePoint(value: number, index: number): number {
    if (value > (this.options.utf8 ? 0x10_ff_ff : 0xff))
      this.fail(String.raw`character code point value in \x{} or \o{} is too large`, index);
    if (value >= 0xd8_00 && value <= 0xdf_ff)
      this.fail('disallowed Unicode code point (>= 0xd800 && <= 0xdfff)', index);
    return value;
  }

  private controlEscape(): number {
    const char = this.source[this.index];
    if (char === undefined) this.fail(String.raw`\c at end of pattern`, this.index);
    this.index++;
    if (char < ' ' || char > '~') this.fail(String.raw`\c must be followed by a printable ASCII character`, this.index);
    return (char.toUpperCase().codePointAt(0) as number) ^ 0x40;
  }

  /** Consumes the text that `pattern` matches at the index. */
  private readMatch(pattern: RegExp): RegExpExecArray | undefined {
    const match = pattern.exec(this.source.slice(this.index)) ?? undefined;
    if (match) this.index += match[0].length;
    return match;
  }

  private characterText(value: number): string {
    return value > 0xff ? `\\u{${value.toString(16)}}` : `\\x${value.toString(16).padStart(2, '0')}`;
  }

  // code-gauge-allow functionNcss -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  private otherEscape(letter: string): void {
    switch (letter) {
      case 'Q': {
        this.quoted((char) => this.emit(literal(char), true));
        return;
      }
      case 'E': {
        return;
      }
      case 'R': {
        const vertical = (this.options.utf8 ? UCP_SETS : BYTE_SETS).get('v') as string;
        this.emit(String.raw`(?:\r\n|\r(?!\n)|(?:(?!\r)[${vertical}]))`, true);
        return;
      }
      case 'g': {
        this.gReference();
        return;
      }
      case 'k': {
        const open = this.source[this.index];
        if (open !== '<' && open !== "'" && open !== '{')
          this.fail(String.raw`\k is not followed by a braced, angle-bracketed, or quoted name`, this.index);
        this.index++;
        const { name, start } = this.readGroupName(open === '<' ? '>' : open === '{' ? '}' : "'");
        this.reference(name, start);
        return;
      }
      case 'X': {
        this.unavailable ??= String.raw`\X`;
        this.emit(String.raw`(?:[\s\S]+)`, true);
        return;
      }
      case 'C': {
        unsupported(String.raw`\C`);
      }
    }
    if (/[1-9]/.test(letter)) this.digitEscape(letter);
    else this.unknownEscape(letter);
  }

  /** Passes each character up to `\E` (or the end) to `add`, as `\Q` quotes them. */
  private quoted(add: (char: string) => void): void {
    const end = this.source.indexOf(String.raw`\E`, this.index);
    const text = this.source.slice(this.index, end === -1 ? this.source.length : end);
    for (const char of text) add(char);
    this.index = end === -1 ? this.source.length : end + 2;
  }

  /** Reads `\N` as PCRE does: a back reference if it can be one, otherwise an octal code. */
  private digitEscape(first: string): void {
    const digits = first + (/^\d*/.exec(this.source.slice(this.index)) as RegExpExecArray)[0];
    const number = Number(digits);
    if (number < 10 || first === '8' || first === '9' || number < this.names.length) {
      this.index += digits.length - 1;
      this.reference(number, this.index);
      return;
    }
    this.emit(this.characterText(this.octalEscape(first)), true);
  }

  /** Reads up to three octal digits starting with `first`, which the index is already after. */
  private octalEscape(first: string): number {
    const octal = (/^[0-7]{1,3}/.exec(first + this.source.slice(this.index, this.index + 2)) as RegExpExecArray)[0];
    this.index += octal.length - 1;
    const value = Number.parseInt(octal, 8);
    if (value > 0xff && !this.options.utf8) {
      this.fail(String.raw`octal value is greater than \377 in 8-bit non-UTF-8 mode`, this.index);
    }
    return value;
  }

  private gReference(): void {
    const opener = this.source[this.index];
    if (opener === '<' || opener === "'" || opener === '{') {
      this.delimitedGReference(opener);
      return;
    }
    const digits = this.readMatch(/^[+-]?\d+/)?.[0];
    if (!digits)
      this.fail(
        String.raw`\g is not followed by a braced, angle-bracketed, or quoted name/number or by a plain number`,
        this.index
      );
    const group = this.groupNumber(digits, this.index);
    if (group === 0) this.fail('reference to non-existent subpattern', this.index);
    this.reference(group, this.index);
  }

  private delimitedGReference(opener: '{' | '<' | "'"): void {
    const start = this.index++;
    const terminator = opener === '{' ? '}' : opener === '<' ? '>' : "'";
    if (opener === '{') this.readMatch(/^[ \t]*/);
    const digits = this.readMatch(/^[+-]?\d+/)?.[0];
    if (!digits) {
      const { name, start: nameStart } = this.readGroupName(terminator);
      if (opener === '{') this.reference(name, nameStart);
      else this.subroutine(name, nameStart);
      return;
    }
    const group = this.groupNumber(digits, start);
    if (opener === '{') this.readMatch(/^[ \t]*/);
    if (this.source[this.index] !== terminator)
      this.fail('syntax error in subpattern number (missing terminator?)', this.index);
    this.index++;
    if (opener === '{') {
      if (group === 0) this.fail('reference to non-existent subpattern', this.index);
      this.reference(group, this.index);
    } else this.subroutine(group, this.index);
  }

  private groupNumber(digits: string, at: number): number {
    const number = Number(digits);
    if (Math.abs(number) > 65_535) this.fail('subpattern number is too big', at);
    if (digits[0] !== '+' && digits[0] !== '-') return number;
    if (number === 0) this.fail('a relative value of zero is not allowed', at);
    const group = this.names.length - Number(number > 0) + number;
    if (group <= 0) this.fail('reference to non-existent subpattern', at);
    return group;
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  private parenthesizedSubroutine(rest: string): void {
    this.index += 2;
    if (rest.startsWith('&') || rest.startsWith('P>')) {
      this.index += rest.startsWith('&') ? 1 : 2;
      this.readGroupName(')', (name, start) => this.subroutine(name, start));
      return;
    }
    if (rest.startsWith('R')) {
      this.index++;
      const captureList = this.source[this.index] === '(';
      if (captureList) this.readSubroutineCaptures();
      if (this.source[this.index] !== ')') {
        const message = captureList
          ? 'missing closing parenthesis'
          : '(?R (recursive pattern call) must be followed by a closing parenthesis';
        this.fail(message, this.index);
      }
      this.index++;
      this.subroutine(0, this.index);
      return;
    }
    const digits = this.readMatch(/^[+-]?\d+/)?.[0];
    if (!digits) {
      const next = this.index + 1;
      if (next >= this.source.length) this.fail('missing closing parenthesis', next);
      this.fail('digit expected after (?+', next + 1);
    }
    this.subroutine(this.groupNumber(digits, this.index), this.index);
    if (this.source[this.index] === '(') this.readSubroutineCaptures();
    if (this.source[this.index] !== ')') this.fail('missing closing parenthesis', this.index);
    this.index++;
  }

  private readSubroutineCaptures(): void {
    do {
      this.index++;
      const start = this.index;
      const opener = this.source[this.index];
      const digits = this.readMatch(/^[+-]?\d+/)?.[0];
      if (digits) {
        const group = this.groupNumber(digits, this.index);
        if (group === 0) this.fail('reference to non-existent subpattern', this.index);
        this.references.push({ target: group, at: start, position: this.index, early: true });
      } else if (opener === '<' || opener === "'") {
        this.index++;
        const { name, start: nameStart } = this.readGroupName(opener === '<' ? '>' : "'");
        this.references.push({ target: name, at: nameStart, position: this.index, early: true });
      } else this.fail('expected capture group number or name', start);
    } while (this.source[this.index] === ',');
    if (this.source[this.index] !== ')') this.fail('missing closing parenthesis for condition', this.index);
    this.index++;
  }

  private subroutine(target: string | number, at: number): void {
    this.unavailable ??= '再帰';
    if (target === 0) this.emit(String.raw`(?:[\s\S]+)`, true);
    else this.reference(target, at);
  }

  private reference(target: number | string, at: number): void {
    this.rejectInLookbehind('後方参照');
    const index = this.references.length;
    this.references.push({ target, at, position: this.index, early: this.isEarlyReference(target) });
    const group = typeof target === 'number' ? target : (this.known?.names.indexOf(target) ?? -1);
    if (!this.known || group < 0) {
      // The first pass and a reference that is a compilation error emit nothing that is used.
      this.emit('(?:)', true);
      return;
    }
    const check = this.known.checked.has(index) ? participated(group) : '';
    this.emit(`(?:${check}\\k<${groupName(group)}>)`, true);
  }

  /** Whether a reference is read before its group ends, where the group may not have taken part yet. */
  private isEarlyReference(target: number | string): boolean {
    const group = typeof target === 'number' ? target : this.names.indexOf(target);
    return group < 0 || group >= this.names.length || this.frames.some((frame) => frame.own === group);
  }

  private unknownEscape(letter: string): never {
    this.fail('FLlUu'.includes(letter) ? UNSUPPORTED_CASE_ESCAPE : 'unrecognized character follows \\', this.index);
  }

  private openGroup(): void {
    const next = this.source[this.index + 1];
    if (next === '*') unsupported('(* で始まる指定');
    if (next === '?') {
      this.specialGroup(this.source.slice(this.index + 2));
      return;
    }
    this.index++;
    if (this.options.noAutoCapture) this.openFrame('(?:', ')');
    else this.captureGroup(undefined);
  }

  private captureGroup(name: string | undefined): void {
    this.noteInLookbehind('captures');
    const group = this.names.length;
    this.names.push(name);
    for (const frame of this.frames) {
      frame.groups.push(group);
      frame.alternativeGroups.push(group);
    }
    const open = `(?<${groupName(group)}>`;
    if (this.known?.marked.has(group)) this.openFrame(`${open}(?:`, `)${participationMarker(group)})`);
    else this.openFrame(open, ')');
    (this.frames.at(-1) as Frame).own = group;
  }

  private specialGroup(rest: string): void {
    const opening = /^(?:[:=!>]|<[=!])/.exec(rest)?.[0];
    if (opening) {
      const at = this.index;
      this.index += 2 + opening.length;
      this.unnamedGroup(opening, at);
      return;
    }
    if (rest.startsWith('#')) {
      this.skipGroupComment();
      return;
    }
    const prefix = /^(?:P?<|'|P=)/.exec(rest)?.[0];
    if (prefix) {
      this.index += 2 + prefix.length;
      const { name, start } = this.readGroupName(prefix === 'P=' ? ')' : prefix === "'" ? "'" : '>');
      if (prefix === 'P=') this.reference(name, start);
      else this.namedGroup(name);
      return;
    }
    if (/^(?:[R\d+]|-\d|&|P>)/.test(rest)) {
      this.parenthesizedSubroutine(rest);
      return;
    }
    unsupportedGroup(rest);
    if (rest.startsWith('P'))
      this.fail('unrecognized character after (?P', Math.min(this.index + 4, this.source.length));
    this.optionSetting();
  }

  private skipGroupComment(): void {
    const close = this.source.indexOf(')', this.index);
    if (close === -1) this.fail('missing ) after (?# comment', this.source.length);
    this.index = close + 1;
  }

  /** Opens a group that `(?` and `opening` start: non-capturing, atomic, or a lookaround. */
  private unnamedGroup(opening: string, at: number): void {
    if (opening === ':') {
      this.openFrame('(?:', ')');
    } else if (opening === '>') {
      // An atomic group matches as a lookahead, which JavaScript does not backtrack into, then takes its text.
      this.rejectInLookbehind('アトミックグループ');
      const name = `$a${this.hiddenGroups++}`;
      this.openFrame(`(?:(?=(?<${name}>`, `))\\k<${name}>)`);
    } else this.openFrame(`(?${opening}`, ')', opening.startsWith('<') ? 'behind' : 'ahead', at);
  }

  /** Reads an option setting, `(?i)` for the rest of the group or `(?i:` for a group, at the index. */
  private optionSetting(): void {
    const options = { ...this.options };
    const terminator = this.readOptionLetters(options);
    const modifier = options.caseless === this.options.caseless ? undefined : options.caseless ? '(?i:' : '(?-i:';
    if (terminator === ':') this.openFrame(modifier ?? '(?:', ')');
    else if (modifier) {
      (this.frames.at(-1) as Frame).modifiers.push(modifier);
      this.emit(modifier, false);
    } else this.repeatable = false;
    this.options = options;
  }

  /** Applies the letters of an option setting to `options`, returning the `)` or `:` that ends them. */
  // code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private readOptionLetters(options: PatternOptions): string {
    const start = this.index;
    this.index += 2;
    let unsetting = false;
    let extendedClass: boolean | undefined;
    let char = this.source[this.index++];
    if (char === '^') {
      for (const letter of 'imnsx') options[INLINE_OPTIONS.get(letter) as PatternOption] = false;
      options.extendedClass = false;
      char = this.source[this.index++];
    }
    while (char !== ')' && char !== ':') {
      if (char === undefined) this.fail('missing closing parenthesis', this.source.length);
      if (char === '-') {
        if (unsetting || this.source[start + 2] === '^') this.fail('invalid hyphen in option setting', this.index);
        unsetting = true;
      } else {
        this.setInlineOption(options, char, unsetting);
        if (char === 'x') {
          const doubled = this.source[this.index] === 'x';
          if (doubled) this.index++;
          extendedClass = !unsetting && (extendedClass === true || doubled);
        }
      }
      char = this.source[this.index++];
    }
    if (extendedClass !== undefined) options.extendedClass = extendedClass;
    return char;
  }

  private setInlineOption(options: PatternOptions, letter: string, unsetting: boolean): void {
    if (letter === 'a' || letter === 'r') {
      if (letter === 'a' && /^[DSWTP]$/.test(this.source[this.index] ?? '')) this.index++;
      this.unavailable ??= '途中のフラグの指定';
      return;
    }
    const option = INLINE_OPTIONS.get(letter);
    if (option === undefined) this.fail('unrecognized character after (? or (?-', this.index);
    options[option] = !unsetting;
    if (option === 'caseless') this.checkCaselessRestriction(options);
  }

  private checkCaselessRestriction(options: PatternOptions): void {
    if (options.utf8 && options.caseless && options.caselessRestricted)
      this.unavailable ??= 'Unicode 正規表現の大文字小文字の制限（r）';
  }

  private readGroupName(
    terminator: string,
    subroutine?: (name: string, start: number) => void
  ): { name: string; start: number } {
    if (terminator === '}') this.readMatch(/^[ \t]*/);
    const start = this.index;
    const digit = this.readMatch(this.options.utf8 ? /^\p{Nd}/u : /^\d/);
    if (digit) this.fail('subpattern name must start with a non-digit', this.index);
    const name = this.readMatch(this.options.utf8 ? /^[\p{L}\p{Nd}_]+/u : /^\w+/)?.[0];
    if (!name) this.fail('subpattern name expected', this.index);
    if ((this.options.utf8 ? enc(name).length : name.length) > 128)
      this.fail('subpattern name is too long (maximum 128 code units)', this.index);
    if (terminator === '}') this.readMatch(/^[ \t]*/);
    if (subroutine) {
      subroutine(name, start);
      if (this.source[this.index] === '(') this.readSubroutineCaptures();
    }
    if (this.source[this.index] !== terminator) {
      if (subroutine) this.fail('missing closing parenthesis', this.index);
      this.fail('syntax error in subpattern name (missing terminator?)', this.index);
    }
    this.index++;
    return { name, start };
  }

  private namedGroup(name: string): void {
    if (this.names.includes(name)) {
      if (this.options.duplicateNames) unsupported('同じ名前のグループ');
      this.fail('two named subpatterns have the same name (PCRE2_DUPNAMES not set)', this.index);
    }
    this.captureGroup(name);
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  private characterClass(): void {
    const direction = this.source[this.index + 3];
    if ((direction === '<' || direction === '>') && this.source.startsWith(`[[:${direction}:]]`, this.index)) {
      this.index += 7;
      const boundary = this.assertionEscape('b');
      const word = (this.options.utf8 ? UCP_SETS : BYTE_SETS).get('w');
      this.emit(`(?:${boundary}(?${direction === '<' ? '=' : '<='}[${word}]))`, true);
      return;
    }
    const posix = this.posixEnd();
    if (posix !== undefined) {
      const reason =
        this.source[this.index + 1] === ':'
          ? 'POSIX named classes are supported only within a class'
          : 'POSIX collating elements are not supported';
      this.fail(reason, posix);
    }
    this.index++;
    const state = { quoted: false };
    this.seekClassToken(state);
    const negated = !state.quoted && this.source[this.index] === '^';
    if (negated) this.index++;
    const members: ClassMembers = { content: '', alternatives: [] };
    let empty = true;
    for (;;) {
      this.seekClassToken(state);
      if (!empty && !state.quoted && this.source[this.index] === ']') break;
      if (this.index >= this.source.length) {
        this.fail('missing terminating ] for character class', this.source.length);
      }
      this.classMember(members, state);
      empty = false;
    }
    this.index++;
    this.emit(classText(members, negated), true);
  }

  private classMember(members: ClassMembers, state: ClassLexicalState): void {
    const start = this.classAtom(state);
    this.seekClassToken(state);
    if (state.quoted || this.source[this.index] !== '-' || !this.startClassRange(state)) {
      addClassAtom(members, start);
      return;
    }
    if (!('value' in start)) this.fail('invalid range in character class', this.index);
    const end = this.classAtom(state);
    if (!('value' in end)) this.fail('invalid range in character class', this.index);
    if (end.value < start.value) this.fail('range out of order in character class', this.index);
    members.content += `${start.text}-${end.text}`;
  }

  private seekClassToken(state: ClassLexicalState): void {
    for (;;) {
      if (!state.quoted && this.options.extendedClass) this.readMatch(/^[ \t]*/);
      if (this.source.startsWith(String.raw`\E`, this.index)) state.quoted = false;
      else if (!state.quoted && this.source.startsWith(String.raw`\Q`, this.index)) state.quoted = true;
      else return;
      rt().spend();
      this.index += 2;
    }
  }

  private startClassRange(state: ClassLexicalState): boolean {
    const dash = this.index++;
    this.seekClassToken(state);
    if (this.index < this.source.length && (state.quoted || this.source[this.index] !== ']')) return true;
    this.index = dash;
    state.quoted = false;
    return false;
  }

  private posixEnd(): number | undefined {
    if (this.source[this.index] !== '[') return undefined;
    const marker = this.source[this.index + 1];
    if (marker !== ':' && marker !== '.' && marker !== '=') return undefined;
    const start = this.index + 2;
    for (let index = start; index + 1 < this.source.length; index++) {
      if (((index - start) & 63) === 0) rt().spend();
      const char = this.source[index],
        next = this.source[index + 1];
      if (char === '\\' && (next === ']' || next === '\\')) index++;
      else if (char === ']' || (char === '[' && next === marker)) return undefined;
      else if (char === marker && next === ']') return index + 2;
    }
    return undefined;
  }

  private classAtom(state: ClassLexicalState): ClassCharacter | CharacterSet {
    if (!state.quoted) {
      const posix = this.posixEnd();
      if (posix !== undefined) return this.posixClass(posix);
      if (this.source[this.index] === '\\') return this.classEscape();
    }
    const char = String.fromCodePoint(this.source.codePointAt(this.index) as number);
    this.index += char.length;
    return { text: classLiteral(char), value: char.codePointAt(0) as number };
  }

  private posixClass(end: number): CharacterSet {
    if (this.source[this.index + 1] !== ':') this.fail('POSIX collating elements are not supported', end);
    const negated = this.source[this.index + 2] === '^';
    const name = this.source.slice(this.index + (negated ? 3 : 2), end - 2);
    this.index = end;
    const content = (this.options.utf8 ? UCP_POSIX_CLASSES : BYTE_POSIX_CLASSES).get(name);
    if (content === undefined) this.fail('unknown POSIX class name', end);
    if (!this.options.utf8) return { content, negated };
    if (name === 'graph' || name === 'print') {
      const excluded = name === 'graph' ? String.raw`${UCP_NONPRINTING_FORMATS}\u180E` : UCP_NONPRINTING_FORMATS;
      return { content, negated, excluded };
    }
    return { content, negated, exact: (name === 'upper' || name === 'lower') && this.options.caseless };
  }

  private classEscape(): ClassCharacter | CharacterSet {
    const letter = this.escapeLetter();
    if (letter === 'N' && this.source[this.index] !== '{')
      this.fail(String.raw`\N is not supported in a class`, this.index);
    if ('ABCGKRXZz'.includes(letter)) this.fail('escape sequence is invalid in character class', this.index);
    const set = this.setEscape(letter);
    if (set) return set;
    if (letter === 'b') return { text: String.raw`\x08`, value: 8 };
    if ('gk89'.includes(letter)) return { text: letter, value: letter.codePointAt(0) as number };
    if (/[1-7]/.test(letter)) {
      const value = this.octalEscape(letter);
      return { text: this.characterText(value), value };
    }
    const value = this.characterEscape(letter);
    if (value === undefined) this.unknownEscape(letter);
    return { text: this.characterText(value), value };
  }
}

/** Escapes a character that JavaScript's regex syntax would otherwise read as an operator. */
function literal(char: string): string {
  return String.raw`\^$.*+?()[]{}|/`.includes(char) ? `\\${char}` : char;
}

function classLiteral(char: string): string {
  return String.raw`\]^-[`.includes(char) ? `\\${char}` : char;
}

function addClassAtom(members: ClassMembers, atom: ClassCharacter | CharacterSet): void {
  if ('value' in atom) members.content += atom.text;
  else if (atom.excluded) {
    const match = `(?![${atom.excluded}])[${atom.content}]`;
    members.alternatives.push(atom.negated ? `(?!${match})${ANY}` : match);
  } else if (atom.exact) members.alternatives.push(`(?-i:[${atom.negated ? '^' : ''}${atom.content}])`);
  else if (atom.negated) members.alternatives.push(`[^${atom.content}]`);
  else members.content += atom.content;
}

function classText({ content, alternatives }: ClassMembers, negated: boolean): string {
  if (alternatives.length === 0) return `[${negated ? '^' : ''}${content}]`;
  const regex = [...(content === '' ? [] : [`[${content}]`]), ...alternatives].join('|');
  return negated ? `(?:(?!${regex})${ANY})` : `(?:${regex})`;
}

/** Rejects the groups that JavaScript cannot express, which start with `(?` followed by `rest`. */
function unsupportedGroup(rest: string): void {
  if (rest.startsWith('(')) unsupported('条件分岐');
  if (rest.startsWith('|')) unsupported('グループ番号のリセット');
}

/** An empty assertion that tells references whether the group it ends took part, by capturing a character next to it. */
function participationMarker(group: number): string {
  return String.raw`(?=(?<$m${group}a>[\s\S])|(?<=(?<$m${group}b>[\s\S]))|)`;
}

/** Asserts that a marked group took part: one of its marker captures is not empty, or the subject is. */
function participated(group: number): string {
  const [after, before] = [String.raw`\k<$m${group}a>`, String.raw`\k<$m${group}b>`];
  return String.raw`(?=(?=${after}*(?!${after}))|(?=${before}*(?!${before}))|(?<![\s\S])(?![\s\S]))`;
}
