// The tokens of CPython 3.14's C tokenizer, as `_tokenize.TokenizerIter(..., extra_tokens=True)` gives them to the
// tokenize module: operators as OP, with COMMENT and NL tokens, and f-strings split into their parts.

/** A token: its type number, text, start and end as (line, column in code points), and the lines it spans. */
export interface Token {
  type: number;
  text: string;
  start: [number, number];
  end: [number, number];
  line: string;
}

/** An error of the tokenizer: a SyntaxError (or IndentationError) with CPython's message and position. */
export class TokenizeError extends Error {
  constructor(
    message: string,
    readonly lineno: number,
    readonly offset: number,
    readonly kind: 'SyntaxError' | 'IndentationError' | 'TabError' = 'SyntaxError',
    readonly text = ''
  ) {
    super(message);
  }
}

export const TOKEN_TYPES = {
  ENDMARKER: 0,
  NAME: 1,
  NUMBER: 2,
  STRING: 3,
  NEWLINE: 4,
  INDENT: 5,
  DEDENT: 6,
  OP: 55,
  FSTRING_START: 59,
  FSTRING_MIDDLE: 60,
  FSTRING_END: 61,
  TSTRING_START: 62,
  TSTRING_MIDDLE: 63,
  TSTRING_END: 64,
  COMMENT: 65,
  NL: 66,
} as const;

const OPERATORS = [
  '!=',
  '%',
  '%=',
  '&',
  '&=',
  '(',
  ')',
  '*',
  '**',
  '**=',
  '*=',
  '+',
  '+=',
  ',',
  '-',
  '-=',
  '->',
  '.',
  '...',
  '/',
  '//',
  '//=',
  '/=',
  ':',
  ':=',
  ';',
  '<',
  '<<',
  '<<=',
  '<=',
  '=',
  '==',
  '>',
  '>=',
  '>>',
  '>>=',
  '@',
  '@=',
  '[',
  ']',
  '^',
  '^=',
  '{',
  '|',
  '|=',
  '}',
  '~',
  '!',
];
const OPERATOR_SET = new Set(OPERATORS);
const STRING_PREFIXES = new Set(['', 'r', 'u', 'b', 'br', 'rb', 'f', 'fr', 'rf', 't', 'tr', 'rt']);
const NUMBER =
  /^(?:0[xX](?:_?[\da-fA-F])+|0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?)/;
const NAME_START = /[\p{L}\p{Nl}_ᢅᢆ℘℮゛゜]/u;

/** The state of an f-string or t-string being read: its quote, and where its replacement fields stand. */
interface Interpolated {
  quote: string;
  raw: boolean;
  kind: 'f' | 't';
  /** The bracket depth at which each open replacement field started. */
  fields: { depth: number; inSpec: boolean }[];
  startRow: number;
}

const codePoints = (text: string): number => text.replaceAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length;

/** The literal text being read of an f-string or a format spec, from where it starts. */
interface LiteralPart {
  string: Interpolated;
  field: Interpolated['fields'][number] | undefined;
  middle: number;
  firstRow: number;
  startIndex: number;
  start: [number, number];
}

/** The indentation of a line: its column with tabs to multiples of 8, and with tabs as one column. */
// code-gauge-allow duplicateLines 15 -- Measures as the indentation check of the parser does, over a line, not a scanner.
function measureIndentation(line: string): { column: number; altColumn: number; index: number } {
  let column = 0;
  let altColumn = 0;
  let index = 0;
  for (; index < line.length; index++) {
    const char = line[index];
    if (char === ' ') {
      column++;
      altColumn++;
    } else if (char === '\t') {
      column = (Math.floor(column / 8) + 1) * 8;
      altColumn++;
    } else if (char === '\f') {
      column = 0;
      altColumn = 0;
    } else {
      break;
    }
  }
  return { column, altColumn, index };
}

export class Tokenizer {
  private row = 0;
  private index = 0;
  private readonly indents = [0];
  /** The indentations counting a tab as one column, which must order the lines as `indents` does. */
  private readonly altIndents = [0];
  private depth = 0;
  private readonly strings: Interpolated[] = [];
  private atLineStart = true;
  private lineHasTokens = false;
  private readonly lines: string[] = [];
  private exhausted = false;

