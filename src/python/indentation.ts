import type { SourceDiagnostic } from '../interpreter/diagnostics';

const MAX_INDENT_LEVELS = 100;

interface Indent {
  column: number;
  /** The column counting a tab as one, which must order lines alike, or the indentation is ambiguous. */
  altColumn: number;
}

export interface IndentationError {
  diagnostic: SourceDiagnostic;
  /** The index of the logical line where the error is found, or the number of lines for one at the end. */
  lineIndex: number;
}

/**
 * Finds the first indentation error CPython's tokenizer and parser report: an unexpected indent, a missing indented
 * block, a dedent to no enclosing level, or tabs and spaces mixed ambiguously.
 */
export function findIndentationError(source: string, lines: LogicalLine[]): IndentationError | undefined {
  const stack: Indent[] = [{ column: 0, altColumn: 0 }];
  for (const [lineIndex, line] of lines.entries()) {
    const message = indentationProblem(stack, line, lines[lineIndex - 1]);
    if (message !== undefined) return { diagnostic: { row: line.row, message }, lineIndex };
  }
  const last = lines.at(-1);
  if (!last?.opensBlock) return undefined;
  return { diagnostic: { row: lastRow(source), message: expectedBlock(last) }, lineIndex: lines.length };
}

/** The indentation error of a line after the lines that built the stack of indentation levels, which it updates. */
function indentationProblem(stack: Indent[], line: LogicalLine, previous: LogicalLine | undefined): string | undefined {
  const top = stack.at(-1) as Indent;
  const { indent } = line;
  if (indent.column > top.column) {
    if (indent.altColumn <= top.altColumn) return TAB_MESSAGE;
    if (!previous?.opensBlock) return 'ここで字下げ（インデント）を始めることはできません。';
    stack.push(indent);
    return stack.length > MAX_INDENT_LEVELS ? '字下げ（インデント）が深すぎます。' : undefined;
  }
  if (previous?.opensBlock) return expectedBlock(previous);
  while (indent.column < (stack.at(-1) as Indent).column) stack.pop();
  const level = stack.at(-1) as Indent;
  if (indent.column !== level.column) return '字下げ（インデント）が、外側のどの行の字下げとも合っていません。';
  return indent.altColumn === level.altColumn ? undefined : TAB_MESSAGE;
}

/** The row CPython reports for the end of the source: the last line, which a final line break does not start. */
function lastRow(source: string): number {
  return Math.max(0, source.split('\n').length - (source.endsWith('\n') ? 2 : 1));
}

const TAB_MESSAGE = '字下げ（インデント）に、タブとスペースが紛らわしく混ざっています。';

function expectedBlock(opener: LogicalLine): string {
  return `${opener.row + 1}行目の : の後には、字下げ（インデント）した本体が必要です。`;
}

export interface LogicalLine {
  row: number;
  /** The row of the line's last token, which differs from `row` for a line continued over several rows. */
  endRow: number;
  /** The offset of the line's first character, which starts its indentation. */
  offset: number;
  /** The offsets of the line's first token and of the end of its last token. */
  start: number;
  end: number;
  indent: Indent;
  /** Whether the line ends with a colon outside brackets, which opens a block. */
  opensBlock: boolean;
  /** Whether the line has a colon outside brackets and strings. */
  hasColon: boolean;
}

/** Splits a source into its logical lines, skipping blank lines and lines holding only a comment. */
export function logicalLines(source: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  const scanner = new Scanner(source);
  while (!scanner.done) {
    const offset = scanner.offset;
    const indent = scanner.readIndent();
    const row = scanner.row;
    const start = scanner.offset;
    const ch = scanner.peek();
    if (ch === '\n' || ch === '\r' || ch === '#' || ch === undefined) {
      scanner.skipLine();
      continue;
    }
    const { lastToken, ...tokens } = scanner.readLogicalLine();
    lines.push({ row, offset, start, indent, opensBlock: lastToken === ':', ...tokens });
  }
  return lines;
}

interface LineTokens {
  lastToken: string;
  end: number;
  endRow: number;
  hasColon: boolean;
}

class Scanner {
  private index = 0;
  row = 0;

  constructor(private readonly source: string) {}

  get offset(): number {
    return this.index;
  }

  get done(): boolean {
    return this.index >= this.source.length;
  }

