/** A Java regular expression rewritten for JavaScript's `RegExp`. */
export interface TranslatedRegex {
  source: string;
  flags: string;
}

/** Thrown for a pattern that Java rejects or that JavaScript cannot express, with what makes it so. */
/** A pattern that Java rejects, or that uses what JavaScript cannot express, with where `Pattern` reports it. */
export class UnsupportedRegexError extends Error {
  constructor(
    readonly description: string,
    /** The index `PatternSyntaxException` reports, or -1 for none. */
    readonly index: number
  ) {
    super(description);
  }
}

/** The POSIX classes of `java.util.regex.Pattern`, which match ASCII characters only, as `v`-mode classes. */
const POSIX_CLASSES: Record<string, string> = {
  Lower: '[a-z]',
  Upper: '[A-Z]',
  ASCII: String.raw`[\x00-\x7F]`,
  Alpha: '[a-zA-Z]',
  Digit: '[0-9]',
  Alnum: '[a-zA-Z0-9]',
  Punct: String.raw`[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]`,
  Graph: String.raw`[\x21-\x7E]`,
  Print: String.raw`[\x20-\x7E]`,
  Blank: String.raw`[\x20\t]`,
  Cntrl: String.raw`[\x00-\x1F\x7F]`,
  XDigit: '[0-9a-fA-F]',
  Space: String.raw`[\x20\t\n\x0B\f\r]`,
};

/** The `java.lang.Character` classes, such as `\p{javaLowerCase}`, as the Unicode properties that decide them. */
const JAVA_CLASSES: Record<string, string> = {
  javaLowerCase: String.raw`\p{Lowercase}`,
  javaUpperCase: String.raw`\p{Uppercase}`,
  javaAlphabetic: String.raw`\p{Alphabetic}`,
  javaLetter: String.raw`\p{L}`,
  javaDigit: String.raw`\p{Nd}`,
  javaLetterOrDigit: String.raw`[\p{L}\p{Nd}]`,
  javaWhitespace: String.raw`[\t-\r\x1C-\x20  -  -    　]`,
  javaSpaceChar: String.raw`\p{Z}`,
};

/** The binary properties Java names with `Is`, as in `\p{IsAlphabetic}`. */
const BINARY_PROPERTIES: Record<string, string> = {
  alphabetic: 'Alphabetic',
  ideographic: 'Ideographic',
  letter: 'L',
  lowercase: 'Lowercase',
  uppercase: 'Uppercase',
  titlecase: 'Lt',
  punctuation: 'P',
  control: 'Cc',
  white_space: 'White_Space',
  whitespace: 'White_Space',
  digit: 'Nd',
  hex_digit: 'Hex_Digit',
  hexdigit: 'Hex_Digit',
  noncharacter_code_point: 'Noncharacter_Code_Point',
  assigned: 'Assigned',
};

const GENERAL_CATEGORY = /^(?:L[ultmo]?|M[nce]?|N[dlo]?|P[cdseifo]?|S[mcko]?|Z[slp]?|C[cfsno]?)$/;

/** Java's predefined classes that JavaScript reads differently, as `v`-mode classes. */
const ESCAPED_CLASSES: Record<string, string> = {
  s: String.raw`[\x20\t\n\x0B\f\r]`,
  S: String.raw`[^\x20\t\n\x0B\f\r]`,
  h: String.raw`[\x20\t\xA0 ᠎ -   　]`,
  H: String.raw`[^\x20\t\xA0 ᠎ -   　]`,
  v: String.raw`[\n\x0B\f\r\x85  ]`,
  V: String.raw`[^\n\x0B\f\r\x85  ]`,
  d: String.raw`\d`,
  D: String.raw`\D`,
  w: String.raw`\w`,
  W: String.raw`\W`,
};

/** Java's character escapes, as the characters they stand for. */
const ESCAPED_CHARACTERS: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, a: 7, e: 27 };

/** Java's line terminators, which end a line for `.`, `^`, and `$`; UNIX_LINES (`d`) keeps `\n` only. */
const LINE_TERMINATORS = String.raw`\n\r\x85\u2028\u2029`;
/** What `\R` matches: a line terminator, a vertical tab, or a form feed. */
const LINEBREAK = String.raw`(?:\r\n|[\n\x0B\f\r\x85\u2028\u2029])`;

