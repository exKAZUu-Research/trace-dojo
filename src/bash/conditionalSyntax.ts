/**
 * Clean-room syntax validator for `[[ ... ]]` conditional commands from GNU Bash Reference Manual §3.2.5.2.
 */

import { charactersOf } from './characters';
import {
  type BashSyntaxError,
  skipBalanced,
  skipBlanks,
  skipWordPiece,
  type SourceText,
  SyntaxFailure,
} from './syntaxWords';

export function parseConditional(text: SourceText, start: number): { end: number } | { error: BashSyntaxError } {
  const validator = new ConditionalValidator(text, start);
  try {
    return { end: validator.validate() };
  } catch (error) {
    if (error instanceof SyntaxFailure) return { error: { row: error.row, text: error.text, near: error.near } };
    throw error;
  }
}

type LexContext = 'default' | 'pattern' | 'regex';

interface Lexeme {
  kind: 'word' | 'close' | 'punct' | 'newline' | 'eof';
  value: string;
  row: number;
}

const UNARY_CONDITIONAL_OPS = new Set(charactersOf('abcdefghknoprstuvwxzGLNORS').map((ch) => `-${ch}`));
const BINARY_WORD_OPS = new Set(['=', '==', '!=', '=~', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);
const GLOB_OPS = new Set(['=', '==', '!=']);
const MULTI_CHAR_PUNCTS = [
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
const SINGLE_CHAR_PUNCTS = new Set(['&', '|', ';', '(', ')', '<', '>']);

class ConditionalValidator {
  private current: Lexeme = { kind: 'eof', value: '', row: 0 };
  private cursor: number;
  private readonly openRow: number;

  constructor(
    private readonly text: SourceText,
    start: number
  ) {
    this.cursor = start;
    this.openRow = text.rowAt(start);
  }

  validate(): number {
    this.parseOr();
    if (this.current.kind === 'close') return this.cursor;
    if (this.current.kind === 'eof') this.abort(this.openRow, "unexpected EOF while looking for `]]'");
    this.abort(this.openRow, `syntax error in conditional expression: unexpected token \`${this.displayCurrent()}'`);
  }

  private parseOr(atGroupStart = false): void {
    this.parseAnd(atGroupStart);
    while (this.isPunct('||')) this.parseAnd();
  }

  private parseAnd(atGroupStart = false): void {
    this.parseAtom(atGroupStart);
    while (this.isPunct('&&')) this.parseAtom();
  }

  // code-gauge-allow functionCognitiveComplexity -- Validates parenthesized, negated, unary, and binary/word conditional primaries.
  private parseAtom(atGroupStart = false): void {
    this.text.nested(() => {
      this.advancePastNewlines();
      const first = this.current;
      if (first.kind === 'close') {
        if (atGroupStart) this.abort(first.row, "expected `)'");
        const near = immediateSeparatorAfterClose(this.text.source, this.cursor) ?? first.value;
        this.text.fail(first.row, `syntax error near \`${near}'`);
      }
      if (this.isPunct('(')) {
        this.parseOr(true);
        if (!this.isPunct(')')) this.abort(first.row, `unexpected token \`${this.displayCurrent()}', expected \`)'`);
        this.advancePastNewlines();
        return;
      }
      if (first.kind === 'word' && first.value === '!') {
        this.parseAtom();
        return;
      }
      if (first.kind === 'word' && UNARY_CONDITIONAL_OPS.has(first.value)) {
        this.scan('default');
        if (this.current.kind !== 'word') {
          this.abort(this.current.row, `unexpected argument \`${this.displayCurrent()}' to conditional unary operator`);
        }
        this.advancePastNewlines();
        return;
      }
      if (first.kind !== 'word') {
        this.abort(first.row, `unexpected token \`${this.displayCurrent()}' in conditional command`);
      }
      this.parseAfterOperand();
    });
  }

  private parseAfterOperand(): void {
    this.scan('default');
    const op = this.current;
    const wordOp = op.kind === 'word' && BINARY_WORD_OPS.has(op.value);
    const angleOp = this.isPunct('<') || this.isPunct('>');
    if (!wordOp && !angleOp) {
      if (op.kind === 'close' || this.isPunct('&&') || this.isPunct('||') || this.isPunct(')')) return;
      this.abort(op.row, `unexpected token \`${this.displayCurrent()}', conditional binary operator expected`);
    }
    const rhsContext: LexContext = !wordOp
      ? 'default'
      : op.value === '=~'
        ? 'regex'
        : GLOB_OPS.has(op.value)
          ? 'pattern'
          : 'default';
    this.scan(rhsContext);
    if (this.current.kind !== 'word') {
      this.abort(this.current.row, `unexpected argument \`${this.displayCurrent()}' to conditional binary operator`);
    }
    this.advancePastNewlines();
  }

  private abort(row: number, message: string): never {
    const near =
      (this.current.kind === 'close' ? immediateSeparatorAfterClose(this.text.source, this.cursor) : undefined) ??
      trailingLineToken(this.text.source, this.cursor);
    throw new SyntaxFailure(row, message, near);
  }

  private advancePastNewlines(): void {
    do this.scan('default');
    while (this.current.kind === 'newline');
  }

  private isPunct(symbol: string): boolean {
    return this.current.kind === 'punct' && this.current.value === symbol;
  }

  private displayCurrent(): string {
    if (this.current.kind === 'newline') return 'newline';
    if (this.current.kind === 'eof') return 'EOF';
    return this.current.value;
  }

  private scan(context: LexContext): void {
    const { source } = this.text;
    this.cursor = skipBlanks(source, this.cursor);
    const row = this.text.rowAt(this.cursor);
    if (this.cursor >= source.length) {
      this.current = { kind: 'eof', value: '', row };
      return;
    }
    const ch = source[this.cursor];
    if (ch === '\n') {
      this.cursor++;
      this.current = { kind: 'newline', value: '\n', row };
      return;
    }
    if (context !== 'regex') {
      const punct =
        MULTI_CHAR_PUNCTS.find((candidate) => source.startsWith(candidate, this.cursor)) ??
        (SINGLE_CHAR_PUNCTS.has(ch) ? ch : undefined);
      if (punct) {
        this.cursor += punct.length;
        this.current = { kind: 'punct', value: punct, row };
        return;
      }
    }
    const word = this.scanWord(context);
    this.current = { kind: word === ']]' ? 'close' : 'word', value: word, row };
  }

  private scanWord(context: LexContext): string {
    const { source } = this.text;
    const begin = this.cursor;
    while (this.cursor < source.length) {
      const ch = source[this.cursor];
      if (context === 'regex' && ch === '(') {
        this.cursor = skipBalanced(this.text, this.cursor, '(', ')');
      } else if (context === 'regex' && ch === '|') {
        this.cursor++;
      } else if (context === 'pattern' && '?*+@!'.includes(ch) && source[this.cursor + 1] === '(') {
        this.cursor = skipBalanced(this.text, this.cursor + 1, '(', ')');
      } else if (
        ch === ' ' ||
        ch === '\t' ||
        ch === '\n' ||
        (SINGLE_CHAR_PUNCTS.has(ch) && (context !== 'regex' || this.cursor > begin))
      ) {
        break;
      } else {
        this.cursor = skipWordPiece(this.text, this.cursor);
      }
    }
    return source.slice(begin, this.cursor);
  }
}

function immediateSeparatorAfterClose(source: string, cursor: number): string | undefined {
  const ch = source[cursor];
  const next = source[cursor + 1];
  if (ch === ';' && next !== ';' && next !== '&') return ';';
  if (ch === '&' && next !== '&' && next !== '>') return '&';
  return undefined;
}

/** Extracts the token immediately preceding `cursor` on the current line for Bash's secondary `syntax error near` diagnostic. */
function trailingLineToken(source: string, cursor: number): string | undefined {
  const limit = Math.min(cursor, source.length);
  const lineStart = source.lastIndexOf('\n', limit - 2) + 1;
  const nextBreak = source.indexOf('\n', lineStart);
  const line = source.slice(lineStart, nextBreak === -1 ? source.length : nextBreak + 1);
  let pos = limit - lineStart;
  if (pos > 0 && pos >= line.length) pos--;
  while (pos > 0 && (line[pos] === ' ' || line[pos] === '\t' || line[pos] === '\n')) pos--;
  if (pos === 0) return line[0];
  const tokenEnd = pos + 1;
  while (pos > 0 && !' \t\n;|&'.includes(line[pos])) pos--;
  while (pos < tokenEnd && (line[pos] === ' ' || line[pos] === '\t' || line[pos] === '\n')) pos++;
  return line.slice(pos, tokenEnd);
}
