/** How Bash's lexer reads the pieces of words, shared by the checks of commands and of conditional expressions. */

/** A syntax error: the 0-based row Bash reports and its message. */
export interface BashSyntaxError {
  row: number;
  text: string;
}

export class SyntaxFailure extends Error {
  constructor(
    readonly row: number,
    readonly text: string
  ) {
    super(text);
  }
}

/** The nesting the tree's own check allows, which no program needs to exceed. */
const MAX_NESTING = 300;

/** A here-document, whose body this port does not read, or a nesting too deep to read: the tree's diagnostics decide. */
export class UnknownSyntax extends Error {}

/** A program's text, with its rows, and the parser of the command substitutions its words hold. */
export class SourceText {
  private readonly lineStarts: number[] = [0];
  private depth = 0;
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
  if (next === '[') return skipBalanced(text, index + 1, '[', ']');
  if (next === '(') return skipDollarParenthesis(text, index + 1);
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
      i = c === '\\' ? i + 2 : c === '$' || c === '`' ? skipWordPiece(text, i) : i + 1;
    }
    return closeAt(text, open, i < source.length ? i : -1, '"');
  });
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
  return closeAt(text, open, i < source.length ? i : -1, '`');
}

function skipBraces(text: SourceText, open: number): number {
  return text.nested(() => {
    const { source } = text;
    let depth = 0;
    for (let i = open; i < source.length;) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return i + 1;
      i = c === '{' || c === '}' ? i + 1 : skipWordPiece(text, i);
    }
    return text.unclosed(open, '}');
  });
}

/** Skips text from an opening delimiter to its match, as Bash's `parse_matched_pair` does. */
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
    if (text.source[open + 1] === '(') return skipBalanced(text, open, '(', ')');
    return text.parseSubstitution(open + 1);
  });
}

/**
 * The index after the `))` that closes the `((` at `open`, as Bash's `parse_arith_cmd` finds it, or `undefined` when
 * its parentheses close with a single `)`, which makes it a nested subshell for Bash.
 */
export function arithmeticEnd(text: SourceText, open: number): number | undefined {
  const { source } = text;
  let depth = 0;
  for (let i = open + 2; i < source.length;) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth > 0) depth--;
      else return source[i + 1] === ')' ? i + 2 : undefined;
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