  peek(offset = 0): string | undefined {
    return this.source[this.index + offset];
  }

  private advance(): string {
    const ch = this.source[this.index++];
    if (ch === '\n') this.row++;
    return ch;
  }

  readIndent(): Indent {
    let column = 0;
    let altColumn = 0;
    for (;;) {
      const ch = this.peek();
      if (ch === ' ') {
        column++;
        altColumn++;
      } else if (ch === '\t') {
        column = (Math.floor(column / 8) + 1) * 8;
        altColumn++;
      } else if (ch === '\f') {
        column = 0;
        altColumn = 0;
      } else {
        return { column, altColumn };
      }
      this.index++;
    }
  }

  skipLine(): void {
    while (!this.done && this.peek() !== '\n') this.index++;
    if (!this.done) this.advance();
  }

  /** Reads to the end of a logical line, describing its tokens outside comments. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Follows how CPython's tokenizer joins the physical lines of a logical line.
  readLogicalLine(): LineTokens {
    const tokens: LineTokens = { lastToken: '', end: this.index, endRow: this.row, hasColon: false };
    let depth = 0;
    while (!this.done) {
      const ch = this.peek() as string;
      if (ch === '\n') {
        this.advance();
        if (depth === 0) break;
        continue;
      }
      if (this.skipTrivia(ch)) continue;
      if (this.skipStringLiteral()) {
        tokens.lastToken = 'string';
      } else {
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
        if (ch === ':' && depth === 0 && this.peek(1) !== '=') tokens.hasColon = true;
        this.index++;
        tokens.lastToken = ch;
      }
      tokens.end = this.index;
      tokens.endRow = this.row;
    }
    return tokens;
  }

  /** Skips a comment, a line continuation, or a whitespace character starting at `ch`, telling whether it did. */
  private skipTrivia(ch: string): boolean {
    if (ch === '#') {
      while (!this.done && this.peek() !== '\n') this.index++;
      return true;
    }
    if (ch === '\\' && (this.peek(1) === '\n' || (this.peek(1) === '\r' && this.peek(2) === '\n'))) {
      this.index++;
      if (this.peek() === '\r') this.index++;
      this.advance();
      return true;
    }
    if (/\s/.test(ch)) {
      this.index++;
      return true;
    }
    return false;
  }

  /** Skips a string literal with its prefix if one starts next, telling whether it did. */
  private skipStringLiteral(): boolean {
    const prefix = /^[rRbBuUfFtT]{0,2}(?=['"])/.exec(this.source.slice(this.index, this.index + 3));
    if (!prefix) return false;
    this.index += prefix[0].length;
    this.readString(/[ft]/i.test(prefix[0]), /r/i.test(prefix[0]));
    return true;
  }

  /** Skips a string literal whose opening quote is next, including the expressions an f-string holds. */
  // code-gauge-allow functionCognitiveComplexity 27 -- One case per escape and quote rule of string literals.
  private readString(isFormatted: boolean, isRaw: boolean): void {
    const quote = this.peek() as string;
    const isTriple = this.peek(1) === quote && this.peek(2) === quote;
    const delimiter = isTriple ? quote.repeat(3) : quote;
    this.index += delimiter.length;
    while (!this.done) {
      if (this.source.startsWith(delimiter, this.index)) {
        this.index += delimiter.length;
        return;
      }
      const ch = this.peek() as string;
      if (ch === '\n' && !isTriple) return;
      if (ch === '\\' && !isRaw) {
        this.advance();
        if (!this.done) this.advance();
        continue;
      }
      if (ch === '\\' && isRaw) {
        this.advance();
        if (this.peek() === quote || this.peek() === '\\') this.advance();
        continue;
      }
      if (isFormatted && ch === '{') {
        if (this.peek(1) === '{') {
          this.index += 2;
          continue;
        }
        this.index++;
        this.readInterpolation();
        continue;
      }
      this.advance();
    }
  }

  /** Skips the expression of an f-string's replacement field, up to its closing brace. */
  private readInterpolation(): void {
    let depth = 0;
    while (!this.done) {
      if (this.skipStringLiteral()) continue;
      const ch = this.peek() as string;
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) {
        if (depth === 0 && ch === '}') {
          this.index++;
          return;
        }
        depth--;
      }
      this.advance();
    }
  }
}
