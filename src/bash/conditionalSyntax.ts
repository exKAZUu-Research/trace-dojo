import { charactersOf } from './characters';
import {
  type BashSyntaxError,
  skipBalanced,
  skipBlanks,
  skipWordPiece,
  type SourceText,
  SyntaxFailure,
} from './syntaxWords';

/**
 * `[[ ... ]]` from just after `[[`: a port of Bash's `cond_expr` and `cond_term`, over its lexer for conditional
 * words, where `=~` makes `(` and `|` part of its right operand, and `==`, `=`, and `!=` read extended patterns.
 */
export function parseConditional(text: SourceText, start: number): { end: number } | { error: BashSyntaxError } {
  const parser = new ConditionalParser(text, start);
  try {
    return { end: parser.parse() };
  } catch (error) {
    if (error instanceof SyntaxFailure) return { error: { row: error.row, text: error.text, near: error.near } };
    throw error;
  }
}

type ConditionalKind = 'word' | 'end' | 'operator' | 'newline' | 'eof';
type WordMode = 'plain' | 'regex' | 'pattern';

interface ConditionalToken {
  kind: ConditionalKind;
  text: string;
  row: number;
}

const UNARY_OPERATORS = new Set(charactersOf('abcdefghknoprstuvwxzGLNORS').map((letter) => `-${letter}`));
const BINARY_OPERATORS = new Set(['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);
const PATTERN_OPERATORS = new Set(['=', '==', '!=']);
const CONDITIONAL_OPERATORS = [
  '&&',
  '||',
  ';;&',
  ';;',
  ';&',
  '<<<',
  '<<-',
  '<<',
  '>>',
  '<&',
  '>&',
  '<>',
  '>|',
  '|&',
  '&>>',
  '&>',
];
const CONDITIONAL_METACHARACTERS = new Set(['&', '|', ';', '(', ')', '<', '>']);

class ConditionalParser {
  private token: ConditionalToken = { kind: 'eof', text: '', row: 0 };
  private index: number;
  private readonly startRow: number;

  constructor(
    private readonly text: SourceText,
    start: number
  ) {
    this.index = start;
    this.startRow = text.rowAt(start);
  }

  /** Parses the expression, returning the index after its `]]`. */
  parse(): number {
    this.or();
    if (this.token.kind === 'end') return this.index;
    if (this.token.kind === 'eof') this.fail(this.startRow, "unexpected EOF while looking for `]]'");
    this.fail(this.startRow, `syntax error in conditional expression: unexpected token \`${this.tokenText()}'`);
  }

  private or(): void {
    this.and();
    if (this.isOperator('||')) this.or();
  }

  private and(): void {
    this.term();
    if (this.isOperator('&&')) this.and();
  }

  private term(): void {
    this.text.nested(() => this.termAt());
  }

  private termAt(): void {
    this.skipNewlines();
    const { token } = this;
    // Bash's cond_term returns without a message at `]]`; its parser then names the text it stopped at.
    if (token.kind === 'end') this.text.fail(token.row, `syntax error near \`${token.text}'`);
    if (this.isOperator('(')) {
      this.or();
      if (!this.isOperator(')')) this.fail(token.row, `unexpected token \`${this.tokenText()}', expected \`)'`);
      this.skipNewlines();
      return;
    }
    if (token.kind === 'word' && token.text === '!') {
      this.term();
      return;
    }
    if (token.kind === 'word' && UNARY_OPERATORS.has(token.text)) {
      this.read('plain');
      if (this.token.kind !== 'word') {
        this.fail(this.token.row, `unexpected argument \`${this.tokenText()}' to conditional unary operator`);
      }
      this.skipNewlines();
      return;
    }
    if (token.kind !== 'word') {
      this.fail(token.row, `unexpected token \`${this.tokenText()}' in conditional command`);
    }
    this.binary();
  }

  /** A word and what follows it: a binary operator and its right operand, or nothing, as `[[ x ]]` tests `-n x`. */
  private binary(): void {
    this.read('plain');
    const operator = this.token;
    const isWordOperator = operator.kind === 'word' && (BINARY_OPERATORS.has(operator.text) || operator.text === '=~');
    if (!isWordOperator && !this.isOperator('<') && !this.isOperator('>')) {
      if (operator.kind === 'end' || this.isOperator('&&') || this.isOperator('||') || this.isOperator(')')) return;
      this.fail(operator.row, `unexpected token \`${this.tokenText()}', conditional binary operator expected`);
    }
    const mode = operator.text === '=~' ? 'regex' : PATTERN_OPERATORS.has(operator.text) ? 'pattern' : 'plain';
    this.read(isWordOperator ? mode : 'plain');
    if (this.token.kind !== 'word') {
      this.fail(this.token.row, `unexpected argument \`${this.tokenText()}' to conditional binary operator`);
    }
    this.skipNewlines();
  }

  /** Reports an error of the conditional parser, after which Bash's parser names the token it stopped at. */
  private fail(row: number, text: string): never {
    throw new SyntaxFailure(row, text, errorTokenFromText(this.text.source, this.index));
  }

  private skipNewlines(): void {
    do this.read('plain');
    while (this.token.kind === 'newline');
  }

  private isOperator(text: string): boolean {
    return this.token.kind === 'operator' && this.token.text === text;
  }

  private tokenText(): string {
    if (this.token.kind === 'newline') return 'newline';
    if (this.token.kind === 'eof') return 'EOF';
    return this.token.text;
  }

  private read(mode: WordMode): void {
    const { source } = this.text;
    this.index = skipBlanks(source, this.index);
    const row = this.text.rowAt(this.index);
    const c = source[this.index];
    if (this.index >= source.length) this.token = { kind: 'eof', text: '', row };
    else if (c === '\n') {
      this.index++;
      this.token = { kind: 'newline', text: '\n', row };
    } else {
      const operator =
        mode === 'regex'
          ? undefined
          : (CONDITIONAL_OPERATORS.find((text) => source.startsWith(text, this.index)) ??
            (CONDITIONAL_METACHARACTERS.has(c) ? c : undefined));
      if (operator) {
        this.index += operator.length;
        this.token = { kind: 'operator', text: operator, row };
      } else {
        const word = this.word(mode);
        this.token = { kind: word === ']]' ? 'end' : 'word', text: word, row };
      }
    }
  }

  private word(mode: WordMode): string {
    const { source } = this.text;
    const start = this.index;
    while (this.index < source.length) {
      const c = source[this.index];
      if (mode === 'regex' && c === '(') this.index = skipBalanced(this.text, this.index, '(', ')');
      else if (mode === 'regex' && c === '|') this.index++;
      else if (mode === 'pattern' && '?*+@!'.includes(c) && source[this.index + 1] === '(') {
        this.index = skipBalanced(this.text, this.index + 1, '(', ')');
      } else if (
        ' \t\n'.includes(c) ||
        (CONDITIONAL_METACHARACTERS.has(c) && (mode !== 'regex' || this.index > start))
      ) {
        break;
      } else this.index = skipWordPiece(this.text, this.index);
    }
    return source.slice(start, this.index);
  }
}

/**
 * Bash's `error_token_from_text`: the text its parser names after an error, found by going back from where its lexer
 * stopped in the current line over blanks, then to the blank or `;`, `|`, or `&` before it.
 */
function errorTokenFromText(source: string, index: number): string | undefined {
  const end = Math.min(index, source.length);
  const lineStart = source.lastIndexOf('\n', end - 2) + 1;
  const lineEnd = source.indexOf('\n', lineStart);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd + 1);
  let i = end - lineStart;
  if (i > 0 && i >= line.length) i--;
  while (i > 0 && ' \t\n'.includes(line[i])) i--;
  const tokenEnd = i > 0 ? i + 1 : 0;
  while (i > 0 && !' \n\t;|&'.includes(line[i])) i--;
  while (i !== tokenEnd && ' \t\n'.includes(line[i])) i++;
  if (tokenEnd > 0) return line.slice(i, tokenEnd);
  return line[0];
}
