// code-gauge-allow-file fileNcss 483 -- One port of Bash's grammar, whose rules call each other as its yacc rules do.
/**
 * Bash's syntax errors, found by a port of the grammar of `parse.y` over a port of how its lexer reads words, so that
 * a program fails where Bash's does, with Bash's message and line. The tree-sitter grammar builds the statements, but
 * it accepts and rejects some programs differently and cannot tell which token Bash stops at.
 */
import { parseConditional } from './conditionalSyntax';
import {
  arithmeticEnd,
  type BashSyntaxError,
  skipBlanks,
  skipWordPiece,
  SourceText,
  SyntaxFailure,
  UnknownSyntax,
} from './syntaxWords';

/**
 * The first syntax error Bash reports for a program, `undefined` when Bash reads it, or `'unknown'` for a program
 * with a here-document, whose body this port does not read, or with a nesting too deep to read.
 */
export function findBashSyntaxError(source: string): BashSyntaxError | 'unknown' | undefined {
  const text = new SourceText(source);
  text.parseSubstitution = (start) => new CommandParser(text, start, true).parseSubstitution();
  try {
    new CommandParser(text, 0, false).parseProgram();
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxFailure) return { row: error.row, text: error.text };
    if (error instanceof UnknownSyntax) return 'unknown';
    // The stack's size depends on where the program runs (a worker thread has less), so a nesting within the limit
    // may still exhaust it; the tree's own check then rejects the program as too deep.
    if (error instanceof RangeError) return 'unknown';
    throw error;
  }
}

type TokenKind = 'word' | 'number' | 'operator' | 'newline' | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  row: number;
  start: number;
  end: number;
  /** Whether a word has quotes, which keep it from being a reserved word. */
  quoted: boolean;
}

const OPERATORS = [
  ';;&',
  ';;',
  ';&',
  '&&',
  '&>>',
  '&>',
  '||',
  '|&',
  '<<<',
  '<<-',
  '<<',
  '<&',
  '<>',
  '>>',
  '>&',
  '>|',
  '((',
  ';',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
];
const REDIRECTIONS = new Set(['<', '>', '>>', '<>', '>|', '&>', '&>>', '<&', '>&', '<<<']);
const METACHARACTERS = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const DECLARATION_BUILTINS = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/;

/** Bash's lexer for commands: words, operators, and newlines, skipping blanks, comments, and joined lines. */
class CommandLexer {
  constructor(
    private readonly text: SourceText,
    public index: number
  ) {}

  /** @param assignmentAllowed Whether `name=(` starts a compound assignment, as before a command's name. */
  next(assignmentAllowed: boolean): Token {
    const { source } = this.text;
    this.index = skipBlanks(source, this.index);
    const start = this.index;
    const row = this.text.rowAt(start);
    if (start >= source.length) return this.token('eof', '', row, start, false);
    const c = source[start];
    if (c === '\n') {
      this.index++;
      return this.token('newline', '\n', row, start, false);
    }
    if ((c === '<' || c === '>') && source[start + 1] === '(') return this.word(assignmentAllowed);
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, start));
    if (operator) {
      if (operator === '<<' || operator === '<<-') throw new UnknownSyntax();
      this.index += operator.length;
      return this.token('operator', operator, row, start, false);
    }
    return this.word(assignmentAllowed);
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- A port of Bash's read_token_word: process substitutions, compound assignments, joined lines, and quotes.
  private word(assignmentAllowed: boolean): Token {
    const { source } = this.text;
    const start = this.index;
    let quoted = false;
    while (this.index < source.length) {
      const c = source[this.index];
      if ((c === '<' || c === '>') && source[this.index + 1] === '(') {
        this.index = this.text.parseSubstitution(this.index + 2);
        continue;
      }
      if (c === '(' && assignmentAllowed && ASSIGNMENT_PREFIX.test(source.slice(start, this.index))) {
        this.index = this.compoundAssignment(this.index);
        continue;
      }
      if (METACHARACTERS.has(c)) break;
      if (c === '\\' && source[this.index + 1] === '\n') {
        this.index += 2;
        continue;
      }
      if (`'"\\\`$`.includes(c)) quoted ||= c !== '$';
      this.index = skipWordPiece(this.text, this.index);
    }
    const word = source.slice(start, this.index);
    const kind = /^\d+$/.test(word) && (source[this.index] === '<' || source[this.index] === '>') ? 'number' : 'word';
    return this.token(kind, word, this.text.rowAt(start), start, quoted);
  }

  /** `name=(...)`: words and newlines up to `)`, where any other operator is an error. */
  private compoundAssignment(open: number): number {
    this.index = open + 1;
    for (;;) {
      const token = this.next(false);
      if (token.kind === 'eof') this.text.unclosed(open, ')');
      if (token.kind === 'operator' && token.text === ')') return this.index;
      if (token.kind === 'operator') {
        this.text.fail(token.row, `syntax error near unexpected token \`${token.text === '((' ? '(' : token.text}'`);
      }
    }
  }

  private token(kind: TokenKind, text: string, row: number, start: number, quoted: boolean): Token {
    return { kind, text, row, start, end: this.index, quoted };
  }
}

