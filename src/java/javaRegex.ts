/** A Java regular expression rewritten for JavaScript's `RegExp`. */
export interface TranslatedRegex {
  source: string;
  flags: string;
}

/** Thrown for a pattern that Java rejects or that has no JavaScript counterpart here. */
export class UnsupportedRegexError extends Error {}

/** The POSIX classes of `java.util.regex.Pattern`, which match ASCII characters only, as class contents. */
const POSIX_CLASSES: Record<string, string> = {
  Lower: 'a-z',
  Upper: 'A-Z',
  ASCII: String.raw`\x00-\x7F`,
  Alpha: 'a-zA-Z',
  Digit: '0-9',
  Alnum: 'a-zA-Z0-9',
  Punct: String.raw`!-\/:-@\[-\x60{-~`,
  Graph: '!-~',
  Print: ' -~',
  Blank: String.raw` \t`,
  Cntrl: String.raw`\x00-\x1F\x7F`,
  XDigit: '0-9a-fA-F',
  Space: String.raw` \t\n\x0B\f\r`,
};

/** The characters of Java's `\s` and `\h`, as class contents; JavaScript's `\s` takes Unicode spaces too. */
const WHITESPACE = String.raw` \t\n\x0B\f\r`;
const HORIZONTAL_WHITESPACE = String.raw` \t\xA0 ᠎ -   　`;
const LINEBREAK = String.raw`(?:\r\n|[\n\v\f\r\u0085  ])`;
/** The characters that stay escaped under JavaScript's `u` flag, which rejects escaping any other one. */
const SYNTAX_CHARACTERS = new Set(String.raw`^$\.*+?()[]{}|/-`);
const EMBEDDED_FLAGS: Record<string, string> = { i: 'i', m: 'm', s: 's', u: '', d: '' };

/**
 * Rewrites a Java regular expression for `RegExp`: POSIX and Unicode property classes, `\h`, `\s`, `\R`, `\A`,
 * `\z`, `\Z`, `\Q...\E` quoting, and embedded flags at its start, such as `(?i)`.
 *
 * @param isWhole Whether the expression must match the whole input, as `String.matches` requires.
 */
export function translateJavaRegex(pattern: string, isWhole: boolean): TranslatedRegex {
  let flags = '';
  let rest = pattern;
  const leading = /^\(\?([a-zA-Z]+)\)/.exec(rest);
  if (leading) {
    for (const flag of leading[1] as string) {
      const translated = EMBEDDED_FLAGS[flag];
      if (translated === undefined) throw new UnsupportedRegexError(pattern);
      if (!flags.includes(translated)) flags += translated;
    }
    rest = rest.slice(leading[0].length);
  }
  const translator = new Translator(rest);
  const source = translator.translate();
  if (translator.needsUnicode) flags += 'u';
  return { source: isWhole ? String.raw`(?<![\s\S])(?:${source})(?![\s\S])` : source, flags };
}

class Translator {
  needsUnicode = false;
  private index = 0;
  /** 1 inside a character class, whose contents some escapes translate differently. */
  private classDepth = 0;
  private readonly parts: string[] = [];

  constructor(private readonly pattern: string) {}

