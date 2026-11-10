import type { SourceDiagnostic } from '../interpreter/diagnostics';

const MAX_INDENT_LEVELS = 100;

interface Indent {
  column: number;
  /** The column counting a tab as one, which must order lines alike, or the indentation is ambiguous. */
  altColumn: number;
}

/**
 * Finds the first indentation error CPython's tokenizer and parser report: an unexpected indent, a missing indented
 * block, a dedent to no enclosing level, or tabs and spaces mixed ambiguously.
 */
// code-gauge-allow functionNcss 31 -- Follows the indentation checks of CPython's tokenizer in their order.
// code-gauge-allow functionCognitiveComplexity 26 -- Follows the indentation checks of CPython's tokenizer in their order.
export function findIndentationError(source: string): SourceDiagnostic | undefined {
  const lines = logicalLines(source);
  const stack: Indent[] = [{ column: 0, altColumn: 0 }];
  let expectsBlock = false;
  let openerRow = 0;
  for (const line of lines) {
    const top = stack.at(-1) as Indent;
    const { indent, row } = line;
    if (indent.column > top.column) {
      if (indent.altColumn <= top.altColumn) return { row, message: TAB_MESSAGE };
      if (!expectsBlock) return { row, message: 'ここで字下げ（インデント）を始めることはできません。' };
      stack.push(indent);
      if (stack.length > MAX_INDENT_LEVELS) return { row, message: '字下げ（インデント）が深すぎます。' };
    } else {
      if (expectsBlock) return expectedBlock(row, openerRow);
      while (indent.column < (stack.at(-1) as Indent).column) stack.pop();
      const level = stack.at(-1) as Indent;
      if (indent.column !== level.column) {
        return { row, message: '字下げ（インデント）が、外側のどの行の字下げとも合っていません。' };
      }
      if (indent.altColumn !== level.altColumn) return { row, message: TAB_MESSAGE };
    }
    expectsBlock = line.opensBlock;
    openerRow = row;
  }
  if (expectsBlock) return expectedBlock((lines.at(-1)?.row ?? 0) + 1, openerRow);
  return undefined;
}

const TAB_MESSAGE = '字下げ（インデント）に、タブとスペースが紛らわしく混ざっています。';

function expectedBlock(row: number, openerRow: number): SourceDiagnostic {
  return { row, message: `${openerRow + 1}行目の : の後には、字下げ（インデント）した本体が必要です。` };
}

interface LogicalLine {
  row: number;
  indent: Indent;
  /** Whether the line ends with a colon outside brackets, which opens a block. */
  opensBlock: boolean;
}

/** Splits a source into its logical lines, skipping blank lines and lines holding only a comment. */
function logicalLines(source: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  const scanner = new Scanner(source);
  while (!scanner.done) {
    const indent = scanner.readIndent();
    const row = scanner.row;
    const ch = scanner.peek();
    if (ch === '\n' || ch === '\r' || ch === '#' || ch === undefined) {
      scanner.skipLine();
      continue;
    }
    const lastToken = scanner.readLogicalLine();
    lines.push({ row, indent, opensBlock: lastToken === ':' });
  }
  return lines;
}

class Scanner {
  private index = 0;
  row = 0;

  constructor(private readonly source: string) {}

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

  /** Reads to the end of a logical line, returning its last token outside comments. */
  readLogicalLine(): string {
    let depth = 0;
    let last = '';
    while (!this.done) {
      const ch = this.peek() as string;
      if (ch === '\n') {
        this.advance();
        if (depth === 0) return last;
        continue;
      }
      if (this.skipTrivia(ch)) continue;
      if (this.skipStringLiteral()) {
        last = 'string';
        continue;
      }
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      this.index++;
      last = ch;
    }
    return last;
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
