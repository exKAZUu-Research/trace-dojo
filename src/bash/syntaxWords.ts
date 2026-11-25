/** How Bash's lexer reads the pieces of words, shared by the checks of commands and of conditional expressions. */

/** A syntax error: the 0-based row Bash reports and its message. */
export interface BashSyntaxError {
  row: number;
  text: string;
  /**
   * The token Bash's parser then names in a second message, `syntax error near`, after an error its conditional
   * parser reports.
   */
  near?: string;
}

export class SyntaxFailure extends Error {
  constructor(
    readonly row: number,
    readonly text: string,
    readonly near?: string
  ) {
    super(text);
  }
}

/** The nesting the tree's own check allows, which no program needs to exceed. */
const MAX_NESTING = 300;

/** A nesting too deep to read, which the tree's own check then rejects. */
export class UnknownSyntax extends Error {}

/** A balanced arithmetic, compound-subscript, or parameter-expansion region whose evaluation Bash defers until run time. */
export interface DeferredRegion {
  opener: '((' | '$((' | '$[' | '[' | '${';
  openStart: number;
  start: number;
  end: number;
  closeEnd: number;
  keepsSemicolons: boolean;
  inDouble?: boolean;
}

/** A program's text, with its rows, and the parser of the command substitutions its words hold. */
export class SourceText {
  private readonly lineStarts: number[] = [0];
  private depth = 0;
  /** The backquoted command substitutions read, from the opening `` ` `` to just after the closing one. */
  readonly backquotes: { start: number; end: number }[] = [];
  /** Offsets of characters that are contextual literals in Bash (`'` in `"${...}"`, `$` before non-ASCII, etc.). */
  readonly literalSingleQuotes: number[] = [];
  /** Start offsets of declaration-builtin names (`declare`, `local`, ...) used as `name ()` function headers. */
  readonly declarationFunctionStarts: number[] = [];
  /** Balanced arithmetic and compound-subscript spans collected during the single lexical/validation pass. */
  readonly arithmeticRegions: DeferredRegion[] = [];
  /** Parses the commands of `$(...)` from just after `$(`, returning the index after its `)`. */
  parseSubstitution: (start: number) => number = () => {
    throw new Error('No parser for command substitutions');
  };

  constructor(readonly source: string) {
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') this.lineStarts.push(i + 1);
  }