  constructor(private readonly readline: () => string | undefined) {}

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows tok_get's order of decisions at each position.
  *tokens(): Generator<Token, void, void> {
    for (;;) {
      if (!this.ensureLine()) {
        yield* this.finish();
        return;
      }
      const string = this.strings.at(-1);
      if (string && this.inLiteral(string)) {
        yield* this.literalPart(string);
        continue;
      }
      if (this.atLineStart && this.depth === 0) {
        const blank = yield* this.lineStart();
        if (blank) continue;
      }
      this.skipSpaces();
      const line = this.lines[this.row];
      const char = line[this.index];
      if (char === undefined || char === '\n' || (char === '\r' && line[this.index + 1] === '\n')) {
        yield this.endOfLine();
        continue;
      }
      if (char === '#') {
        yield this.comment();
        continue;
      }
      if (char === '\\' && /^\\\r?\n?$/.test(line.slice(this.index))) {
        this.nextLine(false);
        continue;
      }
      this.lineHasTokens = true;
      yield* this.token(line, char);
    }
  }

  /** Reads lines until the current position has one, returning false at the end of the input. */
  private ensureLine(): boolean {
    while (this.row >= this.lines.length) {
      if (this.exhausted) return false;
      const line = this.readline();
      if (line === undefined || line === '') {
        this.exhausted = true;
        return false;
      }
      this.lines.push(line);
    }
    return true;
  }

  private nextLine(atLineStart: boolean): void {
    this.row++;
    this.index = 0;
    this.atLineStart = atLineStart;
  }

  private position(row = this.row, index = this.index): [number, number] {
    return [row + 1, codePoints(this.lines[row]?.slice(0, index) ?? '')];
  }

  private make(type: number, text: string, start: [number, number], end: [number, number], firstRow: number): Token {
    return { type, text, start, end, line: this.lines.slice(firstRow, this.row + 1).join('') };
  }

  /** Handles the indentation of a new logical line, returning whether the line is blank or only a comment. */
  // code-gauge-allow functionCognitiveComplexity 18 -- Follows tok_get's checks of indentation in their order.
  // code-gauge-allow functionNcss 35 -- Follows tok_get's checks of indentation in their order.
  private *lineStart(): Generator<Token, boolean, void> {
    const line = this.lines[this.row];
    const { column, altColumn, index } = measureIndentation(line);
    this.index = index;
    const rest = line.slice(index);
    if (rest === '' || rest.startsWith('#') || /^\r?\n$/.test(rest)) {
      if (rest.startsWith('#')) yield this.comment();
      yield this.endOfLine(true);
      return true;
    }
    this.atLineStart = false;
    const error = (message: string, kind: TokenizeError['kind']): TokenizeError =>
      new TokenizeError(message, this.row + 1, codePoints(line.slice(0, index)), kind, line);
    const tabError = (): TokenizeError => error('inconsistent use of tabs and spaces in indentation', 'TabError');
    if (column === this.indents.at(-1)) {
      if (altColumn !== this.altIndents.at(-1)) throw tabError();
    } else if (column > (this.indents.at(-1) as number)) {
      if (altColumn <= (this.altIndents.at(-1) as number)) throw tabError();
      this.indents.push(column);
      this.altIndents.push(altColumn);
      yield this.make(TOKEN_TYPES.INDENT, line.slice(0, index), [this.row + 1, 0], this.position(), this.row);
    } else {
      const dedents: Token[] = [];
      while (this.indents.length > 1 && column < (this.indents.at(-1) as number)) {
        this.indents.pop();
        this.altIndents.pop();
        dedents.push(this.make(TOKEN_TYPES.DEDENT, '', this.position(), this.position(), this.row));
      }
      if (column !== this.indents.at(-1)) {
        throw error('unindent does not match any outer indentation level', 'IndentationError');
      }
      if (altColumn !== this.altIndents.at(-1)) throw tabError();
      yield* dedents;
    }
    return false;
  }

  private skipSpaces(): void {
    const line = this.lines[this.row];
    while (line[this.index] === ' ' || line[this.index] === '\t' || line[this.index] === '\f') this.index++;
  }

  private comment(): Token {
    const line = this.lines[this.row];
    const end = line.search(/\r?\n$/);
    const stop = end === -1 ? line.length : end;
    const token = this.make(
      TOKEN_TYPES.COMMENT,
      line.slice(this.index, stop),
      this.position(),
      this.position(this.row, stop),
      this.row
    );
    this.index = stop;
    return token;
  }

  /** NEWLINE after a logical line's tokens, else NL; at the end of input without a newline, an empty one. */
  private endOfLine(blank = false): Token {
    const line = this.lines[this.row];
    const text = line.slice(this.index);
    const start = this.position();
    const end: [number, number] = [start[0], start[1] + 1];
    const type = blank || this.depth > 0 || !this.lineHasTokens ? TOKEN_TYPES.NL : TOKEN_TYPES.NEWLINE;
    const token = this.make(type, text.replace(/^\r/, ''), start, end, this.row);
    if (type === TOKEN_TYPES.NEWLINE) this.lineHasTokens = false;
    this.nextLine(this.depth === 0);
    return token;
  }