/**
 * Rewrites a Java regular expression for `RegExp` with the `v` flag, reading it token by token as
 * `java.util.regex.Pattern` does: classes with nesting and `&&` intersection, POSIX, `java*` and Unicode property
 * classes, Java's escapes, embedded flags anywhere, comments mode, and `\Q...\E` quoting. A construct JavaScript
 * cannot express, such as an atomic group or a possessive quantifier, throws {@link UnsupportedRegexError}.
 *
 * @param isWhole Whether the expression must match the whole input, as `String.matches` requires.
 */
export function translateJavaRegex(pattern: string, isWhole: boolean): TranslatedRegex {
  const translator = new Translator(pattern);
  const { source, flags } = translator.translate();
  return { source: isWhole ? String.raw`(?<![\s\S])(?:${source})(?![\s\S])` : source, flags: `${flags}v` };
}

/** The group state each embedded flag sets, as `(?s)` sets DOTALL. */
const GROUP_FLAGS: Record<
  string,
  'isComments' | 'isMultiline' | 'isDotAll' | 'isUnixLines' | 'isCaseInsensitive' | 'isUnicodeCase'
> = {
  x: 'isComments',
  m: 'isMultiline',
  s: 'isDotAll',
  d: 'isUnixLines',
  i: 'isCaseInsensitive',
  u: 'isUnicodeCase',
};

/** A group being translated, with the scoped flag groups that embedded flags inside it opened. */
interface Group {
  extraCloses: number;
  isComments: boolean;
  isMultiline: boolean;
  isDotAll: boolean;
  isUnixLines: boolean;
  isCaseInsensitive: boolean;
  isUnicodeCase: boolean;
}

/** Whether a group lets JavaScript's `i` flag fold case, which then folds all of Unicode as UNICODE_CASE does. */
function foldsUnicodeCase(group: Group): boolean {
  return group.isCaseInsensitive && group.isUnicodeCase;
}

class Translator {
  private index = 0;
  private readonly groups: Group[] = [
    {
      extraCloses: 0,
      isComments: false,
      isMultiline: false,
      isDotAll: false,
      isUnixLines: false,
      isCaseInsensitive: false,
      isUnicodeCase: false,
    },
  ];
  private readonly parts: string[] = [];
  /** Whether the last token is one a quantifier may follow, which the start of the pattern is not. */
  private canRepeat = false;
  /** The capturing groups opened so far, which back references may refer to. */
  private capturingGroups = 0;
  private readonly groupNames = new Set<string>();

  constructor(private readonly pattern: string) {}

  translate(): TranslatedRegex {
    const flags = this.leadingFlags();
    while (this.index < this.pattern.length) this.parts.push(this.atom());
    if (this.groups.length > 1) this.fail('Unclosed group');
    return { source: this.parts.join('') + ')'.repeat(this.current().extraCloses), flags };
  }

  /**
   * Reads the flag groups at the start, such as `(?i)(?s)`, which hold for the whole expression; JavaScript gets
   * only `i`, for Unicode case folding, as the translation spells out what the other flags change.
   */
  private leadingFlags(): string {
    for (let match = /^\(\?([a-zA-Z]+)\)/.exec(this.rest()); match; match = /^\(\?([a-zA-Z]+)\)/.exec(this.rest())) {
      for (const flag of match[1] as string) this.setGroupFlag(this.current(), flag, true);
      this.index += match[0].length;
    }
    return foldsUnicodeCase(this.current()) ? 'i' : '';
  }

  private rest(): string {
    return this.pattern.slice(this.index);
  }

  private current(): Group {
    return this.groups.at(-1) as Group;
  }

  private fail(reason: string, index = this.index): never {
    throw new UnsupportedRegexError(reason, index);
  }