// ---------------------------------------------------------------- commands

const RESERVED_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  'time',
  'coproc',
  '{',
  '}',
  '!',
  '[[',
]);

/** The words that close or continue a construct, which cannot start a command. */
const CLOSING_WORDS = new Set(['then', 'else', 'elif', 'fi', 'esac', 'do', 'done', 'in', '}']);

const CASE_TERMINATORS = new Set([';;', ';&', ';;&']);

/** A recursive-descent port of Bash's yacc grammar, which stops at the first token no rule accepts. */
class CommandParser {
  private readonly lexer: CommandLexer;
  private lookahead: Token | undefined;
  private lookaheadAssigns = false;
  /** The constructs open at the current token, whose innermost Bash names when the file ends inside it. */
  private readonly open: { word: string; row: number }[] = [];

  /** @param inSubstitution Whether the commands are those of `$(...)`, which ends at its `)`. */
  constructor(
    private readonly text: SourceText,
    start: number,
    private readonly inSubstitution: boolean
  ) {
    this.lexer = new CommandLexer(text, start);
  }

  parseProgram(): void {
    for (;;) {
      this.skipNewlines();
      if (this.peek().kind === 'eof') return;
      this.simpleList();
    }
  }

  /** The commands of `$(...)`, returning the index after its `)`. */
  parseSubstitution(): number {
    for (;;) {
      this.skipNewlines();
      if (this.isOperator(this.peek(), ')')) return this.take().end;
      this.commands(false);
    }
  }

  /** A line's commands: and-or lists joined by `;` and `&`, ended by a newline or the end of the file. */
  private simpleList(): void {
    this.commands(false);
    const token = this.peek();
    if (token.kind !== 'newline' && token.kind !== 'eof') this.unexpected(token);
  }

  /**
   * Commands joined by `&&`, `||`, `;`, and `&`: within one line for a line of the program, or across newlines for
   * Bash's `compound_list`, which ends at a word that cannot start a command.
   */
  private commands(crossesLines: boolean): void {
    if (crossesLines) this.skipNewlines();
    this.pipelineCommand();
    for (;;) {
      const token = this.peek();
      if (this.isOperator(token, '&&') || this.isOperator(token, '||')) {
        this.take();
        this.skipNewlines();
        this.pipelineCommand();
        continue;
      }
      const separates =
        this.isOperator(token, ';') || this.isOperator(token, '&') || (crossesLines && token.kind === 'newline');
      if (!separates) return;
      this.take();
      if (crossesLines) this.skipNewlines();
      if (!this.startsCommand(this.peek())) return;
      this.pipelineCommand();
    }
  }

  private compoundList(): void {
    this.commands(true);
  }

  private pipelineCommand(): void {
    const token = this.peek();
    if (this.isReserved(token, '!')) {
      this.take();
      this.text.nested(() => this.pipelineCommand());
      return;
    }
    if (this.isReserved(token, 'time')) {
      this.take();
      if (this.peek().kind === 'word' && this.peek().text === '-p') this.take();
      const next = this.peek();
      const ends =
        next.kind === 'newline' || next.kind === 'eof' || this.isOperator(next, ';') || this.isOperator(next, '&');
      if (!ends) this.pipelineCommand();
      return;
    }
    this.command();
    while (this.isOperator(this.peek(), '|') || this.isOperator(this.peek(), '|&')) {
      this.take();
      this.skipNewlines();
      this.command();
    }
  }

  private command(): void {
    this.text.nested(() => this.commandAt());
  }

