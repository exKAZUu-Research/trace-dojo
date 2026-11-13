import { CompileError } from '../interpreter/diagnostics';
import { unsupported } from './unsupported';

/** A preprocessing token, located by the 0-based row of the source where it starts. */
export interface PPToken {
  kind: 'identifier' | 'number' | 'char' | 'string' | 'punctuator' | 'other';
  text: string;
  row: number;
  /** Whether white space (or a comment) comes before the token on its line. */
  space: boolean;
  /** The macros whose expansion produced this token, which it must not expand again. */
  hide?: ReadonlySet<string>;
}

/** A logical line: the tokens between two newlines that no backslash or comment hides. */
export interface LogicalLine {
  tokens: PPToken[];
  /** The row where the line starts. */
  row: number;
}

/** A comment, located in the original source. */
export interface SourceComment {
  index: number;
  text: string;
  isLine: boolean;
}

const PUNCTUATORS = [
  '%:%:',
  '...',
  '<<=',
  '>>=',
  '->',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '*=',
  '/=',
  '%=',
  '+=',
  '-=',
  '&=',
  '^=',
  '|=',
  '##',
  '<:',
  ':>',
  '<%',
  '%>',
  '%:',
  '[',
  ']',
  '(',
  ')',
  '{',
  '}',
  '.',
  '&',
  '*',
  '+',
  '-',
  '~',
  '!',
  '/',
  '%',
  '<',
  '>',
  '^',
  '|',
  '?',
  ':',
  ';',
  '=',
  ',',
  '#',
];

/** Digraphs spell other punctuators, which the rest of the interpreter sees instead. */
const DIGRAPHS: Record<string, string> = { '<:': '[', ':>': ']', '<%': '{', '%>': '}', '%:': '#', '%:%:': '##' };

export function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char) || (char.codePointAt(0) ?? 0) >= 0x80;
}

function isIdentifierPart(char: string): boolean {
  return /[\w$]/.test(char) || (char.codePointAt(0) ?? 0) >= 0x80;
}

/**
 * Splits a source into logical lines of preprocessing tokens, removing comments and backslash-newlines as C's
 * translation phases 1–3 do, while keeping the row where each token starts.
 */
export function tokenize(source: string): { lines: LogicalLine[]; comments: SourceComment[]; rowCount: number } {
  return new Lexer(source).tokenize();
}

type TokenBody = Pick<PPToken, 'kind' | 'text'>;

class Lexer {
  private readonly source: string;
  private readonly lines: LogicalLine[] = [];
  private readonly comments: SourceComment[] = [];
  private row = 0;
  private index = 0;
  private current: LogicalLine = { tokens: [], row: 0 };
  private space = false;