  rowAt(index: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** The row Bash reports at the end of the file: the line after the last newline. */
  get eofRow(): number {
    return this.lineStarts.length - 1;
  }

  /**
   * Reads a nested piece of a program, giving up on a nesting deeper than any program needs before the stack runs out;
   * the tree's own check then rejects it as too deep.
   */
  nested<T>(read: () => T): T {
    if (++this.depth > MAX_NESTING) throw new UnknownSyntax();
    try {
      return read();
    } finally {
      this.depth--;
    }
  }

  fail(row: number, text: string): never {
    throw new SyntaxFailure(row, text);
  }

  unclosed(index: number, delimiter: string): never {
    this.fail(this.rowAt(index), `unexpected EOF while looking for matching \`${delimiter}'`);
  }
}

/**
 * Skips what Bash reads as one piece of a word: a quoted string, an expansion, or one character. A command
 * substitution's commands are parsed as Bash parses them; a backquoted one is read only when it runs.
 */
export function skipWordPiece(text: SourceText, index: number): number {
  const { source } = text;
  const c = source[index];
  if (c === '\\') return Math.min(index + 2, source.length);
  if (c === "'") return closeAt(text, index, source.indexOf("'", index + 1), "'");
  if (c === '"') return skipDoubleQuoted(text, index);
  if (c === '`') return skipBackquoted(text, index);
  if (c !== '$') return index + 1;
  const next = source[index + 1];
  if (next === "'") return skipAnsiC(text, index + 1);
  if (next === '"') return skipDoubleQuoted(text, index + 1);
  if (next === '{') return skipBraces(text, index + 1);
  if (next === '[') {
    const closeEnd = skipBalanced(text, index + 1, '[', ']');
    text.arithmeticRegions.push({
      opener: '$[',
      openStart: index,
      start: index + 2,
      end: closeEnd - 1,
      closeEnd,
      keepsSemicolons: false,
    });
    return closeEnd;
  }
  if (next === '(') return skipDollarParenthesis(text, index + 1);
  if ((source.codePointAt(index + 1) ?? 0) > 0x7f) text.literalSingleQuotes.push(index);
  return index + 1;
}

function closeAt(text: SourceText, open: number, close: number, delimiter: string): number {
  if (close === -1) text.unclosed(open, delimiter);
  return close + 1;
}

function skipDoubleQuoted(text: SourceText, open: number): number {
  return text.nested(() => {
    const { source } = text;
    let i = open + 1;
    while (i < source.length && source[i] !== '"') {
      const c = source[i];
      if (c === '\\') i += 2;
      else if (c === '`') i = skipBackquoted(text, i);
      else if (c === '$') i = skipDoubleQuotedDollar(text, i);
      else i++;
    }
    return closeAt(text, open, i < source.length ? i : -1, '"');
  });
}

function skipDoubleQuotedDollar(text: SourceText, dollar: number): number {
  const next = text.source[dollar + 1];
  if (next === '{') return skipBraces(text, dollar + 1, true);
  if (next === '[' || next === '(') return skipWordPiece(text, dollar);
  if ((text.source.codePointAt(dollar + 1) ?? 0) > 0x7f) text.literalSingleQuotes.push(dollar);
  return dollar + 1;
}

function skipAnsiC(text: SourceText, open: number): number {
  const { source } = text;
  let i = open + 1;
  while (i < source.length && source[i] !== "'") i += source[i] === '\\' ? 2 : 1;
  return closeAt(text, open, i < source.length ? i : -1, "'");
}

function skipBackquoted(text: SourceText, open: number): number {
  const { source } = text;
  let i = open + 1;
  while (i < source.length && source[i] !== '`') i += source[i] === '\\' ? 2 : 1;
  const end = closeAt(text, open, i < source.length ? i : -1, '`');
  // Bash reads a backquoted body only when it runs it, so its syntax is checked apart from the program's.
  text.backquotes.push({ start: open, end });
  return end;
}

function skipBraces(text: SourceText, open: number, inDouble = false): number {
  return text.nested(() => {
    const { source } = text;
    let i = open + 1;
    let closeEnd: number;
    if (inDouble) {
      i = skipParameterHeader(text, i);
      closeEnd = usesDoubleQuotedBraceBody(source, i)
        ? skipDoubleQuotedBraceBody(text, open, i)
        : skipUnquotedBraceBody(text, open, i);
    } else {
      closeEnd = skipUnquotedBraceBody(text, open, i);
    }
    const first = source[open + 1];
    if (first !== undefined && !' \t\n|}'.includes(first)) {
      text.arithmeticRegions.push({
        opener: '${',
        openStart: open - 1,
        start: open + 1,
        end: closeEnd - 1,
        closeEnd,
        keepsSemicolons: false,
        ...(inDouble ? { inDouble: true } : {}),
      });
    }
    return closeEnd;
  });
}

const UNQUOTED_BRACE_OPERATORS = new Set(['#', '%', '/', '^', ',', '~', '?']);

function usesDoubleQuotedBraceBody(source: string, index: number): boolean {
  const op = source[index];
  if (op === undefined || UNQUOTED_BRACE_OPERATORS.has(op)) return false;
  return !(op === ':' && source[index + 1] === '?');
}

function skipParameterHeader(text: SourceText, start: number): number {
  const { source } = text;
  let i = start;
  if (source[i] === '!' || (source[i] === '#' && source[i + 1] !== '}')) i++;
  if (/[A-Za-z_]/.test(source[i] ?? '')) {
    while (/[A-Za-z0-9_]/.test(source[i] ?? '')) i++;
    if (source[i] === '[') i = skipHeaderSubscript(text, i);
  } else if (/\d/.test(source[i] ?? '')) {
    while (/\d/.test(source[i] ?? '')) i++;
  } else if ('@#?*!$_-'.includes(source[i] ?? '')) {
    i++;
  }
  return i;
}

function skipHeaderSubscript(text: SourceText, open: number): number {
  return text.nested(() => {
    const { source } = text;
    let depth = 0;
    for (let i = open; i < source.length;) {
      const c = source[i];
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) return i + 1;
      else if (c === '}') return i;
      i = c === '[' || c === ']' ? i + 1 : skipWordPiece(text, i);
    }
    return source.length;
  });
}