  private commandAt(): void {
    const token = this.peek();
    if (token.kind === 'word' && this.isReservedWord(token)) {
      if (CLOSING_WORDS.has(token.text) || token.text === 'in') this.unexpected(token);
      if (token.text === 'function') {
        this.functionKeyword();
        return;
      }
      if (token.text === 'coproc') {
        this.take();
        this.command();
        return;
      }
      this.shellCommand();
      this.redirections();
      return;
    }
    if (this.isOperator(token, '(') || this.isOperator(token, '((')) {
      this.shellCommand();
      this.redirections();
      return;
    }
    if (token.kind === 'word' || token.kind === 'number' || this.isRedirection(token)) {
      this.simpleCommand();
      return;
    }
    this.unexpected(token);
  }

  /** A command Bash's grammar names `shell_command`, which a function's body must be. */
  // code-gauge-allow functionNcss 32 -- One case per compound command of Bash's grammar.
  private shellCommand(): void {
    if (this.isOperator(this.peek(), '((') && this.arithmeticCommand()) return;
    const current = this.peek();
    if (this.isOperator(current, '(')) {
      this.group(current, ')');
      return;
    }
    if (current.kind !== 'word' || !this.isReservedWord(current)) this.unexpected(current);
    switch (current.text) {
      case 'if': {
        this.ifCommand(current);
        return;
      }
      case 'while':
      case 'until': {
        this.whileCommand(current);
        return;
      }
      case 'for':
      case 'select': {
        this.forCommand(current);
        return;
      }
      case 'case': {
        this.caseCommand(current);
        return;
      }
      case '{': {
        this.group(current, '}');
        return;
      }
      case '[[': {
        this.conditional(current);
        return;
      }
      default: {
        this.unexpected(current);
      }
    }
  }

  /**
   * `((...))`, telling whether it was one: a `((` that a single `)` closes is a subshell inside a subshell, which
   * leaves a `(` to read.
   */
  private arithmeticCommand(): boolean {
    const token = this.peek();
    const end = arithmeticEnd(this.text, token.start);
    if (end !== undefined) {
      this.skipTo(end);
      return true;
    }
    this.skipTo(token.start + 1);
    this.lookahead = { ...token, text: '(', end: token.start + 1 };
    return false;
  }

  private whileCommand(token: Token): void {
    this.opened(token, () => {
      this.take();
      this.compoundList();
      this.expectReserved('do');
      this.compoundList();
      this.expectReserved('done');
    });
  }

  private ifCommand(token: Token): void {
    this.opened(token, () => {
      this.take();
      this.compoundList();
      this.expectReserved('then');
      this.compoundList();
      for (;;) {
        const next = this.peek();
        if (this.isReserved(next, 'elif')) {
          this.take();
          this.compoundList();
          this.expectReserved('then');
          this.compoundList();
        } else if (this.isReserved(next, 'else')) {
          this.take();
          this.compoundList();
          this.expectReserved('fi');
          return;
        } else {
          this.expectReserved('fi');
          return;
        }
      }
    });
  }

  private forCommand(token: Token): void {
    this.opened(token, () => {
      this.take();
      const name = this.peek();
      if (this.isOperator(name, '((') && token.text === 'for') this.arithmeticFor(token, name);
      else this.forHeader(name);
      this.doGroup();
    });
  }

  /** The variable of `for` or `select`, then `in` and its words, a `;`, or nothing. */
  private forHeader(name: Token): void {
    if (name.kind !== 'word') this.unexpected(name);
    this.take();
    this.skipNewlines();
    const next = this.peek();
    if (next.kind === 'word' && next.text === 'in' && !next.quoted) {
      this.take();
      let word = this.peek();
      while (word.kind === 'word' || word.kind === 'number') {
        this.take();
        word = this.peek();
      }
      if (!this.isOperator(word, ';') && word.kind !== 'newline') this.unexpected(word);
    } else if (!this.isOperator(next, ';')) return;
    this.take();
    this.skipNewlines();
  }

  /** `for ((init; test; step))`, whose three expressions Bash's `make_arith_for_command` requires. */
  private arithmeticFor(forToken: Token, open: Token): void {
    const end = arithmeticEnd(this.text, open.start);
    if (end === undefined) this.unexpected({ ...open, text: '(' });
    const count = countExpressions(this.text, open.start + 2, end - 2);
    if (count < 3) this.text.fail(forToken.row, 'syntax error: arithmetic expression required');
    if (count > 3) this.text.fail(forToken.row, "syntax error: `;' unexpected");
    this.skipTo(end);
    if (this.isOperator(this.peek(), ';')) this.take();
    this.skipNewlines();
  }

