import type { SourceDiagnostic } from '../interpreter/diagnostics';

const MAX_INDENT_LEVELS = 100;
/** CPython's tokenizer's MAXLEVEL: the brackets, and the braces of f-string replacement fields, one may nest. */
const MAX_BRACKET_LEVELS = 200;
/** CPython's tokenizer's MAXFSTRINGLEVEL, the f-strings and t-strings nested inside one another it refuses. */
const MAX_FSTRING_LEVELS = 150;

interface Indent {
  column: number;
  /** The column counting a tab as one, which must order lines alike, or the indentation is ambiguous. */
  altColumn: number;
}

/**
 * Finds the first indentation error CPython's tokenizer and parser report: an unexpected indent, a missing indented
 * block, a dedent to no enclosing level, or tabs and spaces mixed ambiguously, or the first nesting of brackets or
 * f-strings deeper than its tokenizer allows.
 */
export function findIndentationError(source: string): SourceDiagnostic | undefined {
  const { lines, limitError } = logicalLines(source);
  const stack: Indent[] = [{ column: 0, altColumn: 0 }];
  let previous: LogicalLine | undefined;
  for (const line of lines) {
    const error = indentError(stack, line, previous);
    if (error) return error;
    previous = line;
  }
  if (limitError) return limitError;
  if (previous?.opensBlock) return expectedBlock(previous.row + 1, previous.row);
  return undefined;
}

/** The error a line's indentation makes after `previous`, keeping `stack` the indentation levels open. */
function indentError(
  stack: Indent[],
  line: LogicalLine,
  previous: LogicalLine | undefined
): SourceDiagnostic | undefined {
  const top = stack.at(-1) as Indent;
  const { indent, row } = line;
  if (indent.column > top.column) {
    if (indent.altColumn <= top.altColumn) return { row, message: TAB_MESSAGE };
    if (!previous?.opensBlock) return { row, message: 'ここで字下げ（インデント）を始めることはできません。' };
    stack.push(indent);
    return stack.length > MAX_INDENT_LEVELS ? { row, message: '字下げ（インデント）が深すぎます。' } : undefined;
  }
  if (previous?.opensBlock) return expectedBlock(row, previous.row);
  if (previous?.isDecorator && indent.column < top.column) {
    return { row, message: 'デコレータの後の行の字下げ（インデント）を戻すことはできません。' };
  }
  while (indent.column < (stack.at(-1) as Indent).column) stack.pop();
  const level = stack.at(-1) as Indent;
  if (indent.column !== level.column) {
    return { row, message: '字下げ（インデント）が、外側のどの行の字下げとも合っていません。' };
  }
  return indent.altColumn === level.altColumn ? undefined : { row, message: TAB_MESSAGE };
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
  /** Whether the line is a decorator, which the next line must follow at the same indentation. */
  isDecorator: boolean;
}

/**
 * Splits a source into its logical lines, skipping blank lines and lines holding only a comment, up to the line where
 * the tokenizer stops at a nesting too deep.
 */
function logicalLines(source: string): { lines: LogicalLine[]; limitError?: SourceDiagnostic } {
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
    try {
      const lastToken = scanner.readLogicalLine();
      lines.push({ row, indent, opensBlock: lastToken === ':', isDecorator: ch === '@' });
    } catch (error) {
      if (!(error instanceof NestingLimitError)) throw error;
      lines.push({ row, indent, opensBlock: false, isDecorator: false });
      return { lines, limitError: { row: error.row, message: error.message } };
    }
  }
  return { lines };
}

/** Stops the scan where the tokenizer refuses a nesting too deep. */
class NestingLimitError extends Error {
  constructor(
    readonly row: number,
    message: string
  ) {
    super(message);
  }
}

class Scanner {
  private index = 0;
  row = 0;
  /** The brackets and f-string replacement fields open at the scanned point of the logical line. */
  private bracketLevel = 0;
  private fstringLevel = 0;

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

  // code-gauge-allow duplicateLines 17 -- The tokenize module's tokenizer measures a line's indentation alike.
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
    this.bracketLevel = 0;
    let last = '';
    while (!this.done) {
      const ch = this.peek() as string;
      if (ch === '\n') {
        this.advance();
        if (this.bracketLevel === 0) return last;
        continue;
      }
      if (this.skipTrivia(ch)) continue;
      if (this.skipStringLiteral()) {
        last = 'string';
        continue;
      }
      if ('([{'.includes(ch)) this.openBracket();
      if (')]}'.includes(ch)) this.bracketLevel = Math.max(0, this.bracketLevel - 1);
      this.index++;
      last = ch;
    }
    return last;
  }

  private openBracket(): void {
    this.bracketLevel++;
    if (this.bracketLevel > MAX_BRACKET_LEVELS) {
      throw new NestingLimitError(this.row, `括弧の入れ子が深すぎます（${MAX_BRACKET_LEVELS} 段まで）。`);
    }
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
  private readString(isFormatted: boolean, isRaw: boolean): void {
    if (isFormatted && ++this.fstringLevel >= MAX_FSTRING_LEVELS) {
      throw new NestingLimitError(this.row, `f 文字列の入れ子が深すぎます（${MAX_FSTRING_LEVELS - 1} 段まで）。`);
    }
    try {
      this.readStringBody(isFormatted, isRaw);
    } finally {
      if (isFormatted) this.fstringLevel--;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- One case per escape and quote rule of string literals.
  // code-gauge-allow functionNcss 32 -- One case per escape and quote rule of string literals.
  private readStringBody(isFormatted: boolean, isRaw: boolean): void {
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
        this.openBracket();
        this.index++;
        this.readInterpolation();
        this.bracketLevel--;
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
      if ('([{'.includes(ch)) {
        depth++;
        this.openBracket();
      }
      if (')]}'.includes(ch)) {
        if (depth === 0 && ch === '}') {
          this.index++;
          return;
        }
        depth--;
        this.bracketLevel--;
      }
      this.advance();
    }
  }
}
