// code-gauge-allow-file fileNcss 524 -- Holds the cases of one concern of the interpreter, which share their helpers.
import { dec, enc } from './bytes';
import { UnsupportedFeatureError } from './unsupported';

/** A compiled pattern: the JavaScript regex and whether it matches UTF-8 text by characters (`u`). */
export interface Compiled {
  regex: RegExp;
  utf8: boolean;
  names: (string | undefined)[];
  groupCount: number;
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
  let source = options.utf8 ? dec(body) : body;
  const leadingFlags = /^\(\?([imsxU]+)\)/.exec(source);
  if (leadingFlags) {
    for (const flag of leadingFlags[1]) applyModifier(options, flag);
    source = source.slice(leadingFlags[0].length);
  }
  const converter = new PatternConverter(source, options, leadingFlags?.[0].length ?? 0);
  const converted = converter.convert();
  const flags = `g${options.caseless ? 'i' : ''}${converter.unicode ? 'u' : ''}`;
  const regex = new RegExp(options.anchored ? `^(?:${converted})` : converted, flags);
  return {
    regex,
    utf8: options.utf8,
    names: converter.names,
    groupCount: converter.names.length - 1,
  };
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
}

/** A class member that a range can start or end with. */
interface ClassCharacter {
  text: string;
  value: number;
}

interface ClassMembers {
  content: string;
  /** Contents of classes whose complements the class also matches, which a JavaScript class cannot nest. */
  complements: string[];
}

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
  ['s', String.raw`\t-\r \x85\xa0 ᠎ -     　`],
  ['h', String.raw`\t \xa0 ᠎ -   　`],
  ['v', String.raw`\n-\r\x85  `],
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
  private index = 0;
  private result = '';
  /** Whether the last item can take a quantifier. */
  private repeatable = false;
  private depth = 0;
  private readonly references: { target: number | string; at: number }[] = [];
  private readonly source: string;
  private readonly options: PatternOptions;
  /** The bytes of the pattern before `source`, which error offsets count. */
  private readonly offsetBase: number;

  constructor(source: string, options: PatternOptions, offsetBase: number) {
    this.source = source;
    this.options = options;
    this.offsetBase = offsetBase;
    this.unicode = options.utf8;
  }

  convert(): string {
    while (this.index < this.source.length) this.item();
    if (this.depth > 0) this.fail('missing closing parenthesis', this.source.length);
    for (const { target, at } of this.references) {
      const exists = typeof target === 'number' ? target < this.names.length : this.names.includes(target);
      if (!exists) this.fail('reference to non-existent subpattern', at);
    }
    return this.result;
  }

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
        if (this.depth === 0) this.fail('unmatched closing parenthesis', this.index + 1);
        this.depth--;
        break;
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
    this.index++;
    this.emit(this.metaCharacter(char) ?? literal(char), !'^$|'.includes(char));
  }

  private skipExtended(char: string): boolean {
    if (/\s/.test(char)) {
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
      case '|':
      case ')': {
        return char;
      }
    }
    return undefined;
  }

  private emit(text: string, repeatable: boolean): void {
    this.result += text;
    this.repeatable = repeatable;
  }

  private fail(message: string, index: number): never {
    const offset = this.options.utf8 ? enc(this.source.slice(0, index)).length : index;
    throw new PatternError(`Compilation failed: ${message} at offset ${this.offsetBase + offset}`);
  }

  /** Emits a quantifier ending at `end`, with the lazy (`?`) suffix that follows it. */
  private quantifier(text: string, end: number): void {
    if (!this.repeatable) this.fail('quantifier does not follow a repeatable item', end);
    this.index = end;
    if (this.source[end] === '+') unsupported('強欲な量指定子');
    const lazy = this.source[end] === '?';
    if (lazy) this.index++;
    this.emit(lazy === this.options.ungreedy ? text : `${text}?`, false);
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
    this.quantifier(max === min ? `{${min}}` : `{${min},${max ?? ''}}`, close + 1);
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
    const match = /^(?:\{(\^?)([\w&]+)\}|(\w))/.exec(this.source.slice(this.index));
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
      case 'G':
      case 'K': {
        unsupported(`\\${letter}`);
      }
    }
    return undefined;
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
        this.emit(String.raw`(?:\r\n|[${vertical}])`, true);
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
    this.emit(typeof target === 'number' ? `(?:\\${target})` : `\\k<${target}>`, true);
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
    this.depth++;
    if (this.options.noAutoCapture) {
      this.emit('(?:', false);
      return;
    }
    this.names.push(undefined);
    this.emit('(', false);
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
    const opening = /^(?:[:=!]|<[=!])/.exec(rest);
    if (opening) {
      this.index += 2 + opening[0].length;
      this.depth++;
      this.emit(`(?${opening[0]}`, false);
      return;
    }
    if (rest.startsWith('#')) {
      const close = this.source.indexOf(')', this.index);
      this.index = close === -1 ? this.source.length : close + 1;
      return;
    }
    unsupportedGroup(rest);
  }

  private namedGroup(name: string, length: number): void {
    this.index += 2 + length;
    if (this.names.includes(name)) {
      if (this.options.duplicateNames) unsupported('同じ名前のグループ');
      this.fail('two named subpatterns have the same name (PCRE2_DUPNAMES not set)', this.index);
    }
    this.names.push(name);
    this.depth++;
    this.emit(`(?<${name}>`, false);
  }

  private characterClass(): void {
    this.index++;
    const negated = this.source[this.index] === '^';
    if (negated) this.index++;
    const members: ClassMembers = { content: '', complements: [] };
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
      return { content, negated: posix[1] === '^' };
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
  else if (atom.negated) members.complements.push(atom.content);
  else members.content += atom.content;
}

