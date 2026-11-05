/** A Java regular expression rewritten for JavaScript's `RegExp`. */
export interface TranslatedRegex {
  source: string;
  flags: string;
}

/** Thrown for a pattern that Java rejects or that JavaScript cannot express, with what makes it so. */
export class UnsupportedRegexError extends Error {}

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

const LINE_TERMINATOR = String.raw`(?:\r\n|[\n\r\x85  ])`;

/** The flags that `(?flags)` and `(?flags:...)` set, which JavaScript's modifiers take, besides `x` read here. */
const MODIFIER_FLAGS = new Set(['i', 'm', 's']);
/** Flags that change nothing JavaScript would read differently here: UNICODE_CASE and UNIX_LINES. */
const IGNORED_FLAGS = new Set(['u', 'd']);

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

/** A group being translated, with the scoped flag groups that embedded flags inside it opened. */
interface Group {
  extraCloses: number;
  isComments: boolean;
  isMultiline: boolean;
}

class Translator {
  private index = 0;
  private readonly groups: Group[] = [{ extraCloses: 0, isComments: false, isMultiline: false }];
  private readonly parts: string[] = [];

  constructor(private readonly pattern: string) {}

  translate(): TranslatedRegex {
    const flags = this.leadingFlags();
    while (this.index < this.pattern.length) this.parts.push(this.atom());
    if (this.groups.length > 1) this.fail('Unclosed group');
    return { source: this.parts.join('') + ')'.repeat(this.current().extraCloses), flags };
  }

  /** Reads the flag groups at the start, such as `(?i)(?s)`, which become the expression's own flags. */
  private leadingFlags(): string {
    let flags = '';
    for (let match = /^\(\?([a-zA-Z]+)\)/.exec(this.rest()); match; match = /^\(\?([a-zA-Z]+)\)/.exec(this.rest())) {
      for (const flag of match[1] as string) {
        if (MODIFIER_FLAGS.has(flag)) flags += flags.includes(flag) ? '' : flag;
        else this.setGroupFlag(this.current(), flag, true);
      }
      this.index += match[0].length;
    }
    this.current().isMultiline = flags.includes('m');
    return flags;
  }

  private rest(): string {
    return this.pattern.slice(this.index);
  }

  private current(): Group {
    return this.groups.at(-1) as Group;
  }

  private fail(reason: string): never {
    throw new UnsupportedRegexError(`${reason} near index ${this.index}`);
  }