  private *finish(): Generator<Token, void, void> {
    if (this.depth > 0 || this.strings.length > 0) {
      throw new TokenizeError('unexpected EOF in multi-line statement', Math.max(this.row, 1), 0);
    }
    const end: [number, number] = [this.row + 1, 0];
    while (this.indents.length > 1) {
      this.indents.pop();
      yield { type: TOKEN_TYPES.DEDENT, text: '', start: end, end, line: '' };
    }
    yield { type: TOKEN_TYPES.ENDMARKER, text: '', start: end, end, line: '' };
  }

  private *token(line: string, char: string): Generator<Token, void, void> {
    const rest = line.slice(this.index);
    if (NAME_START.test(char) || (char.codePointAt(0) as number) > 0x7f) {
      const name = rest.match(/^[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_]+/u)?.[0] ?? char;
      const quote = rest[name.length];
      if ((quote === '"' || quote === "'") && STRING_PREFIXES.has(name.toLowerCase())) {
        yield* this.stringToken(name);
        return;
      }
      yield this.simple(TOKEN_TYPES.NAME, name);
      return;
    }
    if (/\d/.test(char) || (char === '.' && /^\.\d/.test(rest))) {
      yield this.simple(TOKEN_TYPES.NUMBER, (NUMBER.exec(rest) as RegExpExecArray)[0]);
      return;
    }
    if (char === '"' || char === "'") {
      yield* this.stringToken('');
      return;
    }
    yield* this.operator(rest);
  }

  private simple(type: number, text: string): Token {
    const start = this.position();
    this.index += text.length;
    return this.make(type, text, start, this.position(), this.row);
  }

  private *operator(rest: string): Generator<Token, void, void> {
    const text =
      [rest.slice(0, 3), rest.slice(0, 2), rest.slice(0, 1)].find((each) => OPERATOR_SET.has(each)) ??
      String.fromCodePoint(rest.codePointAt(0) as number);
    const string = this.strings.at(-1);
    const field = string?.fields.at(-1);
    if (string && field && field.depth === this.depth) {
      if (text === '}') {
        yield this.simple(TOKEN_TYPES.OP, '}');
        string.fields.pop();
        this.depth--;
        return;
      }
      if (text === ':' && !field.inSpec) {
        yield this.simple(TOKEN_TYPES.OP, ':');
        field.inSpec = true;
        return;
      }
    }
    if (text === '(' || text === '[' || text === '{') this.depth++;
    else if (text === ')' || text === ']' || text === '}') this.depth = Math.max(this.depth - 1, 0);
    yield this.simple(TOKEN_TYPES.OP, text);
  }

  private *stringToken(prefix: string): Generator<Token, void, void> {
    const line = this.lines[this.row];
    const quoteStart = this.index + prefix.length;
    const quote = line.startsWith(line[quoteStart].repeat(3), quoteStart)
      ? line[quoteStart].repeat(3)
      : line[quoteStart];
    const lower = prefix.toLowerCase();
    if (lower.includes('f') || lower.includes('t')) {
      const kind = lower.includes('f') ? 'f' : 't';
      const start = this.position();
      this.index = quoteStart + quote.length;
      yield this.make(
        kind === 'f' ? TOKEN_TYPES.FSTRING_START : TOKEN_TYPES.TSTRING_START,
        prefix + quote,
        start,
        this.position(),
        this.row
      );
      this.strings.push({ quote, raw: lower.includes('r'), kind, fields: [], startRow: this.row });
      return;
    }
    yield this.plainString(quoteStart, quote, prefix);
  }

  private plainString(quoteStart: number, quote: string, prefix: string): Token {
    const firstRow = this.row;
    const start = this.position();
    let index = quoteStart + quote.length;
    for (;;) {
      const line = this.lines[this.row];
      if (index >= line.length || (quote.length === 1 && line[index] === '\n')) {
        if (quote.length === 1) {
          throw new TokenizeError(
            `unterminated string literal (detected at line ${this.row + 1})`,
            start[0],
            start[1] + prefix.length + 1
          );
        }
        this.row++;
        index = 0;
        if (!this.ensureLine()) {
          throw new TokenizeError(
            `unterminated triple-quoted string literal (detected at line ${this.row})`,
            start[0],
            start[1] + prefix.length + 1
          );
        }
        continue;
      }
      if (line[index] === '\\') index += 2;
      else if (line.startsWith(quote, index)) break;
      else index++;
    }
    this.index = index + quote.length;
    return this.make(
      TOKEN_TYPES.STRING,
      this.sourceBetween(firstRow, quoteStart - prefix.length),
      start,
      this.position(),
      firstRow
    );
  }