function classText({ content, complements }: ClassMembers, negated: boolean): string {
  if (complements.length === 0) return `[${negated ? '^' : ''}${content}]`;
  const alternatives = [...(content === '' ? [] : [`[${content}]`]), ...complements.map((set) => `[^${set}]`)].join(
    '|'
  );
  return negated ? `(?:(?!${alternatives})${ANY})` : `(?:${alternatives})`;
}

/** `\b` or `\B` by PCRE's UCP word characters, which JavaScript's ASCII-only `\b` does not know. */
function unicodeBoundary(negated: boolean): string {
  const word = `[${UCP_SETS.get('w') as string}]`;
  const [wordAfterWord, wordAfterOther] = negated ? ['=', '!'] : ['!', '='];
  return `(?:(?<=${word})(?${wordAfterWord}${word})|(?<!${word})(?${wordAfterOther}${word}))`;
}

function unsupportedGroup(rest: string): never {
  if (rest.startsWith('>')) unsupported('アトミックグループ');
  if (/^[R\d+-]/.test(rest) || rest.startsWith('&') || rest.startsWith('P>')) unsupported('再帰');
  if (rest.startsWith('(')) unsupported('条件分岐');
  if (rest.startsWith('|')) unsupported('グループ番号のリセット');
  unsupported('途中のフラグの指定');
}

/**
 * The general categories that JavaScript's `\p` accepts by the same names as PCRE. Other names are scripts, which PCRE
 * matches by their script extensions (`\p{Han}` matches `、`).
 */
const GENERAL_CATEGORIES = new Set(
  'C Cc Cf Cn Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs'.split(' ')
);

/** The class of a PCRE property name, or undefined for a name that JavaScript does not know either. */
function unicodeProperty(name: string, negated: boolean): CharacterSet | undefined {
  const special = new Map([
    ['Any', String.raw`\s\S`],
    ['L&', String.raw`\p{LC}`],
    ['Xan', String.raw`\p{L}\p{N}`],
    ['Xwd', String.raw`\p{L}\p{N}_`],
    ['Xsp', UCP_SETS.get('s') as string],
    ['Xps', UCP_SETS.get('s') as string],
  ]).get(name);
  if (special !== undefined) return { content: special, negated };
  // PCRE matches property names loosely (`\p{han}`); JavaScript wants them capitalized.
  const capitalized = name[0].toUpperCase() + name.slice(1).toLowerCase();
  for (const candidate of new Set([name, capitalized])) {
    const content = GENERAL_CATEGORIES.has(candidate) ? `\\p{${candidate}}` : `\\p{Script_Extensions=${candidate}}`;
    try {
      new RegExp(`[${content}]`, 'u');
      return { content, negated };
    } catch {
      // Tries the next spelling.
    }
  }
  return undefined;
}