  /** Translates the next token outside a class. */
  private atom(): string {
    const point = this.pattern.codePointAt(this.index) as number;
    const char = String.fromCodePoint(point);
    this.index += char.length;
    if (this.skipsToken(char)) return '';
    switch (char) {
      case '\\': {
        return this.escape();
      }
      case '[': {
        return this.characterClass();
      }
      case '(': {
        return this.openGroup();
      }
      case ')': {
        return this.closeGroup();
      }
      case '*':
      case '+':
      case '?': {
        return char + this.quantifierSuffix();
      }
      case '{': {
        return this.braceQuantifier();
      }
      case '$':
      case '^': {
        return this.lineAnchor(char);
      }
      case '.': {
        return this.anyCharacter();
      }
      case '|': {
        return char;
      }
      default: {
        return this.literal(point);
      }
    }
  }

  /**
   * Whether the token starting with `char` is whitespace or a comment that comments mode skips; rejects a quantifier
   * with nothing to repeat, as Java's dangling meta character error does.
   */
  private skipsToken(char: string): boolean {
    if (this.current().isComments && this.skipsComment(char)) return true;
    const canRepeat = this.canRepeat;
    // Only a quantifier, `|`, and a group's opening leave nothing for a quantifier to repeat.
    this.canRepeat = !'*+?{|('.includes(char);
    if ('*+?'.includes(char) && !canRepeat) this.fail(`Dangling meta character '${char}'`, this.index - 1);
    return false;
  }

  /** Where `^` or `$` matches, at the input's bounds or, with MULTILINE, at its lines'. */
  private lineAnchor(char: '^' | '$'): string {
    // A group lets a quantifier follow, as Java allows and JavaScript does not for a bare assertion.
    if (!this.current().isMultiline) return `(?:${char === '^' ? String.raw`(?<![\s\S])` : this.inputEnd()})`;
    return `(?:${char === '^' ? this.lineStart() : this.lineEnd()})`;
  }

  /** What `.` matches: any character but a line terminator, unless DOTALL. */
  private anyCharacter(): string {
    const group = this.current();
    if (group.isDotAll) return String.raw`[\s\S]`;
    return group.isUnixLines ? String.raw`[^\n]` : `[^${LINE_TERMINATORS}]`;
  }

  /** Where `$` matches without MULTILINE, and `\Z`: at the end, or before a line terminator that ends the input. */
  private inputEnd(): string {
    if (this.current().isUnixLines) return String.raw`(?=\n?(?![\s\S]))`;
    // Not between the CR and LF of a final CRLF, which is one terminator.
    return String.raw`(?=(?:\r\n|[${LINE_TERMINATORS}])?(?![\s\S]))(?!(?<=\r)\n)`;
  }

  /** Where `$` matches with MULTILINE: before any line terminator, but not between `\r` and `\n`, or at the end. */
  private lineEnd(): string {
    if (this.current().isUnixLines) return String.raw`(?=\n|(?![\s\S]))`;
    return String.raw`(?:(?=[\r\x85\u2028\u2029]|(?![\s\S]))|(?<!\r)(?=\n))`;
  }

  /** Where `^` matches with MULTILINE: at the start, or after a line terminator that does not end the input. */
  private lineStart(): string {
    const after = this.current().isUnixLines ? String.raw`\n` : String.raw`[\n\x85\u2028\u2029]|\r(?!\n)`;
    // An empty input has no line to start, which MULTILINE's `^` matches only before a character.
    return String.raw`(?:(?<![\s\S])|(?<=${after}))(?=[\s\S])`;
  }

  /** A character outside a class, which ASCII-only case insensitivity matches in either case. */
  private literal(point: number): string {
    const other = this.otherCase(point);
    return other === undefined ? literal(point) : `[${literal(point)}${literal(other)}]`;
  }

  /** The other case of an ASCII letter while case is ignored for ASCII only, as Java's `i` without `u` does. */
  private otherCase(point: number): number | undefined {
    const group = this.current();
    if (!group.isCaseInsensitive || group.isUnicodeCase) return undefined;
    if (point >= 0x61 && point <= 0x7a) return point - 32;
    return point >= 0x41 && point <= 0x5a ? point + 32 : undefined;
  }

  /** In comments mode, whether `char` is whitespace or starts a comment, which the pattern skips. */
  private skipsComment(char: string): boolean {
    if (/\s/.test(char)) return true;
    if (char !== '#') return false;
    const end = this.pattern.indexOf('\n', this.index);
    this.index = end === -1 ? this.pattern.length : end + 1;
    return true;
  }