  private doGroup(): void {
    const token = this.peek();
    if (this.isReserved(token, '{')) {
      this.group(token, '}');
      return;
    }
    this.expectReserved('do');
    this.compoundList();
    this.expectReserved('done');
  }

  private caseCommand(token: Token): void {
    this.opened(token, () => {
      this.take();
      const word = this.peek();
      if (word.kind !== 'word' && word.kind !== 'number') this.unexpected(word);
      this.take();
      this.skipNewlines();
      const inWord = this.peek();
      if (inWord.kind !== 'word' || inWord.text !== 'in' || inWord.quoted) this.unexpected(inWord);
      this.take();
      for (;;) {
        this.skipNewlines();
        if (this.isReserved(this.peek(), 'esac')) {
          this.take();
          return;
        }
        this.caseClause();
      }
    });
  }

  /** An optional `(`, patterns joined by `|`, `)`, an optional body, and `;;`, `;&`, or `;;&` unless `esac` follows. */
  private caseClause(): void {
    if (this.isOperator(this.peek(), '(')) this.take();
    this.pattern();
    while (this.isOperator(this.peek(), '|')) {
      this.take();
      this.pattern();
    }
    if (!this.isOperator(this.peek(), ')')) this.unexpected(this.peek());
    this.take();
    this.skipNewlines();
    if (!this.isCaseTerminator(this.peek()) && !this.isReserved(this.peek(), 'esac')) {
      this.compoundList();
      const end = this.peek();
      if (!this.isCaseTerminator(end) && !this.isReserved(end, 'esac')) this.unexpected(end);
    }
    if (this.isCaseTerminator(this.peek())) this.take();
  }

  private isCaseTerminator(token: Token): boolean {
    return token.kind === 'operator' && CASE_TERMINATORS.has(token.text);
  }

  private pattern(): void {
    const token = this.peek();
    if (token.kind !== 'word' && token.kind !== 'number') this.unexpected(token);
    this.take();
  }

  /** `{ ...; }` or `( ... )`. */
  private group(token: Token, closer: string): void {
    this.opened(token, () => {
      this.take();
      this.compoundList();
      const end = this.peek();
      const closes = closer === ')' ? this.isOperator(end, ')') : this.isReserved(end, closer);
      if (!closes) this.unexpected(end);
      this.take();
    });
  }

  private conditional(token: Token): void {
    this.opened(token, () => {
      const result = parseConditional(this.text, token.end);
      if ('error' in result) this.text.fail(result.error.row, result.error.text);
      this.skipTo(result.end);
    });
  }

  /** `function name`, an optional `()`, and the body. */
  private functionKeyword(): void {
    this.take();
    const name = this.peek();
    if (name.kind !== 'word') this.unexpected(name);
    this.take();
    if (this.isOperator(this.peek(), '(')) {
      this.take();
      if (!this.isOperator(this.peek(), ')')) this.unexpected(this.peek());
      this.take();
    }
    this.functionBody();
  }

  private functionBody(): void {
    this.skipNewlines();
    const body = this.peek();
    const isCompound =
      this.isOperator(body, '(') ||
      this.isOperator(body, '((') ||
      (body.kind === 'word' && this.isReservedWord(body) && !CLOSING_WORDS.has(body.text) && body.text !== '!');
    if (!isCompound || ['function', 'time', 'coproc'].includes(body.text)) this.unexpected(body);
    this.shellCommand();
    this.redirections();
  }

  /** Words, assignments, and redirections, or a function definition `name() body`. */
  // code-gauge-allow functionCognitiveComplexity 16 -- Bash's simple command: redirections, assignments, its name, and a function definition.
  private simpleCommand(): void {
    let name: string | undefined;
    for (let count = 0; ; count++) {
      const token = this.peek(name === undefined || DECLARATION_BUILTINS.has(name));
      if (token.kind === 'number' || this.isRedirection(token)) {
        this.redirection();
        continue;
      }
      if (token.kind !== 'word') return;
      this.take();
      if (name === undefined && !ASSIGNMENT_PREFIX.test(token.text.replace(/=[\s\S]*$/, '='))) name = token.text;
      if (count === 0 && this.isOperator(this.peek(), '(')) {
        this.take();
        if (!this.isOperator(this.peek(), ')')) this.unexpected(this.peek());
        this.take();
        this.functionBody();
        return;
      }
    }
  }