function skipDoubleQuotedBraceBody(text: SourceText, open: number, start: number): number {
  const { source } = text;
  for (let i = start; i < source.length;) {
    const c = source[i];
    if (c === '}') return i + 1;
    if (c === "'") {
      text.literalSingleQuotes.push(i);
      i++;
    } else if (c === '\\') i = Math.min(i + 2, source.length);
    else if (c === '"') i = skipDoubleQuoted(text, i);
    else if (c === '`') i = skipBackquoted(text, i);
    else if (c === '$' && source[i + 1] === '{') i = skipBraces(text, i + 1, true);
    else if (c === '$') i = skipWordPiece(text, i);
    else i++;
  }
  return text.unclosed(open, '}');
}

function skipUnquotedBraceBody(text: SourceText, open: number, start: number): number {
  const { source } = text;
  let i = start;
  while (i < source.length) {
    if (source[i] === '}') return i + 1;
    i = skipWordPiece(text, i);
  }
  return text.unclosed(open, '}');
}

/** Skips text from an opening delimiter to its matching closing delimiter. */
export function skipBalanced(text: SourceText, open: number, opener: string, closer: string): number {
  return text.nested(() => {
    const { source } = text;
    let depth = 0;
    for (let i = open; i < source.length;) {
      const c = source[i];
      if (c === opener) depth++;
      else if (c === closer && --depth === 0) return i + 1;
      i = c === opener || c === closer ? i + 1 : skipWordPiece(text, i);
    }
    return text.unclosed(open, closer);
  });
}

/** `$((...))`, which Bash reads as text up to the matching parenthesis, or `$(...)`, whose commands it parses. */
function skipDollarParenthesis(text: SourceText, open: number): number {
  return text.nested(() => {
    if (text.source[open + 1] === '(') {
      const closeEnd = arithmeticEnd(text, open);
      if (closeEnd !== undefined) {
        text.arithmeticRegions.push({
          opener: '$((',
          openStart: open - 1,
          start: open + 2,
          end: closeEnd - 2,
          closeEnd,
          keepsSemicolons: false,
        });
        return closeEnd;
      }
      return skipBalanced(text, open, '(', ')');
    }
    return text.parseSubstitution(open + 1);
  });
}

/**
 * The index after the `))` that closes the `((` at `open`, or `undefined` when its parentheses close with a single
 * `)`, which makes it a nested subshell for Bash.
 */
export function arithmeticEnd(text: SourceText, open: number): number | undefined {
  const close = arithmeticClose(text, open);
  return close.doubleClosed ? close.index + 2 : undefined;
}

export function arithmeticClose(text: SourceText, open: number): { index: number; doubleClosed: boolean } {
  const { source } = text;
  let depth = 0;
  for (let i = open + 2; i < source.length;) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth > 0) depth--;
      else return { index: i, doubleClosed: source[i + 1] === ')' };
    }
    i = c === '(' || c === ')' ? i + 1 : skipWordPiece(text, i);
  }
  return text.unclosed(open, ')');
}

/** The index after the blanks, joined lines, and comment at `index`, which separate tokens. */
export function skipBlanks(source: string, index: number): number {
  let i = index;
  for (;;) {
    while (source[i] === ' ' || source[i] === '\t') i++;
    if (source.startsWith('\\\n', i)) i += 2;
    else if (source[i] === '#') {
      while (i < source.length && source[i] !== '\n') i++;
    } else return i;
  }
}
