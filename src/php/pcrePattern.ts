// oxlint-disable unicorn/prefer-code-point -- PHP pattern strings contain bytes; UTF-8 validation reads each byte separately.
// code-gauge-allow-file fileNcss 760 -- Holds the cases of one concern of the interpreter, which share their helpers.
import propertyAliases from 'unicode-property-value-aliases-ecmascript';

import { dec, enc, utf8Length } from './bytes';
import { analyzeRegex } from './regexAnalysis';
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
  referenced: Set<number>;
  byteCaselessReferences: Set<string>;
}

export class PatternError extends Error {}

type PatternOption =
  | 'caseless'
  | 'multiline'
  | 'dotAll'
  | 'extended'
  | 'ungreedy'
  | 'dollarEndOnly'
  | 'anchored'
  | 'utf8'
  | 'noAutoCapture'
  | 'duplicateNames';

/** The pattern's modifiers; `utf8` (`u`) also turns on PCRE's UCP, so `\w`, `\d`, `\s`, `\b`, and POSIX classes match by Unicode properties. */
type PatternOptions = Record<PatternOption, boolean>;

const MODIFIERS = new Map<string, PatternOption | undefined>([
  ['i', 'caseless'],
  ['m', 'multiline'],
  ['s', 'dotAll'],
  ['x', 'extended'],
  ['U', 'ungreedy'],
  ['D', 'dollarEndOnly'],
  ['A', 'anchored'],
  ['u', 'utf8'],
  ['n', 'noAutoCapture'],
  ['J', 'duplicateNames'],
  ['S', undefined],
  ['X', undefined],
  ['\n', undefined],
  ['\r', undefined],
  [' ', undefined],
]);

export function translate(pattern: string): Compiled {
  if (pattern.length > 32_768) throw new UnsupportedFeatureError('大きすぎる正規表現');
  const { body, modifiers } = splitDelimiters(pattern);
  const options: PatternOptions = {
    caseless: false,
    multiline: false,
    dotAll: false,
    extended: false,
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
    source = source.slice(leadingFlags[0].length);
  }
  const offsetBase = leadingFlags?.[0].length ?? 0;
  const layout = new PatternConverter(source, options, offsetBase).layout();
  if (layout.names.length > 256) throw new UnsupportedFeatureError('キャプチャが多すぎる正規表現');
  const converter = new PatternConverter(source, options, offsetBase, layout);
  const converted = converter.convert();
  if (converted.length > 65_536) throw new UnsupportedFeatureError('大きすぎる正規表現');
  const flags = `d${options.caseless ? 'i' : ''}${converter.unicode ? 'u' : ''}`;
  const byteCaselessReferences = analyzeRegex(converted, converter.unicode, options.utf8, options.caseless);
  return {
    regex: new RegExp(converted, `${options.anchored || converter.sticky ? 'y' : 'g'}${flags}`),
    retry: new RegExp(String.raw`(?=(?<$r>[\s\S]*))(?:${converted})(?!\k<$r>(?![\s\S]))`, `y${flags}`),
    utf8: options.utf8,
    names: converter.names,
    groupCount: converter.names.length - 1,
    keeps: converter.keeps,
    referenced: layout.referenced,
    byteCaselessReferences,
  };
}

/** The name under which the regexes capture a group of the pattern. */
export function groupName(group: number): string {
  return `$${group}`;
}

const BRACKETS: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };

function splitDelimiters(pattern: string): { body: string; modifiers: string } {
  const trimmed = pattern.replace(/^[ \t\n\r\v\f]+/, '');
  if (trimmed === '') throw new PatternError('Empty regular expression');
  const delimiter = trimmed[0];
  if (/[\dA-Za-z\\\0]/.test(delimiter)) {
    throw new PatternError('Delimiter must not be alphanumeric, backslash, or NUL byte');
  }
  const closing = BRACKETS[delimiter] ?? delimiter;
  let depth = 0;
  for (let index = 1; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === '\\') index++;
    else if (closing !== delimiter && char === delimiter) depth++;
    else if (char === closing && depth-- === 0)
      return { body: trimmed.slice(1, index), modifiers: trimmed.slice(index + 1) };
  }
  throw new PatternError(
    closing === delimiter
      ? `No ending delimiter '${delimiter}' found`
      : `No ending matching delimiter '${closing}' found`
  );
}