  translate(): string {
    while (this.index < this.pattern.length) {
      const char = this.pattern[this.index] as string;
      this.index++;
      if (char === '\\') this.parts.push(this.escape());
      else {
        if (char === '[') this.classDepth = 1;
        else if (char === ']') this.classDepth = 0;
        else if (char === '(' && this.pattern[this.index] === '?' && /^\?[a-zA-Z-]+[:)]/.test(this.rest())) {
          // JavaScript has no embedded flags elsewhere than the start, which `translateJavaRegex` reads.
          throw new UnsupportedRegexError(this.pattern);
        }
        this.parts.push(char);
      }
    }
    return this.parts.join('');
  }

  private rest(): string {
    return this.pattern.slice(this.index);
  }

  /** Translates the escape after a backslash. */
  // code-gauge-allow functionNcss 35 -- One case per escape that Java and JavaScript spell differently.
  private escape(): string {
    const char = this.pattern[this.index];
    if (char === undefined) throw new UnsupportedRegexError(this.pattern);
    this.index++;
    const inClass = this.classDepth > 0;
    switch (char) {
      case 'Q': {
        const end = this.pattern.indexOf(String.raw`\E`, this.index);
        const quoted = this.pattern.slice(this.index, end === -1 ? undefined : end);
        this.index = end === -1 ? this.pattern.length : end + 2;
        return quoted.replaceAll(/[\\^$.*+?()[\]{}|/-]/g, String.raw`\$&`);
      }
      case 'p':
      case 'P': {
        return this.property(char === 'P', inClass);
      }
      case 's': {
        return inClass ? WHITESPACE : `[${WHITESPACE}]`;
      }
      case 'S': {
        return this.negatedClass(WHITESPACE, inClass);
      }
      case 'h': {
        return inClass ? HORIZONTAL_WHITESPACE : `[${HORIZONTAL_WHITESPACE}]`;
      }
      case 'H': {
        return this.negatedClass(HORIZONTAL_WHITESPACE, inClass);
      }
      case 'R': {
        return LINEBREAK;
      }
      case 'A': {
        return String.raw`(?<![\s\S])`;
      }
      case 'z': {
        return String.raw`(?![\s\S])`;
      }
      case 'Z': {
        return String.raw`(?=(?:\r\n|[\n\r\u0085  ])?(?![\s\S]))`;
      }
      default: {
        // Java lets a backslash quote any character that is not a letter or digit.
        if (/[a-zA-Z0-9]/.test(char) || (SYNTAX_CHARACTERS.has(char) && (char !== '-' || inClass))) return `\\${char}`;
        return char;
      }
    }
  }

  private negatedClass(contents: string, inClass: boolean): string {
    if (inClass) throw new UnsupportedRegexError(this.pattern);
    return `[^${contents}]`;
  }

  /** Translates `\p{Name}`, `\pL`, or their negations, after the `p` or `P`. */
  private property(isNegated: boolean, inClass: boolean): string {
    let name: string;
    if (this.pattern[this.index] === '{') {
      const end = this.pattern.indexOf('}', this.index);
      if (end === -1) throw new UnsupportedRegexError(this.pattern);
      name = this.pattern.slice(this.index + 1, end);
      this.index = end + 1;
    } else {
      name = this.pattern[this.index] ?? '';
      this.index++;
    }
    const posix = POSIX_CLASSES[name] ?? POSIX_CLASSES[name.replace(/^Is/, '')];
    if (posix !== undefined) {
      if (!isNegated) return inClass ? posix : `[${posix}]`;
      return this.negatedClass(posix, inClass);
    }
    this.needsUnicode = true;
    return `\\${isNegated ? 'P' : 'p'}{${unicodePropertyOf(name, this.pattern)}}`;
  }
}

/** The name JavaScript gives a Unicode property that Java names, as `IsLatin` for the script `Latin`. */
function unicodePropertyOf(name: string, pattern: string): string {
  if (/^Is(?:Alphabetic|White_?Space|Letter|Digit|Uppercase|Lowercase|Ideographic)$/i.test(name)) {
    const binary: Record<string, string> = {
      alphabetic: 'Alphabetic',
      whitespace: 'White_Space',
      white_space: 'White_Space',
      letter: 'L',
      digit: 'Nd',
      uppercase: 'Uppercase',
      lowercase: 'Lowercase',
      ideographic: 'Ideographic',
    };
    return binary[name.slice(2).toLowerCase()] as string;
  }
  if (/^(?:Is)?(?:L[ultmo]?|M[nce]?|N[dlo]?|P[cdseifo]?|S[mcko]?|Z[slp]?|C[cfsno]?)$/.test(name)) {
    return name.replace(/^Is/, '');
  }
  if (name.startsWith('Is')) return `Script=${name.slice(2)}`;
  if (name.startsWith('script=') || name.startsWith('sc=')) return `Script=${name.split('=')[1]}`;
  throw new UnsupportedRegexError(pattern);
}

/** Converts Java's replacement syntax, where `$1` names a group and a backslash escapes, to JavaScript's. */
export function javaReplacement(replacement: string): string {
  return replacement.replaceAll(/\\(.)|\$(\d)|\$/g, (_, escaped: string | undefined, group: string | undefined) => {
    if (escaped !== undefined) return escaped === '$' ? '$$' : escaped;
    return group === undefined ? '$$' : `$${group}`;
  });
}