  private redirections(): void {
    while (this.peek().kind === 'number' || this.isRedirection(this.peek())) this.redirection();
  }

  private redirection(): void {
    if (this.peek().kind === 'number') this.take();
    const operator = this.peek();
    if (!this.isRedirection(operator)) this.unexpected(operator);
    this.take();
    const target = this.peek();
    if (target.kind !== 'word' && target.kind !== 'number') this.unexpected(target);
    this.take();
  }

  // ---------------------------------------------------------------- tokens

  /**
   * The next token without taking it.
   *
   * @param assignmentAllowed Whether `name=(` there starts a compound assignment.
   */
  private peek(assignmentAllowed = false): Token {
    // Only `name=(` reads differently where a compound assignment may be, so only it is read again: reading every
    // word again would read the command substitutions inside it again, twice for each level of nesting.
    if (
      this.lookahead &&
      this.lookaheadAssigns !== assignmentAllowed &&
      this.startsCompoundAssignment(this.lookahead)
    ) {
      this.lexer.index = this.lookahead.start;
      this.lookahead = undefined;
    }
    if (!this.lookahead) {
      this.lookahead = this.lexer.next(assignmentAllowed);
      this.lookaheadAssigns = assignmentAllowed;
    }
    return this.lookahead;
  }

  private startsCompoundAssignment(token: Token): boolean {
    if (token.kind !== 'word') return false;
    const word = this.text.source.slice(token.start, token.end + 1);
    const open = word.indexOf('(');
    return open !== -1 && ASSIGNMENT_PREFIX.test(word.slice(0, open));
  }

  private take(): Token {
    const token = this.lookahead ?? this.peek();
    this.lookahead = undefined;
    return token;
  }

  private skipTo(index: number): void {
    this.lookahead = undefined;
    this.lexer.index = index;
  }

  private skipNewlines(): void {
    while (this.peek().kind === 'newline') this.take();
  }

  private opened(token: Token, parse: () => void): void {
    this.open.push({ word: token.text, row: token.row });
    parse();
    this.open.pop();
  }

  private expectReserved(word: string): void {
    const token = this.peek();
    if (!this.isReserved(token, word)) this.unexpected(token);
    this.take();
  }

  private startsCommand(token: Token): boolean {
    if (token.kind === 'number' || this.isRedirection(token)) return true;
    if (this.isOperator(token, '(') || this.isOperator(token, '((')) return true;
    return token.kind === 'word' && !(this.isReservedWord(token) && CLOSING_WORDS.has(token.text));
  }

  private isReservedWord(token: Token): boolean {
    return !token.quoted && RESERVED_WORDS.has(token.text);
  }

  private isReserved(token: Token, word: string): boolean {
    return token.kind === 'word' && token.text === word && !token.quoted;
  }

  private isOperator(token: Token, text: string): boolean {
    return token.kind === 'operator' && token.text === text;
  }

  private isRedirection(token: Token): boolean {
    return token.kind === 'operator' && REDIRECTIONS.has(token.text);
  }

  private unexpected(token: Token): never {
    if (token.kind === 'eof') this.endOfFile();
    const text = token.kind === 'newline' ? 'newline' : token.text === '((' ? '(' : token.text;
    const looking = this.inSubstitution && !this.isOperator(token, ')') ? " while looking for matching `)'" : '';
    this.text.fail(token.row, `syntax error near unexpected token \`${text}'${looking}`);
  }

  private endOfFile(): never {
    const row = this.text.eofRow;
    if (this.inSubstitution) this.text.fail(row, "unexpected EOF while looking for matching `)'");
    const innermost = this.open.at(-1);
    if (innermost) {
      this.text.fail(
        row,
        `syntax error: unexpected end of file from \`${innermost.word}' command on line ${innermost.row + 1}`
      );
    }
    this.text.fail(row, 'syntax error: unexpected end of file');
  }
}

/** The expressions of `for ((...))`, split at the semicolons outside quotes and parentheses. */
/** How many expressions `for ((...))` holds between `start` and `end`, split at the `;` outside quotes and parentheses. */
function countExpressions(text: SourceText, start: number, end: number): number {
  let count = 1;
  let depth = 0;
  for (let i = start; i < end;) {
    const c = text.source[i];
    if (c === ';' && depth === 0) count++;
    if (c === '(') depth++;
    if (c === ')') depth--;
    i = c === '(' || c === ')' || c === ';' ? i + 1 : skipWordPiece(text, i);
  }
  return count;
}