function applyModifier(options: PatternOptions, modifier: string): void {
  if (modifier === '\0') throw new PatternError('NUL byte is not a valid modifier');
  if (!MODIFIERS.has(modifier)) throw new PatternError(`Unknown modifier '${modifier}'`);
  const option = MODIFIERS.get(modifier);
  if (option) options[option] = true;
}

/** Characters that a class matches: JavaScript class contents, which `negated` complements. */
interface CharacterSet {
  content: string;
  negated: boolean;
  /** Whether caseless matching leaves the class as it is, as it does PCRE's `[:upper:]` and `[:lower:]` under UCP. */
  exact?: boolean;
}

/** A class member that a range can start or end with. */
interface ClassCharacter {
  text: string;
  value: number;
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
  lookaround: boolean;
}

/** What the first pass over a pattern finds that the second needs. */
interface Layout {
  names: (string | undefined)[];
  /**
   * The groups that back references read, which get markers telling whether they took part:
   * PCRE fails a reference to a group that did not, where JavaScript matches the empty string.
   */
  marked: Set<number>;
  referenced: Set<number>;
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

const ANY = String.raw`[\s\S]`;
const BYTE_SETS = new Map([
  ['d', '0-9'],
  ['w', 'A-Za-z0-9_'],
  ['s', String.raw`\t-\r `],
  ['h', String.raw`\t \xa0`],
  ['v', String.raw`\n-\r\x85`],
]);
const UCP_SETS = new Map([
  ['d', String.raw`\p{Nd}`],
  ['w', String.raw`\p{L}\p{N}\p{Mn}\p{Pc}`],
  ['s', String.raw`\t-\r \x85\xa0 ᠎ - \u2028\u2029  　`],
  ['h', String.raw`\t \xa0 ᠎ -   　`],
  ['v', String.raw`\n-\r\x85\u2028\u2029`],
]);
const BYTE_POSIX_CLASSES = new Map([
  ['alpha', 'A-Za-z'],
  ['digit', '0-9'],
  ['alnum', 'A-Za-z0-9'],
  ['upper', 'A-Z'],
  ['lower', 'a-z'],
  ['space', String.raw`\t-\r `],
  ['blank', String.raw` \t`],
  ['punct', '!-\\/:-@\\[-`{-~'],
  ['xdigit', '0-9A-Fa-f'],
  ['word', 'A-Za-z0-9_'],
  ['cntrl', String.raw`\x00-\x1f\x7f`],
  ['print', ' -~'],
  ['graph', '!-~'],
]);
const UCP_GRAPH = String.raw`\p{L}\p{M}\p{N}\p{P}\p{S}\p{Cf}`;
const UCP_POSIX_CLASSES = new Map([
  ['alpha', String.raw`\p{L}`],
  ['digit', String.raw`\p{Nd}`],
  ['alnum', String.raw`\p{L}\p{N}`],
  ['upper', String.raw`\p{Lu}`],
  ['lower', String.raw`\p{Ll}`],
  ['space', UCP_SETS.get('s') as string],
  ['blank', UCP_SETS.get('h') as string],
  ['punct', String.raw`\p{P}$+<=>^` + '`|~'],
  ['xdigit', String.raw`0-9A-Fa-f０-９Ａ-Ｆａ-ｆ`],
  ['word', UCP_SETS.get('w') as string],
  ['cntrl', String.raw`\p{Cc}`],
  ['print', String.raw`${UCP_GRAPH}\p{Zs}`],
  ['graph', UCP_GRAPH],
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
  private index = 0;
  private result = '';
  /** Whether the last item can take a quantifier. */
  private repeatable = false;
  /** Where the last repeatable item starts in the result. */
  private itemStart = 0;
  private readonly frames: Frame[];
  private readonly references: { target: number | string; at: number }[] = [];
  /** Where each group and `\K` point starts in the result, which possessive quantifiers shift. */
  private readonly groupStarts: number[] = [-1];
  private readonly keepStarts: number[] = [];
  private hiddenGroups = 0;
  private alternation = false;
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
    this.known = known;
    this.frames = [{ start: 0, outer: this.options, close: '', modifiers: [], lookaround: false }];
  }

  /** Converts the pattern to learn its layout, which a second converter needs for references to later groups. */
  layout(): Layout {
    this.convert();
    const marked = new Set<number>();
    for (const { target } of this.references) {
      const group = typeof target === 'number' ? target : this.names.indexOf(target);
      marked.add(group);
    }
    return {
      names: this.names,
      marked,
      referenced: new Set(
        this.references.map(({ target }) => (typeof target === 'number' ? target : this.names.indexOf(target)))
      ),
    };
  }

  convert(): string {
    while (this.index < this.source.length) {
      rt().spend();
      this.item();
    }
    if (this.frames.length > 1) this.fail('missing closing parenthesis', this.source.length);
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

  // code-gauge-allow functionNcss 31 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
        this.quantifier(char, this.index + 1, char !== '?');
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
    if (repeatable) this.itemStart = this.result.length;
    this.result += text;
    this.repeatable = repeatable;
  }

  private openFrame(open: string, close: string, lookaround = false): void {
    this.frames.push({ start: this.result.length, outer: this.options, close, modifiers: [], lookaround });
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
  }

  /** Emits `|`, where the option settings so far in the group still apply. */
  private alternative(): void {
    this.index++;
    const { modifiers } = this.frames.at(-1) as Frame;
    if (this.frames.length === 1) this.alternation = true;
    this.emit(`${')'.repeat(modifiers.length)}|${modifiers.join('')}`, false);
  }

  private fail(message: string, index: number): never {
    const offset = this.options.utf8 ? enc(this.source.slice(0, index)).length : index;
    throw new PatternError(`Compilation failed: ${message} at offset ${this.offsetBase + offset}`);
  }

  /** Emits a quantifier ending at `end`, with the lazy (`?`) or possessive (`+`) suffix that follows it. */
  private quantifier(text: string, end: number, repeats: boolean): void {
    if (!this.repeatable) this.fail('quantifier does not follow a repeatable item', end);
    this.index = end;
    if (repeats) this.repeatItem();
    const suffix = this.source[end];
    if (suffix === '+') {
      this.index++;
      this.possessive(text);
      return;
    }
    const lazy = suffix === '?';
    if (lazy) this.index++;
    this.emit(lazy === this.options.ungreedy ? text : `${text}?`, false);
  }

  /** Notes the groups in the item that a quantifier repeats, whose captures JavaScript forgets at each repetition. */
  private repeatItem(): void {
    const first = startIndex(this.groupStarts, this.itemStart);
    if (
      this.groupStarts.length - first > 1 ||
      (first < this.groupStarts.length && this.groupStarts[first] > this.itemStart)
    )
      unsupported('入れ子のキャプチャを含む繰り返し');
    if ((this.keepStarts.at(-1) ?? -1) >= this.itemStart) unsupported(String.raw`繰り返される \K`);
  }

  /** Repeats the last item atomically, as a lookahead does, which JavaScript does not backtrack into. */
  private possessive(quantifier: string): void {
    const name = `$a${this.hiddenGroups++}`;
    const open = `(?:(?=(?<${name}>`;
    for (const starts of [this.groupStarts, this.keepStarts]) {
      for (let index = startIndex(starts, this.itemStart); index < starts.length; index++) {
        rt().spend();
        starts[index] += open.length;
      }
    }
    const before = this.result.slice(0, this.itemStart);
    this.result = `${before}${open}${this.result.slice(this.itemStart)}${quantifier}))\\k<${name}>)`;
    this.repeatable = false;
  }

  /** Reads `{n}`, `{n,}`, `{n,m}`, or `{,m}` (spaces allowed inside since PCRE2 10.43), or a literal `{`. */
  private brace(): void {
    const match = /^\{[ \t]*(\d*)[ \t]*(?:(,)[ \t]*(\d*)[ \t]*)?\}/.exec(this.source.slice(this.index));
    if (!match || (match[1] === '' && !match[3])) {
      this.index++;
      this.emit(String.raw`\{`, true);
      return;
    }
    const close = this.index + match[0].length - 1;
    const min = Number(match[1]);
    const max = match[2] && match[3] === '' ? undefined : Number(match[3] ?? match[1]);
    if (min > 0xff_ff || (max ?? 0) > 0xff_ff) this.fail('number too big in {} quantifier', close);
    if (max !== undefined && max < min) this.fail('numbers out of order in {} quantifier', close);
    this.quantifier(max === min ? `{${min}}` : `{${min},${max ?? ''}}`, close + 1, max === undefined || max > 1);
  }

  private escape(): void {
    const letter = this.escapeLetter();
    if (letter === 'N' && this.source[this.index] !== '{') {
      this.emit(String.raw`[^\n]`, true);
      return;
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
    const match = /^(?:\{(\^?)([\w&= \t-\r-]+)\}|(\w))/.exec(this.source.slice(this.index));
    if (!match) {
      const end = this.source[this.index] === '{' ? this.source.length : this.index + 1;
      this.fail(String.raw`malformed \P or \p sequence`, Math.min(end, this.source.length));
    }
    this.index += match[0].length;
    this.unicode = true;
    const set = unicodeProperty(match[2] ?? match[3], (letter === 'P') !== (match[1] === '^'));
    if (!set) this.fail(String.raw`unknown property after \P or \p`, this.index);
    return set;
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
    const name = `$k${this.keeps.length}`;
    this.keeps.push(name);
    this.keepStarts.push(this.result.length);
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
        const braced = this.readMatch(/^\{U\+([\dA-Fa-f]+)\}/);
        if (!braced || !this.options.utf8) this.fail(UNSUPPORTED_CASE_ESCAPE, this.index);
        return Number.parseInt(braced[1], 16);
      }
    }
    return /[\dA-Za-z]/.test(letter) ? undefined : (letter.codePointAt(0) as number);
  }