  constructor(source: string) {
    const trigraph = /\?\?[=()<>/'!-]/.exec(source);
    if (trigraph) unsupported(source.slice(0, trigraph.index).split('\n').length - 1, 'トライグラフ');
    this.source = source;
  }

  tokenize(): { lines: LogicalLine[]; comments: SourceComment[]; rowCount: number } {
    const { source } = this;
    const length = source.length;
    while (this.index < length) {
      this.skipSplices();
      if (this.index >= length) break;
      const char = source[this.index];
      if (char === '\n') {
        this.index++;
        this.lines.push(this.current);
        this.row++;
        this.current = { tokens: [], row: this.row };
        this.space = false;
      } else if (char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\v') {
        this.index++;
        this.space = true;
      } else if (char === '/' && this.peek(1) === '/') {
        this.lineComment();
      } else if (char === '/' && this.peek(1) === '*') {
        this.blockComment();
      } else {
        const tokenRow = this.row;
        const { kind, text } = this.token(char);
        this.current.tokens.push({ kind, text, row: tokenRow, space: this.space });
        this.space = false;
      }
    }
    this.lines.push(this.current);
    return { lines: this.lines, comments: this.comments, rowCount: this.row + 1 };
  }

  /** Skips backslash-newlines at `index`, which join lines without ending a token. */
  private skipSplices(): void {
    const { source } = this;
    while (
      source[this.index] === '\\' &&
      (source[this.index + 1] === '\n' || source.startsWith('\r\n', this.index + 1))
    ) {
      this.index += source[this.index + 1] === '\n' ? 2 : 3;
      this.row++;
    }
  }

  private readonly peek = (offset = 0): string => {
    const { source } = this;
    // Splices may sit between any two characters, so look ahead through them.
    let position = this.index;
    let remaining = offset;
    for (;;) {
      while (source[position] === '\\' && (source[position + 1] === '\n' || source.startsWith('\r\n', position + 1))) {
        position += source[position + 1] === '\n' ? 2 : 3;
      }
      if (remaining === 0) return source[position] ?? '';
      position++;
      remaining--;
    }
  };

  private readonly take = (): string => {
    this.skipSplices();
    const char = this.source[this.index++] ?? '';
    if (char === '\n') this.row++;
    return char;
  };

  private lineComment(): void {
    const { source } = this;
    const start = this.index;
    while (this.index < source.length && source[this.index] !== '\n') {
      if (
        source[this.index] === '\\' &&
        (source[this.index + 1] === '\n' || source.startsWith('\r\n', this.index + 1))
      ) {
        this.index += source[this.index + 1] === '\n' ? 2 : 3;
        this.row++;
      } else {
        this.index++;
      }
    }
    this.comments.push({ index: start, text: source.slice(start, this.index), isLine: true });
    this.space = true;
  }

  private blockComment(): void {
    const { source } = this;
    const start = this.index;
    const row = this.row;
    this.take();
    this.take();
    while (this.index < source.length && !(source[this.index] === '*' && this.peek(1) === '/')) this.take();
    if (this.index >= source.length) throw new CompileError([{ row, message: 'コメントを閉じる */ が足りません。' }]);
    this.take();
    this.take();
    this.comments.push({ index: start, text: source.slice(start, this.index), isLine: false });
    this.space = true;
  }

  private token(char: string): TokenBody {
    const prefix = /^(?:u8|u|U|L)/.exec(this.source.slice(this.index, this.index + 3))?.[0];
    const afterPrefix = prefix && this.source[this.index + prefix.length];
    if (prefix && (afterPrefix === '"' || afterPrefix === "'")) {
      let text = '';
      for (let i = 0; i < prefix.length; i++) text += this.take();
      const quoted = readQuoted(this.take(), this.take, this.peek);
      text += quoted.text;
      return { kind: quoted.closed ? (quoted.text.startsWith('"') ? 'string' : 'char') : 'other', text };
    }
    if (char === '"' || char === "'") {
      const quoted = readQuoted(this.take(), this.take, this.peek);
      return { kind: quoted.closed ? (char === '"' ? 'string' : 'char') : 'other', text: quoted.text };
    }
    if (/\d/.test(char) || (char === '.' && /\d/.test(this.peek(1)))) return { kind: 'number', text: this.number() };
    if (isIdentifierStart(char)) {
      let text = this.take();
      while (this.peek() !== '' && isIdentifierPart(this.peek())) text += this.take();
      return { kind: 'identifier', text };
    }
    return this.punctuator();
  }

  private number(): string {
    let text = this.take();
    for (;;) {
      const next = this.peek();
      if ((next === '+' || next === '-') && /[eEpP]$/.test(text)) text += this.take();
      else if (next !== '' && (isIdentifierPart(next) || next === '.')) text += this.take();
      else return text;
    }
  }

  private punctuator(): TokenBody {
    const punctuator = PUNCTUATORS.find((candidate) => {
      for (let offset = 0; offset < candidate.length; offset++)
        if (this.peek(offset) !== candidate[offset]) return false;
      return true;
    });
    if (!punctuator) return { kind: 'other', text: this.take() };
    for (let i = 0; i < punctuator.length; i++) this.take();
    return { kind: 'punctuator', text: DIGRAPHS[punctuator] ?? punctuator };
  }
}

function readQuoted(
  quote: string,
  take: () => string,
  peek: (offset?: number) => string
): { text: string; closed: boolean } {
  let text = quote;
  for (;;) {
    const next = peek();
    if (next === '' || next === '\n') return { text, closed: false };
    text += take();
    if (next === '\\') {
      if (peek() !== '' && peek() !== '\n') text += take();
      continue;
    }
    if (next === quote) return { text, closed: true };
  }
}

/** Spells tokens as C source, with a space where the source had one. */
export function spell(tokens: readonly PPToken[]): string {
  return tokens.map((token, index) => (index > 0 && token.space ? ' ' : '') + token.text).join('');
}