  /** Translates the next token outside a class. */
  private atom(): string {
    const point = this.pattern.codePointAt(this.index) as number;
    const char = String.fromCodePoint(point);
    this.index += char.length;
    if (this.current().isComments && this.skipsComment(char)) return '';
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
      case '$': {
        // Without MULTILINE, Java's `$` also matches before a line terminator that ends the input.
        return this.current().isMultiline ? '$' : String.raw`(?=${LINE_TERMINATOR}?(?![\s\S]))`;
      }
      case '.':
      case '^':
      case '|': {
        return char;
      }
      default: {
        return literal(point);
      }
    }
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
    return `{${match[0]}${this.quantifierSuffix()}`;
  }

  private openGroup(): string {
    const rest = this.rest();
    const group: Group = { ...this.current(), extraCloses: 0 };
    if (!rest.startsWith('?')) {
      this.groups.push(group);
      return '(';
    }
    const plain = /^\?(?::|=|!|<=|<!|<[a-zA-Z][a-zA-Z0-9]*>)/.exec(rest);
    if (plain) {
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
    const forJs = (flags: string, isOn: boolean): string =>
      [...flags]
        .filter((flag) => {
          if (MODIFIER_FLAGS.has(flag)) return true;
          this.setGroupFlag(group, flag, isOn);
          return false;
        })
        .join('');
    const [jsOn, jsOff] = [forJs(on, true), forJs(off, false)];
    if (on.includes('m')) group.isMultiline = true;
    if (off.includes('m')) group.isMultiline = false;
    return jsOff ? `${jsOn}-${jsOff}` : jsOn;
  }

  private setGroupFlag(group: Group, flag: string, isOn: boolean): void {
    if (flag === 'x') group.isComments = isOn;
    else if (!IGNORED_FLAGS.has(flag)) this.fail(`Unsupported flag ${flag}`);
  }

  private closeGroup(): string {
    if (this.groups.length === 1) this.fail('Unmatched closing )');
    const { extraCloses } = this.groups.pop() as Group;
    return `${')'.repeat(extraCloses)})`;
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
        return String.raw`(?=${LINE_TERMINATOR}?(?![\s\S]))`;
      }
      case 'R': {
        this.index++;
        return LINE_TERMINATOR;
      }
      case 'k': {
        const name = /^k<([a-zA-Z][a-zA-Z0-9]*)>/.exec(this.rest());
        if (!name) this.fail('Illegal named-group reference');
        this.index += name[0].length;
        return `\\${name[0]}`;
      }
      default: {
        if (char !== undefined && /[1-9]/.test(char)) {
          const digits = /^\d+/.exec(this.rest())?.[0] as string;
          this.index += digits.length;
          return `\\${digits}`;
        }
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
    if (char === undefined) this.fail('Unexpected end of pattern');
    this.index++;
    if (char === 'Q') return this.quoted();
    if (char === 'p' || char === 'P') return this.property(char === 'P');
    const predefined = ESCAPED_CLASSES[char];
    if (predefined !== undefined) return predefined;
    const point = this.escapedCharacter(char);
    if (point === undefined) this.fail(`Illegal or unsupported escape sequence \\${char}`);
    return literal(point);
  }

  /** The character a character escape stands for, or `undefined` when `char` starts none. */
  private escapedCharacter(char: string): number | undefined {
    const known = ESCAPED_CHARACTERS[char];
    if (known !== undefined) return known;
    const hex = (pattern: RegExp): number => {
      const match = pattern.exec(this.rest());
      if (!match) this.fail('Illegal hexadecimal escape sequence');
      this.index += match[0].length;
      return Number.parseInt(match[1] as string, 16);
    };
    switch (char) {
      case 'x': {
        return this.pattern[this.index] === '{' ? hex(/^\{([0-9a-fA-F]+)\}/) : hex(/^([0-9a-fA-F]{2})/);
      }
      case 'u': {
        return hex(/^([0-9a-fA-F]{4})/);
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

  private quoted(): string {
    const end = this.pattern.indexOf(String.raw`\E`, this.index);
    const text = this.pattern.slice(this.index, end === -1 ? undefined : end);
    this.index = end === -1 ? this.pattern.length : end + 2;
    return [...text].map((char) => literal(char.codePointAt(0) as number)).join('');
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
    return this.fail(`Unsupported character family ${name}`);
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
      if (char === undefined) this.fail('Unclosed character class');
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
    if (!isRange) return literal(start);
    this.index++;
    const end = this.classCharacter();
    if (typeof end === 'string' || end < start) this.fail('Illegal character range');
    return `${literal(start)}-${literal(end)}`;
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

/** A character as `v`-mode syntax matches it literally, in or out of a class. */
function literal(point: number): string {
  return /^[a-zA-Z0-9 ]$/u.test(String.fromCodePoint(point))
    ? String.fromCodePoint(point)
    : `\\u{${point.toString(16)}}`;
}

/** Converts Java's replacement syntax, where `$1` names a group and a backslash escapes, to JavaScript's. */
export function javaReplacement(replacement: string): string {
  return replacement.replaceAll(/\\(.)|\$(\d)|\$/g, (_, escaped: string | undefined, group: string | undefined) => {
    if (escaped !== undefined) return escaped === '$' ? '$$' : escaped;
    return group === undefined ? '$$' : `$${group}`;
  });
}