  /** The `?` of a lazy quantifier, or a failure for Java's possessive `+`, which JavaScript lacks. */
  private quantifierSuffix(): string {
    const next = this.pattern[this.index];
    if (next === '+') this.fail('Possessive quantifiers are not supported');
    if (next !== '?') return '';
    this.index++;
    return '?';
  }

  private braceQuantifier(): string {
    const match = /^(\d+)(,(\d*))?\}/.exec(this.rest());
    if (!match) this.fail('Illegal repetition');
    this.index += match[0].length;
    if (match[3] && Number(match[3]) < Number(match[1])) this.fail('Illegal repetition range', this.index - 1);
    return `{${match[0]}${this.quantifierSuffix()}`;
  }

  private openGroup(): string {
    const rest = this.rest();
    const group: Group = { ...this.current(), extraCloses: 0 };
    if (!rest.startsWith('?')) {
      this.capturingGroups++;
      this.groups.push(group);
      return '(';
    }
    if (/^\?<[^a-zA-Z=!]/.test(rest))
      this.fail('capturing group name does not start with a Latin letter', this.index + 2);
    const plain = /^\?(?::|=|!|<=|<!|<([a-zA-Z][a-zA-Z0-9]*)>)/.exec(rest);
    if (plain) {
      if (plain[1] !== undefined) {
        this.capturingGroups++;
        this.groupNames.add(plain[1]);
      }
      this.index += plain[0].length;
      this.groups.push(group);
      return `(${plain[0]}`;
    }
    if (rest.startsWith('?>')) this.fail('Atomic groups are not supported');
    const flagged = /^\?([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/.exec(rest);
    if (!flagged) this.fail('Unknown inline modifier');
    this.index += flagged[0].length;
    const modifiers = this.modifiers(flagged[1] ?? '', flagged[2] ?? '', group);
    if (flagged[3] === ':') {
      this.groups.push(group);
      return `(?${modifiers}:`;
    }
    // `(?i)` inside the expression sets the flags for the rest of the group around it.
    Object.assign(this.current(), { ...group, extraCloses: this.current().extraCloses + 1 });
    return `(?${modifiers}:`;
  }

  /** Applies the flags of an inline modifier to `group`, returning those JavaScript's modifiers take. */
  private modifiers(on: string, off: string, group: Group): string {
    const foldedBefore = foldsUnicodeCase(group);
    for (const flag of on) this.setGroupFlag(group, flag, true);
    for (const flag of off) this.setGroupFlag(group, flag, false);
    if (!foldedBefore && foldsUnicodeCase(group)) return 'i';
    return foldedBefore && !foldsUnicodeCase(group) ? '-i' : '';
  }

  private setGroupFlag(group: Group, flag: string, isOn: boolean): void {
    const field = GROUP_FLAGS[flag];
    if (!field) this.fail(`Unsupported flag ${flag}`);
    group[field] = isOn;
  }

  private closeGroup(): string {
    // Pattern reports an unmatched `)` one character before it, and with no index at the start.
    if (this.groups.length === 1) this.fail("Unmatched closing ')'", this.index - 2);
    const { extraCloses } = this.groups.pop() as Group;
    return `${')'.repeat(extraCloses)})`;
  }

  /**
   * Translates `\\1` and on, a reference to a group opened before it: Java takes further digits only while the number
   * stays within the groups opened so far, and a reference to a group that does not exist never matches.
   */
  private backReference(): string {
    let group = Number(this.pattern[this.index]);
    this.index++;
    for (let next = this.pattern[this.index]; next !== undefined && /\d/.test(next); next = this.pattern[this.index]) {
      const longer = group * 10 + Number(next);
      if (longer > this.capturingGroups) break;
      group = longer;
      this.index++;
    }
    return group > this.capturingGroups ? '(?!)' : `(?:\\${group})`;
  }

  /** Translates the escape after a backslash outside a class. */
  // code-gauge-allow functionNcss 31 -- One case per anchor or reference, which only exist outside classes.
  private escape(): string {
    const char = this.pattern[this.index];
    switch (char) {
      case 'b':
      case 'B': {
        this.index++;
        return `\\${char}`;
      }
      case 'A': {
        this.index++;
        return String.raw`(?<![\s\S])`;
      }
      case 'z': {
        this.index++;
        return String.raw`(?![\s\S])`;
      }
      case 'Z': {
        this.index++;
        return this.inputEnd();
      }
      case 'R': {
        this.index++;
        return LINEBREAK;
      }
      case 'k': {
        const name = /^k<([a-zA-Z][a-zA-Z0-9]*)>/.exec(this.rest());
        if (!name) this.fail('Illegal named-group reference');
        this.index += name[0].length;
        if (!this.groupNames.has(name[1] as string)) {
          this.fail(`named capturing group <${name[1]}> does not exist`, this.index - 1);
        }
        return `\\${name[0]}`;
      }
      default: {
        if (char !== undefined && /[1-9]/.test(char)) return this.backReference();
        return this.classEscape();
      }
    }
  }

  /**
   * Translates an escape that stands for a set or a character, valid inside a class too: a predefined or property
   * class, or a character, which a range may use as an end.
   */
  private classEscape(): string {
    const char = this.pattern[this.index];
    if (char === undefined) this.fail('Unescaped trailing backslash');
    this.index++;
    if (char === 'Q') return this.quoted();
    if (char === 'p' || char === 'P') return this.property(char === 'P');
    const predefined = ESCAPED_CLASSES[char];
    if (predefined !== undefined) return predefined;
    const point = this.escapedCharacter(char);
    if (point === undefined) this.fail(`Illegal or unsupported escape sequence \\${char}`);
    return this.literal(point);
  }

  /** The character a character escape stands for, or `undefined` when `char` starts none. */
  private escapedCharacter(char: string): number | undefined {
    const known = ESCAPED_CHARACTERS[char];
    if (known !== undefined) return known;
    switch (char) {
      case 'x': {
        return this.pattern[this.index] === '{'
          ? this.hexEscape(/^\{([0-9a-fA-F]+)\}/)
          : this.hexEscape(/^([0-9a-fA-F]{2})/);
      }
      case 'u': {
        return this.hexEscape(/^([0-9a-fA-F]{4})/);
      }
      case '0': {
        const octal = /^[0-3]?[0-7]{1,2}/.exec(this.rest())?.[0];
        if (!octal) this.fail('Illegal octal escape sequence');
        this.index += octal.length;
        return Number.parseInt(octal, 8);
      }
      case 'c': {
        const control = this.pattern.codePointAt(this.index);
        if (control === undefined) this.fail('Illegal control escape sequence');
        this.index++;
        return control ^ 64;
      }
      default: {
        // A backslash quotes any character that is not a letter or digit.
        return /[a-zA-Z0-9]/.test(char) ? undefined : (char.codePointAt(0) as number);
      }
    }
  }
  /** The code point of the hexadecimal digits `pattern` reads at the cursor, which Java limits to U+10FFFF. */
  private hexEscape(pattern: RegExp): number {
    const match = pattern.exec(this.rest());
    if (!match) this.fail('Illegal hexadecimal escape sequence');
    this.index += match[0].length;
    const point = Number.parseInt(match[1] as string, 16);
    if (point > 0x10_ff_ff) this.fail('Hexadecimal codepoint is too big');
    return point;
  }

  private quoted(): string {
    const end = this.pattern.indexOf(String.raw`\E`, this.index);
    const text = this.pattern.slice(this.index, end === -1 ? undefined : end);
    this.index = end === -1 ? this.pattern.length : end + 2;
    return [...text].map((char) => this.literal(char.codePointAt(0) as number)).join('');
  }

  /** Translates `\p{Name}`, `\pL`, or their negations, after the `p` or `P`. */
  private property(isNegated: boolean): string {
    let name: string;
    if (this.pattern[this.index] === '{') {
      const end = this.pattern.indexOf('}', this.index);
      if (end === -1) this.fail('Unclosed character family');
      name = this.pattern.slice(this.index + 1, end);
      this.index = end + 1;
    } else {
      name = this.pattern[this.index] ?? '';
      this.index++;
    }
    const set = POSIX_CLASSES[name.replace(/^Is/, '')] ?? JAVA_CLASSES[name] ?? `\\p{${this.unicodeProperty(name)}}`;
    return isNegated ? `[^${set}]` : set;
  }

  /** The name JavaScript gives a Unicode property that Java names, as `IsLatin` for the script `Latin`. */
  private unicodeProperty(name: string): string {
    const bare = name.replace(/^(?:Is|gc=|general_category=)/, '');
    if (GENERAL_CATEGORY.test(bare)) return bare;
    const binary = name.startsWith('Is') ? BINARY_PROPERTIES[bare.toLowerCase()] : undefined;
    if (binary !== undefined) return binary;
    const script = /^(?:Is|script=|sc=)(\w+)$/.exec(name)?.[1];
    if (script !== undefined) return `Script=${script}`;
    return this.fail(`Unknown character property name {${name}}`, this.index - 1);
  }

  /**
   * Translates a class after its `[`: a union of characters, ranges, escapes, and nested classes, whose operands
   * `&&` intersects, as in `[a-z&&[^aeiou]]`.
   */
  private characterClass(): string {
    const isNegated = this.pattern[this.index] === '^';
    if (isNegated) this.index++;
    const operands: string[][] = [[]];
    for (;;) {
      const char = this.pattern[this.index];
      if (char === undefined) this.fail('Unclosed character class', this.pattern.length - 1);
      if (char === ']') {
        this.index++;
        break;
      }
      if (this.rest().startsWith('&&')) {
        this.index += 2;
        operands.push([]);
        continue;
      }
      (operands.at(-1) as string[]).push(this.classItem());
    }
    const unions = operands.filter((items) => items.length > 0);
    if (unions.length === 0) this.fail('Empty character class');
    const body =
      unions.length === 1 ? (unions[0] as string[]).join('') : unions.map((items) => `[${items.join('')}]`).join('&&');
    return `[${isNegated ? '^' : ''}${body}]`;
  }

  /** Translates one item of a class: a nested class, an escape, a character, or a range between two characters. */
  private classItem(): string {
    if (this.pattern[this.index] === '[') {
      this.index++;
      return this.characterClass();
    }
    const start = this.classCharacter();
    if (typeof start === 'string') return start;
    const isRange = this.pattern[this.index] === '-' && !/^-(?:\]|&&)/.test(this.rest());
    if (!isRange) return this.classRange(start, start);
    this.index++;
    // A range that the pattern ends before its end character is illegal, as `[a-` is.
    if (this.index >= this.pattern.length) this.fail('Illegal character range');
    const end = this.classCharacter();
    if (typeof end === 'string' || end < start) this.fail('Illegal character range', this.index - 1);
    return this.classRange(start, end);
  }

  /** A range inside a class, with the other case of its ASCII letters while case is ignored for ASCII only. */
  private classRange(start: number, end: number): string {
    const ranges = [rangeText(start, end)];
    for (const [low, high] of [
      [0x61, 0x7a],
      [0x41, 0x5a],
    ] as const) {
      const [from, to] = [Math.max(start, low), Math.min(end, high)];
      const [otherFrom, otherTo] = [this.otherCase(from), this.otherCase(to)];
      if (from <= to && otherFrom !== undefined && otherTo !== undefined) ranges.push(rangeText(otherFrom, otherTo));
    }
    return ranges.join('');
  }

  /** The character at the cursor inside a class, or the translation of an escape that stands for a set. */
  private classCharacter(): number | string {
    const point = this.pattern.codePointAt(this.index) as number;
    if (point !== 0x5c) {
      this.index += String.fromCodePoint(point).length;
      return point;
    }
    this.index++;
    const char = this.pattern[this.index] as string;
    if (ESCAPED_CLASSES[char] !== undefined || char === 'p' || char === 'P' || char === 'Q') return this.classEscape();
    this.index++;
    const escaped = this.escapedCharacter(char);
    if (escaped === undefined) this.fail(`Illegal or unsupported escape sequence \\${char}`);
    return escaped;
  }
}

function rangeText(from: number, to: number): string {
  return from === to ? literal(from) : `${literal(from)}-${literal(to)}`;
}

/** A character as `v`-mode syntax matches it literally, in or out of a class. */
function literal(point: number): string {
  return /^[a-zA-Z0-9 ]$/u.test(String.fromCodePoint(point))
    ? String.fromCodePoint(point)
    : `\\u{${point.toString(16)}}`;
}
