// The tokenizer of CPython's `re._parser`, which pattern and replacement template parsing share.
import { strRepr } from '../../strings';

/** An error the parser raises: `re.PatternError` (with a position or not), OverflowError, ValueError, or IndexError. */
export class PatternSyntaxError extends Error {
  constructor(
    readonly kind: 'pattern' | 'overflow' | 'value' | 'index',
    readonly msg: string,
    readonly pos?: number
  ) {
    super(msg);
  }
}

export const DIGITS = new Set('0123456789');
export const OCTDIGITS = new Set('01234567');
export const HEXDIGITS = new Set('0123456789abcdefABCDEF');
export const ASCII_LETTER = /^[a-zA-Z]$/;

export const ESCAPES: Record<string, number> = {
  '\\a': 7,
  '\\b': 8,
  '\\f': 12,
  '\\n': 10,
  '\\r': 13,
  '\\t': 9,
  '\\v': 11,
  '\\\\': 92,
};

export function codePointLength(text: string): number {
  let length = 0;
  // oxlint-disable-next-line typescript/no-unused-vars -- Only the number of code points matters.
  for (const _ of text) length++;
  return length;
}

export const isEscape = (token: string): boolean => token.length > 1 && token.startsWith('\\');

export class Tokenizer {
  next: string | undefined;
  private index = 0;
  private readonly chars: string[];

  /** `isText` is false for a bytes pattern, whose `string` then holds one character per byte. */
  constructor(
    readonly string: string,
    readonly isText = true
  ) {
    // oxlint-disable-next-line typescript/no-misused-spread -- Patterns are indexed by code point, as in Python.
    this.chars = [...string];
    this.advance();
  }

  private advance(): void {
    const index = this.index;
    if (index >= this.chars.length) {
      this.next = undefined;
      return;
    }
    let char = this.chars[index];
    if (char === '\\') {
      if (index + 1 >= this.chars.length)
        throw new PatternSyntaxError('pattern', 'bad escape (end of pattern)', this.chars.length - 1);
      char += this.chars[index + 1];
      this.index = index + 2;
    } else this.index = index + 1;
    this.next = char;
  }

  match(char: string): boolean {
    if (char === this.next) {
      this.advance();
      return true;
    }
    return false;
  }

  get(): string | undefined {
    const current = this.next;
    this.advance();
    return current;
  }

  getwhile(count: number, charset: Set<string>): string {
    let result = '';
    for (let index = 0; index < count; index++) {
      const char = this.next;
      if (char === undefined || !charset.has(char)) break;
      result += char;
      this.advance();
    }
    return result;
  }

  getuntil(terminator: string, name: string): string {
    let result = '';
    for (;;) {
      const char = this.next;
      this.advance();
      if (char === undefined) {
        if (!result) throw this.error(`missing ${name}`);
        throw this.error(`missing ${terminator}, unterminated name`, codePointLength(result));
      }
      if (char === terminator) {
        if (!result) throw this.error(`missing ${name}`, 1);
        break;
      }
      result += char;
    }
    return result;
  }

  tell(): number {
    return this.index - (this.next === undefined ? 0 : codePointLength(this.next));
  }

  seek(index: number): void {
    this.index = index;
    this.advance();
  }

  error(message: string, offset = 0): PatternSyntaxError {
    return new PatternSyntaxError('pattern', message, this.tell() - offset);
  }

  checkgroupname(name: string, offset: number): void {
    // oxlint-disable-next-line eslint/no-control-regex -- A bytes pattern's group names must be ASCII.
    if (!this.isText && !/^[\u0000-\u007F]*$/.test(name)) {
      throw this.error(`bad character in group name ${strRepr(name, true)}`, codePointLength(name) + offset);
    }
    if (!/^[\p{XID_Start}_]\p{XID_Continue}*$/u.test(name))
      throw this.error(`bad character in group name ${strRepr(name)}`, codePointLength(name) + offset);
  }
}