  /** Reads `{digits}` after `\x` or `\o`. */
  private bracedNumber(radix: 8 | 16, badDigit: string): number {
    this.index++;
    const digits = (this.readMatch(radix === 16 ? /^[\dA-Fa-f]*/ : /^[0-7]*/) as RegExpExecArray)[0];
    if (this.source[this.index] !== '}') this.fail(`${badDigit} (closing brace missing?)`, this.index + 1);
    if (digits === '') this.fail(DIGITS_MISSING, this.index);
    const value = Number.parseInt(digits, radix);
    if (value > (this.options.utf8 ? 0x10_ff_ff : 0xff)) {
      this.fail(String.raw`character code point value in \x{} or \o{} is too large`, this.index);
    }
    this.index++;
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
        const name = this.readMatch(/^(?:<(\w+)>|'(\w+)'|\{(\w+)\})/);
        if (!name) this.fail(String.raw`\k is not followed by a braced, angle-bracketed, or quoted name`, this.index);
        this.reference(name[1] ?? name[2] ?? name[3], this.index - name[0].length + 1);
        return;
      }
      case 'C':
      case 'X': {
        unsupported(`\\${letter}`);
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
    const start = this.index;
    const match = this.readMatch(/^(?:\{([+-]?\d+|[A-Za-z_]\w*)\}|([+-]?\d+)|<[^>]*>|'[^']*')/);
    if (!match) {
      this.fail(
        String.raw`\g is not followed by a braced, angle-bracketed, or quoted name/number or by a plain number`,
        this.index
      );
    }
    const target = match[1] ?? match[2];
    if (target === undefined) unsupported('再帰');
    if (!/^[+-]?\d+$/.test(target)) {
      this.reference(target, start + 1);
      return;
    }
    const number = Number(target);
    const group = /^[+-]/.test(target) ? this.names.length - 1 + number + (number > 0 ? 0 : 1) : number;
    if (group <= 0) this.fail('reference to non-existent subpattern', start);
    this.reference(group, this.index);
  }

  private reference(target: number | string, at: number): void {
    this.references.push({ target, at });
    const group = typeof target === 'number' ? target : (this.known?.names.indexOf(target) ?? -1);
    if (!this.known || group < 0) {
      // The first pass and a reference that is a compilation error emit nothing that is used.
      this.emit('(?:)', true);
      return;
    }
    const check = this.known.marked.has(group) ? participated(group) : '';
    this.emit(`(?:${check}\\k<${groupName(group)}>)`, true);
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
    const group = this.names.length;
    this.names.push(name);
    this.groupStarts.push(this.result.length);
    const open = `(?<${groupName(group)}>`;
    if (this.known?.marked.has(group)) this.openFrame(`${open}(?:`, `)${participationMarker(group)})`);
    else this.openFrame(open, ')');
  }

  private specialGroup(rest: string): void {
    const named = /^(?:P?<([A-Za-z_]\w*)>|'([A-Za-z_]\w*)')/.exec(rest);
    if (named) {
      this.namedGroup(named[1] ?? named[2], named[0].length);
      return;
    }
    const digitName = /^(?:P?<|')\d/.exec(rest);
    if (digitName) this.fail('subpattern name must start with a non-digit', this.index + 2 + digitName[0].length);
    const backReference = /^P=(\w+)\)/.exec(rest);
    if (backReference) {
      const at = this.index + 4;
      this.index += 2 + backReference[0].length;
      this.reference(backReference[1], at);
      return;
    }
    const opening = /^(?:[:=!>]|<[=!])/.exec(rest)?.[0];
    if (opening) {
      this.index += 2 + opening.length;
      this.unnamedGroup(opening);
      return;
    }
    if (rest.startsWith('#')) {
      const close = this.source.indexOf(')', this.index);
      if (close === -1) this.fail('missing ) after (?# comment', this.source.length);
      this.index = close + 1;
      return;
    }
    unsupportedGroup(rest);
    this.optionSetting();
  }

  /** Opens a group that `(?` and `opening` start: non-capturing, atomic, or a lookaround. */
  private unnamedGroup(opening: string): void {
    if (opening === ':') {
      this.openFrame('(?:', ')');
    } else if (opening === '>') {
      // An atomic group matches as a lookahead, which JavaScript does not backtrack into, then takes its text.
      const name = `$a${this.hiddenGroups++}`;
      this.openFrame(`(?:(?=(?<${name}>`, `))\\k<${name}>)`);
    } else this.openFrame(`(?${opening}`, ')', true);
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
  private readOptionLetters(options: PatternOptions): string {
    const start = this.index;
    this.index += 2;
    let unsetting = false;
    let char = this.source[this.index++];
    if (char === '^') {
      for (const letter of 'imnsx') options[INLINE_OPTIONS.get(letter) as PatternOption] = false;
      char = this.source[this.index++];
    }
    while (char !== ')' && char !== ':') {
      if (char === undefined) this.fail('missing closing parenthesis', this.source.length);
      if (char === '-') {
        if (unsetting || this.source[start + 2] === '^') this.fail('invalid hyphen in option setting', this.index);
        unsetting = true;
      } else this.setInlineOption(options, char, unsetting);
      char = this.source[this.index++];
    }
    return char;
  }

  private setInlineOption(options: PatternOptions, letter: string, unsetting: boolean): void {
    if ((letter === 'x' && this.source[this.index] === 'x') || letter === 'a' || letter === 'r') {
      unsupported('途中のフラグの指定');
    }
    const option = INLINE_OPTIONS.get(letter);
    if (option === undefined) this.fail('unrecognized character after (? or (?-', this.index);
    options[option] = !unsetting;
  }

  private namedGroup(name: string, length: number): void {
    this.index += 2 + length;
    if (this.names.includes(name)) {
      if (this.options.duplicateNames) unsupported('同じ名前のグループ');
      this.fail('two named subpatterns have the same name (PCRE2_DUPNAMES not set)', this.index);
    }
    this.captureGroup(name);
  }

  private characterClass(): void {
    this.index++;
    const negated = this.source[this.index] === '^';
    if (negated) this.index++;
    const members: ClassMembers = { content: '', alternatives: [] };
    let empty = true;
    while (empty || this.source[this.index] !== ']') {
      if (this.index >= this.source.length) {
        this.fail('missing terminating ] for character class', this.source.length);
      }
      if (this.classMember(members)) empty = false;
    }
    this.index++;
    this.emit(classText(members, negated), true);
  }

  /** Reads a member of a class, returning whether it added any character (`\E` and an empty `\Q\E` do not). */
  private classMember(members: ClassMembers): boolean {
    if (this.source.startsWith(String.raw`\Q`, this.index)) {
      this.index += 2;
      const before = members.content;
      this.quoted((char) => (members.content += classLiteral(char)));
      return members.content !== before;
    }
    if (this.source.startsWith(String.raw`\E`, this.index)) {
      this.index += 2;
      return false;
    }
    const start = this.classAtom();
    const next = this.source[this.index + 1];
    if (this.source[this.index] !== '-' || next === undefined || next === ']') {
      addClassAtom(members, start);
      return true;
    }
    this.index++;
    if (!('value' in start)) this.fail('invalid range in character class', this.index);
    const end = this.classAtom();
    if (!('value' in end)) this.fail('invalid range in character class', this.index);
    if (end.value < start.value) this.fail('range out of order in character class', this.index);
    members.content += `${start.text}-${end.text}`;
    return true;
  }

  private classAtom(): ClassCharacter | CharacterSet {
    const posix = /^\[:(\^?)([A-Za-z]+):\]/.exec(this.source.slice(this.index));
    if (posix) {
      this.index += posix[0].length;
      const content = (this.options.utf8 ? UCP_POSIX_CLASSES : BYTE_POSIX_CLASSES).get(posix[2]);
      if (content === undefined) this.fail('unknown POSIX class name', this.index);
      const cased = posix[2] === 'upper' || posix[2] === 'lower';
      return { content, negated: posix[1] === '^', exact: cased && this.options.utf8 && this.options.caseless };
    }
    if (this.source[this.index] === '\\') return this.classEscape();
    const char = String.fromCodePoint(this.source.codePointAt(this.index) as number);
    this.index += char.length;
    return { text: classLiteral(char), value: char.codePointAt(0) as number };
  }

  private classEscape(): ClassCharacter | CharacterSet {
    const letter = this.escapeLetter();
    if (letter === 'N' && this.source[this.index] !== '{')
      this.fail(String.raw`\N is not supported in a class`, this.index);
    if ('ABCGKRXZz'.includes(letter)) this.fail('escape sequence is invalid in character class', this.index);
    const set = this.setEscape(letter);
    if (set) return set;
    if (letter === 'b') return { text: String.raw`\x08`, value: 8 };
    if (letter === 'g' || letter === 'k') return { text: letter, value: letter.codePointAt(0) as number };
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
  else if (atom.exact) members.alternatives.push(`(?-i:[${atom.negated ? '^' : ''}${atom.content}])`);
  else if (atom.negated) members.alternatives.push(`[^${atom.content}]`);
  else members.content += atom.content;
}

function classText({ content, alternatives }: ClassMembers, negated: boolean): string {
  if (alternatives.length === 0) return `[${negated ? '^' : ''}${content}]`;
  const regex = [...(content === '' ? [] : [`[${content}]`]), ...alternatives].join('|');
  return negated ? `(?:(?!${regex})${ANY})` : `(?:${regex})`;
}

/** `\b` or `\B` by PCRE's UCP word characters, which JavaScript's ASCII-only `\b` does not know. */
function unicodeBoundary(negated: boolean): string {
  const word = `[${UCP_SETS.get('w') as string}]`;
  const [wordAfterWord, wordAfterOther] = negated ? ['=', '!'] : ['!', '='];
  return `(?:(?<=${word})(?${wordAfterWord}${word})|(?<!${word})(?${wordAfterOther}${word}))`;
}

/** Rejects the groups that JavaScript cannot express, which start with `(?` followed by `rest`. */
function unsupportedGroup(rest: string): void {
  if (/^(?:[R\d+]|-\d)/.test(rest) || rest.startsWith('&') || rest.startsWith('P>')) unsupported('再帰');
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

const SCRIPT_ALIASES = looseAliases('Script');
const CATEGORY_ALIASES = new Map(
  'C Cc Cf Cn Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs'
    .split(' ')
    .map((name) => [name.toLowerCase(), name])
);

function looseAliases(property: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [alias, canonical] of propertyAliases.get(property) ?? []) {
    result.set(propertyKey(alias), canonical);
    result.set(propertyKey(canonical), canonical);
  }
  return result;
}

function propertyKey(name: string): string {
  return name.replaceAll(/[-_ \t-\r]/g, '').toLowerCase();
}

function unicodeProperty(name: string, negated: boolean): CharacterSet | undefined {
  name = propertyKey(name);
  const special = new Map([
    ['any', String.raw`\s\S`],
    ['l&', String.raw`\p{LC}`],
    ['xan', String.raw`\p{L}\p{N}`],
    ['xwd', UCP_SETS.get('w') as string],
    ['xsp', UCP_SETS.get('s') as string],
    ['xps', UCP_SETS.get('s') as string],
  ]).get(name);
  if (special !== undefined) return { content: special, negated };
  const explicit = /^(sc|script|scx|scriptextensions)=(.+)$/.exec(name);
  const script = explicit?.[1];
  const value = explicit?.[2] ?? name;
  const category = !explicit ? CATEGORY_ALIASES.get(value) : undefined;
  const canonical = category ?? SCRIPT_ALIASES.get(value);
  if (!canonical) return;
  const property = script === 'sc' || script === 'script' ? 'Script' : 'Script_Extensions';
  const content = category ? `\\p{${canonical}}` : `\\p{${property}=${canonical}}`;
  try {
    new RegExp(`[${content}]`, 'u');
    return { content, negated };
  } catch {
    return undefined;
  }
}

function startIndex(starts: number[], minimum: number): number {
  let left = 0,
    right = starts.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (starts[mid] < minimum) left = mid + 1;
    else right = mid;
  }
  return left;
}

function validatePatternUtf8(body: string): void {
  for (let index = 0; index < body.length;) {
    rt().spend();
    const length = utf8Length(body, index);
    if (body.charCodeAt(index) >= 128 && length === 1)
      throw new PatternError(`Compilation failed: UTF-8 error: ${patternUtf8Error(body, index)} at offset ${index}`);
    index += length;
  }
}

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function patternUtf8Error(body: string, index: number): string {
  const byte = body.charCodeAt(index);
  if (byte >= 0xfe) return 'illegal byte (0xfe or 0xff)';
  if (byte < 0xc0) return 'isolated byte with 0x80 bit set';
  let wanted = 2;
  if (byte >= 0xe0) wanted++;
  if (byte >= 0xf0) wanted++;
  if (byte >= 0xf8) wanted++;
  if (byte >= 0xfc) wanted++;
  const missing = index + wanted - body.length;
  if (missing > 0) return `${missing} byte${missing === 1 ? '' : 's'} missing at end`;
  let invalid = 1;
  while (invalid < wanted && (body.charCodeAt(index + invalid) & 0xc0) === 0x80) invalid++;
  if (invalid < wanted) return `byte ${invalid + 1} top bits not 0x80`;
  if (wanted > 4) return `${wanted}-byte character is not allowed (RFC 3629)`;
  if (byte >= 0xf5 || (byte === 0xf4 && body.charCodeAt(index + 1) >= 0x90))
    return 'code points greater than 0x10ffff are not defined';
  if (byte === 0xed && body.charCodeAt(index + 1) >= 0xa0) return 'code points 0xd800-0xdfff are not defined';
  return `overlong ${wanted}-byte sequence`;
}