  /** The source text from a position on an earlier row to the current position. */
  private sourceBetween(firstRow: number, firstIndex: number): string {
    if (firstRow === this.row) return this.lines[firstRow].slice(firstIndex, this.index);
    return [
      this.lines[firstRow].slice(firstIndex),
      ...this.lines.slice(firstRow + 1, this.row),
      this.lines[this.row].slice(0, this.index),
    ].join('');
  }

  private inLiteral(string: Interpolated): boolean {
    const field = string.fields.at(-1);
    return !field || (field.inSpec && field.depth === this.depth);
  }

  /** Reads the literal text of an f-string or its format spec up to the next field, brace pair, or quote. */
  private *literalPart(string: Interpolated): Generator<Token, void, void> {
    const part: LiteralPart = {
      string,
      field: string.fields.at(-1),
      middle: string.kind === 'f' ? TOKEN_TYPES.FSTRING_MIDDLE : TOKEN_TYPES.TSTRING_MIDDLE,
      firstRow: this.row,
      startIndex: this.index,
      start: this.position(),
    };
    for (;;) {
      if (this.index >= this.lines[this.row].length) {
        this.continueLiteral(part);
        continue;
      }
      const tokens = this.literalStop(part);
      if (tokens) {
        yield* tokens;
        return;
      }
    }
  }

  /** Moves to the next line inside a triple-quoted literal, which a one-quote literal must not reach. */
  private continueLiteral({ string, start }: LiteralPart): void {
    if (string.quote.length === 1) {
      throw new TokenizeError(
        `unterminated f-string literal (detected at line ${this.row + 1})`,
        start[0],
        start[1] + 1
      );
    }
    this.row++;
    this.index = 0;
    if (!this.ensureLine()) throw new TokenizeError('unterminated triple-quoted f-string literal', start[0], start[1]);
  }

  /** The tokens that end the literal text at the current character, or undefined to read on. */
  private literalStop(part: LiteralPart): Token[] | undefined {
    const { string, field, start } = part;
    const line = this.lines[this.row];
    const char = line[this.index];
    if (!field && line.startsWith(string.quote, this.index)) return this.literalEnd(part);
    if (!field && string.quote.length === 1 && char === '\n') {
      throw new TokenizeError(
        `unterminated f-string literal (detected at line ${this.row + 1})`,
        start[0],
        start[1] + 1
      );
    }
    if (char === '\\' && !string.raw) return this.escape(part, line);
    if ((char === '{' || char === '}') && line[this.index + 1] === char && !field) {
      // A doubled brace ends the text token after its first brace, which stands for the pair.
      this.index++;
      const token = this.middleToken(part);
      this.index++;
      return [token];
    }
    if (char === '{' || char === '}') return this.brace(part, char);
    this.index++;
    return undefined;
  }

  private middleToken({ middle, firstRow, startIndex, start }: LiteralPart): Token {
    return this.make(middle, this.sourceBetween(firstRow, startIndex), start, this.position(), firstRow);
  }

  private literalEnd(part: LiteralPart): Token[] {
    const { string } = part;
    const tokens: Token[] = [];
    if (this.sourceBetween(part.firstRow, part.startIndex) !== '') tokens.push(this.middleToken(part));
    const end = this.position();
    this.index += string.quote.length;
    const type = string.kind === 'f' ? TOKEN_TYPES.FSTRING_END : TOKEN_TYPES.TSTRING_END;
    tokens.push(this.make(type, string.quote, end, this.position(), this.row));
    this.strings.pop();
    return tokens;
  }

  /** Skips an escape sequence; a named escape ends the text token there, as the C tokenizer reads its braces. */
  private escape(part: LiteralPart, line: string): Token[] | undefined {
    if (line[this.index + 1] === 'N' && line[this.index + 2] === '{') {
      this.index = line.indexOf('}', this.index) + 1;
      return [this.middleToken(part)];
    }
    this.index += 2;
    return undefined;
  }

  /** A brace that opens a replacement field, or closes the one whose format spec this is. */
  private brace(part: LiteralPart, char: string): Token[] {
    const { string, field, start } = part;
    const tokens: Token[] = [];
    // A format spec always ends with a text token, which may be empty.
    if (this.sourceBetween(part.firstRow, part.startIndex) !== '' || (field && char === '}')) {
      tokens.push(this.middleToken(part));
    }
    if (char === '{') {
      tokens.push(this.simple(TOKEN_TYPES.OP, '{'));
      this.depth++;
      string.fields.push({ depth: this.depth, inSpec: false });
    } else if (field) {
      tokens.push(this.simple(TOKEN_TYPES.OP, '}'));
      string.fields.pop();
      this.depth--;
    } else {
      throw new TokenizeError("f-string: single '}' is not allowed", start[0], start[1] + 1);
    }
    return tokens;
  }
}
