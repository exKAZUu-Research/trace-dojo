import { type Token, TOKEN_TYPES, TokenizeError, Tokenizer } from './modules/tokenizer';

/**
 * Whether source text that the grammar rejects is a prefix of a longer program, which CPython's parser tells when
 * `PyCF_ALLOW_INCOMPLETE_INPUT` is set by reaching the end of the input while expecting more: inside brackets or a
 * triple-quoted string, after a line continuation, after a block's header, after decorators, or in a `try` block with no
 * handler. It decides as CPython does only for text that ends with a newline, which is what `codeop` asks about.
 */
export function isIncompleteInput(source: string, mode: 'exec' | 'eval' | 'single'): boolean {
  const lines = logicalLines(source);
  if (lines === 'eof') return mode !== 'eval' || isExpressionPrefix(tokensOf(source));
  if (lines === 'error') return false;
  if (lines.length === 0) return mode !== 'exec';
  if (mode === 'eval') return false;
  const last = lines.at(-1) as LogicalLine;
  if (continuesLine(source, last, mode)) return true;
  if (last.tokens[0]?.text === '@') return true;
  if (last.tokens.at(-1)?.text === ':' && opensBlockHere(lines)) return true;
  return lines.some(
    (line, index) =>
      line.tokens[0]?.text === 'try' &&
      line.tokens.at(-1)?.text === ':' &&
      lines.slice(index + 1).every((later) => later.depth > line.depth)
  );
}

/**
 * Whether the input ends with a backslash that continues its last line: always incomplete in exec mode, and in single
 * mode only when the line has tokens before it.
 */
function continuesLine(source: string, last: LogicalLine, mode: 'exec' | 'single'): boolean {
  const lastLine =
    source
      .replace(/\r?\n$/, '')
      .split('\n')
      .at(-1) ?? '';
  if (!lastLine.endsWith('\\')) return false;
  return mode === 'exec' || last.tokens.at(-1)?.start[0] === source.replace(/\r?\n$/, '').split('\n').length;
}

/** The keywords that begin a block's header. */
const HEADERS = new Set(['if', 'for', 'while', 'try', 'with', 'def', 'class', 'async', 'match']);
/** The keywords that begin a clause continuing a compound statement, with the headers that clause may follow. */
const CLAUSES: Record<string, readonly string[]> = {
  elif: ['if', 'elif'],
  else: ['if', 'elif', 'for', 'while', 'try', 'except'],
  except: ['try', 'except'],
  finally: ['try', 'except', 'else'],
  case: ['match', 'case'],
};

/**
 * Whether the last line, which ends with a colon, is a block's header where it stands: a header keyword, or a clause
 * at the depth of the header it continues.
 */
function opensBlockHere(lines: LogicalLine[]): boolean {
  const last = lines.at(-1) as LogicalLine;
  const keyword = last.tokens[0]?.text ?? '';
  if (keyword === 'case') return lines.at(-2)?.tokens[0]?.text === 'match' || hasSibling(lines, last, ['case']);
  const follows = CLAUSES[keyword];
  if (follows === undefined) return HEADERS.has(keyword);
  return hasSibling(lines, last, follows);
}

/** Whether the line before `line` at its depth, with none shallower between, begins with one of `keywords`. */
function hasSibling(lines: LogicalLine[], line: LogicalLine, keywords: readonly string[]): boolean {
  for (let index = lines.length - 2; index >= 0; index--) {
    const earlier = lines[index] as LogicalLine;
    if (earlier.depth < line.depth) return false;
    if (earlier.depth === line.depth) return keywords.includes(earlier.tokens[0]?.text ?? '');
  }
  return false;
}

interface LogicalLine {
  tokens: Token[];
  depth: number;
}

const SKIPPED = new Set<number>([TOKEN_TYPES.NL, TOKEN_TYPES.ENDMARKER, TOKEN_TYPES.COMMENT]);

/** The logical lines of source text, with their indentation depths, or how tokenizing it failed. */
function logicalLines(source: string): LogicalLine[] | 'eof' | 'error' {
  const lines: LogicalLine[] = [];
  let depth = 0;
  let current: Token[] = [];
  try {
    for (const token of tokensOf(source)) {
      if (token.type === TOKEN_TYPES.INDENT) depth++;
      else if (token.type === TOKEN_TYPES.DEDENT) depth--;
      else if (token.type === TOKEN_TYPES.NEWLINE) {
        lines.push({ tokens: current, depth });
        current = [];
      } else if (!SKIPPED.has(token.type)) current.push(token);
    }
  } catch (error) {
    if (!(error instanceof TokenizeError)) throw error;
    return isEndOfInputError(error.message) ? 'eof' : 'error';
  }
  if (current.length > 0) lines.push({ tokens: current, depth });
  return lines;
}

function isEndOfInputError(message: string): boolean {
  return message.startsWith('unexpected EOF') || message.startsWith('unterminated triple-quoted');
}

function* tokensOf(source: string): Generator<Token, void, void> {
  const lines = source.split(/(?<=\n)/);
  let index = 0;
  yield* new Tokenizer(() => lines[index++]).tokens();
}

/** Whether the tokens before the end of the input may begin an expression, as `eval` mode's grammar needs. */
function isExpressionPrefix(tokens: Iterable<Token>): boolean {
  let depth = 0;
  let first = true;
  try {
    for (const token of tokens) {
      if (first && STATEMENT_KEYWORDS.has(token.text)) return false;
      first = false;
      if (token.type === TOKEN_TYPES.OP && '([{'.includes(token.text)) depth++;
      else if (token.type === TOKEN_TYPES.OP && ')]}'.includes(token.text)) depth--;
      else if (depth === 0 && token.type === TOKEN_TYPES.OP && /^(?:[-+*/%&|^@]|\*\*|\/\/|<<|>>)?=$/.test(token.text)) {
        return false;
      }
    }
  } catch (error) {
    if (!(error instanceof TokenizeError)) throw error;
  }
  return true;
}

const STATEMENT_KEYWORDS = new Set([
  'assert',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'for',
  'from',
  'global',
  'if',
  'import',
  'nonlocal',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
]);
