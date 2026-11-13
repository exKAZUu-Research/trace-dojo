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

export interface IndentationError {
  diagnostic: SourceDiagnostic;
  /** The index of the logical line where the error is found, or the number of lines for one at the end. */
  lineIndex: number;
}

/**
 * Finds the first indentation error CPython's tokenizer and parser report: an unexpected indent, a missing indented
 * block, a dedent to no enclosing level, or tabs and spaces mixed ambiguously, or the first nesting of brackets or
 * f-strings deeper than its tokenizer allows.
 */
export function findIndentationError(
  source: string,
  lines: LogicalLine[],
  limitError?: SourceDiagnostic
): IndentationError | undefined {
  const stack: Indent[] = [{ column: 0, altColumn: 0 }];
  let previous: LogicalLine | undefined;
  for (const [lineIndex, line] of lines.entries()) {
    const diagnostic = indentError(stack, line, previous);
    if (diagnostic) return { diagnostic, lineIndex };
    // A clause where none may stand is the parser's error, which comes before the indentation of the lines after it.
    if (line.misplaced) return undefined;
    previous = line;
  }
  if (limitError) return { diagnostic: limitError, lineIndex: Math.max(0, lines.length - 1) };
  // At the end of the input, CPython reports the last line.
  if (!previous?.opensBlock) return undefined;
  return { diagnostic: { row: lastRow(source), message: expectedBlock(previous) }, lineIndex: lines.length };
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
  if (previous?.opensBlock) return { row, message: expectedBlock(previous) };
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

/** The row CPython reports for the end of the source: the last line, which a final line break does not start. */
function lastRow(source: string): number {
  return Math.max(0, source.replace(/\r?\n$/, '').split('\n').length - 1);
}

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
  /** Whether the line is a compound statement's header, ending with a colon outside brackets, which opens a block. */
  opensBlock: boolean;
  /** Whether the line has a colon outside brackets and strings. */
  hasColon: boolean;
  /** Whether the line is a clause such as `else` that follows no header it may continue. */
  misplaced: boolean;
  /** Whether the line is a decorator, which the next line must follow at the same indentation. */
  isDecorator: boolean;
}

/**
 * Splits a source into its logical lines, skipping blank lines and lines holding only a comment, up to the line where
 * the tokenizer stops at a nesting too deep.
 */
export function logicalLines(source: string): { lines: LogicalLine[]; limitError?: SourceDiagnostic } {
  const lines: LogicalLine[] = [];
  const scanner = new Scanner(source);
  /** The first word of the last line at each indentation column that is still open. */
  const previous = new Map<number, string>();
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
    try {
      const keyword = scanner.peekWord();
      const { lastToken, ...tokens } = scanner.readLogicalLine();
      for (const column of previous.keys()) if (column > indent.column) previous.delete(column);
      const misplaced = !continuesHeader(keyword, previous.get(indent.column));
      const opensBlock = lastToken === ':' && BLOCK_KEYWORDS.has(keyword) && !misplaced;
      lines.push({ row, offset, start, indent, opensBlock, isDecorator: ch === '@', misplaced, ...tokens });
      previous.set(indent.column, keyword);
    } catch (error) {
      if (!(error instanceof NestingLimitError)) throw error;
      lines.push({
        row,
        endRow: scanner.row,
        offset,
        start,
        end: scanner.offset,
        indent,
        opensBlock: false,
        hasColon: false,
        isDecorator: false,
        misplaced: false,
      });
      return { lines, limitError: { row: error.row, message: error.message } };
    }
  }
  return { lines };
}

/** The headers a clause such as `else` continues, which must come before it at its indentation. */
const CLAUSE_HEADERS: Record<string, readonly string[]> = {
  elif: ['if', 'elif'],
  else: ['if', 'elif', 'for', 'while', 'try', 'except', 'async'],
  except: ['try', 'except'],
  finally: ['try', 'except', 'else'],
};

function continuesHeader(keyword: string, previous: string | undefined): boolean {
  const headers = CLAUSE_HEADERS[keyword];
  return headers === undefined || (previous !== undefined && headers.includes(previous));
}

/** The keywords that begin the headers of compound statements and their clauses. */
const BLOCK_KEYWORDS = new Set([
  'if',
  'elif',
  'else',
  'for',
  'while',
  'try',
  'except',
  'finally',
  'with',
  'def',
  'class',
  'async',
  'match',
  'case',
]);

/** Stops the scan where the tokenizer refuses a nesting too deep. */
class NestingLimitError extends Error {
  constructor(
    readonly row: number,
    message: string
  ) {
    super(message);
  }
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
  /** The brackets and f-string replacement fields open at the scanned point of the logical line. */
  private bracketLevel = 0;
  private fstringLevel = 0;

  constructor(private readonly source: string) {}

  get offset(): number {
    return this.index;
  }

  /** The name or keyword at the current position, if any. */
  peekWord(): string {
    return /^[\p{L}_][\p{L}\p{N}_]*/u.exec(this.source.slice(this.index, this.index + 20))?.[0] ?? '';
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

  /** Reads to the end of a logical line, describing its tokens outside comments. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Follows how CPython's tokenizer joins the physical lines of a logical line.
  readLogicalLine(): LineTokens {
    this.bracketLevel = 0;
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
        if ('([{'.includes(ch)) {
          depth++;
          this.openBracket();
        }
        if (')]}'.includes(ch)) {
          depth = Math.max(0, depth - 1);
          this.bracketLevel = Math.max(0, this.bracketLevel - 1);
        }
        if (ch === ':' && depth === 0 && this.peek(1) !== '=') tokens.hasColon = true;
        this.index++;
        tokens.lastToken = ch;
      }
      tokens.end = this.index;
      tokens.endRow = this.row;
    }
    return tokens;
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
