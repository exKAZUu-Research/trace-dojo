// code-gauge-allow-file fileNcss -- Mutual recursion across shell command, compound construct, and token-stream validation rules.
/**
 * Clean-room pre-execution Bash syntax validator from POSIX.1-2017 XCU §2.3/§2.10 and GNU Bash Reference Manual §3.2–3.4.
 * Supplements tree-sitter-bash where error recovery or token boundaries differ from Bash 5.3, while collecting backquoted
 * substitutions whose bodies Bash parses only when executed.
 */
import { parseConditional } from './conditionalSyntax';
import {
  arithmeticEnd,
  type BashSyntaxError,
  skipBalanced,
  skipBlanks,
  skipWordPiece,
  SourceText,
  SyntaxFailure,
  UnknownSyntax,
} from './syntaxWords';

export function checkBashSyntax(source: string): {
  error: BashSyntaxError | 'unknown' | undefined;
  backquotes: { start: number; end: number }[];
  literalSingleQuotes: number[];
} {
  const text = new SourceText(source);
  text.parseSubstitution = (start) => new ShellGrammarValidator(text, start, true).validateSubstitution();
  return {
    error: detectSyntaxError(text),
    backquotes: text.backquotes,
    literalSingleQuotes: text.literalSingleQuotes,
  };
}

function detectSyntaxError(text: SourceText): BashSyntaxError | 'unknown' | undefined {
  try {
    new ShellGrammarValidator(text, 0, false).validateScript();
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxFailure) return { row: error.row, text: error.text, near: error.near };
    if (error instanceof UnknownSyntax || error instanceof RangeError) return 'unknown';
    throw error;
  }
}

type ShellTokenKind = 'word' | 'ioNumber' | 'operator' | 'newline' | 'eof';

interface ShellToken {
  kind: ShellTokenKind;
  value: string;
  row: number;
  start: number;
  end: number;
  quoted: boolean;
}

const SHELL_OPERATORS = [
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
const REDIRECTION_OPERATORS = new Set(['<', '>', '>>', '<>', '>|', '&>', '&>>', '<&', '>&', '<<<', '<<', '<<-']);
const WORD_BREAK_CHARS = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const DECLARATION_NAMES = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);
const COMPOUND_LHS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/;

class ShellTokenStream {
  private pendingHeredocSpec: { stripLeadingTabs: boolean } | undefined;
  private readonly queuedHeredocs: { endMarker: string; stripLeadingTabs: boolean }[] = [];

  constructor(
    private readonly text: SourceText,
    public position: number
  ) {}

  readNext(allowCompoundArray: boolean): ShellToken {
    const { source } = this.text;
    this.position = skipBlanks(source, this.position);
    const start = this.position;
    const row = this.text.rowAt(start);
    if (start >= source.length) return this.makeToken('eof', '', row, start, false);
    const ch = source[start];
    if (ch === '\n') {
      this.position++;
      this.consumeQueuedHeredocs();
      return this.makeToken('newline', '\n', row, start, false);
    }
    if ((ch === '<' || ch === '>') && source[start + 1] === '(') return this.scanWord(allowCompoundArray);
    const op = SHELL_OPERATORS.find((candidate) => source.startsWith(candidate, start));
    if (op) {
      if (op === '<<' || op === '<<-') this.pendingHeredocSpec = { stripLeadingTabs: op === '<<-' };
      this.position += op.length;
      return this.makeToken('operator', op, row, start, false);
    }
    const word = this.scanWord(allowCompoundArray);
    if (this.pendingHeredocSpec) {
      this.queuedHeredocs.push({
        endMarker: word.value.replaceAll(/\\(.)|["']/g, '$1'),
        stripLeadingTabs: this.pendingHeredocSpec.stripLeadingTabs,
      });
      this.pendingHeredocSpec = undefined;
    }
    return word;
  }

  private consumeQueuedHeredocs(): void {
    for (const { endMarker, stripLeadingTabs } of this.queuedHeredocs.splice(0)) {
      let line: string | undefined;
      do line = this.consumeRawLine();
      while (line !== undefined && (stripLeadingTabs ? line.replace(/^\t+/, '') : line) !== endMarker);
    }
  }

  private consumeRawLine(): string | undefined {
    const { source } = this.text;
    if (this.position >= source.length) return undefined;
    const nl = source.indexOf('\n', this.position);
    const end = nl === -1 ? source.length : nl;
    const content = source.slice(this.position, end);
    this.position = nl === -1 ? end : end + 1;
    return content;
  }

  // code-gauge-allow functionCognitiveComplexity -- Scans shell words including process substitutions, compound array literals, line continuations, and quoting.
  private scanWord(allowCompoundArray: boolean): ShellToken {
    const { source } = this.text;
    const start = this.position;
    let quoted = false;
    while (this.position < source.length) {
      const ch = source[this.position];
      if ((ch === '<' || ch === '>') && source[this.position + 1] === '(') {
        this.position = this.text.parseSubstitution(this.position + 2);
        continue;
      }
      if (ch === '(' && allowCompoundArray && COMPOUND_LHS_PATTERN.test(source.slice(start, this.position))) {
        this.position = this.scanCompoundArrayBody(this.position);
        continue;
      }
      if (WORD_BREAK_CHARS.has(ch)) break;
      if (ch === '\\' && source[this.position + 1] === '\n') {
        this.position += 2;
        continue;
      }
      if (`'"\\\`$`.includes(ch)) quoted ||= ch !== '$';
      this.position = skipWordPiece(this.text, this.position);
    }
    const value = source.slice(start, this.position);
    const nextChar = source[this.position];
    const kind: ShellTokenKind = /^\d+$/.test(value) && (nextChar === '<' || nextChar === '>') ? 'ioNumber' : 'word';
    return this.makeToken(kind, value, this.text.rowAt(start), start, quoted);
  }

  private scanCompoundArrayBody(openIndex: number): number {
    const { source } = this.text;
    this.position = openIndex + 1;
    for (;;) {
      this.position = skipBlanks(source, this.position);
      if (source[this.position] === '[') {
        this.consumeBracketedCompoundElement();
        continue;
      }
      const inner = this.readNext(false);
      if (inner.kind === 'eof') this.text.unclosed(openIndex, ')');
      if (inner.kind === 'operator' && inner.value === ')') return this.position;
      if (inner.kind === 'operator') {
        const shown = inner.value === '((' ? '(' : inner.value;
        this.text.fail(inner.row, `syntax error near unexpected token \`${shown}'`);
      }
    }
  }

  private consumeBracketedCompoundElement(): void {
    const { source } = this.text;
    const closeEnd = skipBalanced(this.text, this.position, '[', ']');
    if (source.startsWith('+=', closeEnd)) this.position = closeEnd + 2;
    else if (source.startsWith('=', closeEnd)) this.position = closeEnd + 1;
    else this.position = closeEnd;
    if (this.position < source.length && !WORD_BREAK_CHARS.has(source[this.position])) {
      this.scanWord(false);
    }
  }

  private makeToken(kind: ShellTokenKind, value: string, row: number, start: number, quoted: boolean): ShellToken {
    return { kind, value, row, start, end: this.position, quoted };
  }
}

const KEYWORDS = new Set([
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

const CONTINUATION_OR_CLOSING_KEYWORDS = new Set(['then', 'else', 'elif', 'fi', 'esac', 'do', 'done', 'in', '}']);
const CASE_CLAUSE_TERMINATORS = new Set([';;', ';&', ';;&']);

class ShellGrammarValidator {
  private readonly stream: ShellTokenStream;
  private cached: ShellToken | undefined;
  private cachedAllowsCompound = false;
  private readonly activeBlocks: { keyword: string; row: number }[] = [];

  constructor(
    private readonly text: SourceText,
    start: number,
    private readonly insideSubstitution: boolean
  ) {
    this.stream = new ShellTokenStream(text, start);
  }

  validateScript(): void {
    for (;;) {
      this.consumeNewlines();
      if (this.peek().kind === 'eof') return;
      this.parseList(false);
      const end = this.peek();
      if (end.kind !== 'newline' && end.kind !== 'eof') this.failUnexpected(end);
    }
  }

  validateSubstitution(): number {
    for (;;) {
      this.consumeNewlines();
      if (this.hasOperator(this.peek(), ')')) return this.advance().end;
      this.parseList(false);
    }
  }

  private parseCompoundList(): void {
    this.parseList(true);
  }

  private parseList(multiline: boolean): void {
    if (multiline) this.consumeNewlines();
    this.parsePipeline();
    for (;;) {
      const next = this.peek();
      if (this.hasOperator(next, '&&') || this.hasOperator(next, '||')) {
        this.advance();
        this.consumeNewlines();
        this.parsePipeline();
        continue;
      }
      const isSeparator =
        this.hasOperator(next, ';') || this.hasOperator(next, '&') || (multiline && next.kind === 'newline');
      if (!isSeparator) return;
      this.advance();
      if (multiline) this.consumeNewlines();
      if (!this.canBeginCommand(this.peek())) return;
      this.parsePipeline();
    }
  }

  private parsePipeline(): void {
    const first = this.peek();
    if (this.hasKeyword(first, '!')) {
      this.advance();
      this.text.nested(() => this.parsePipeline());
      return;
    }
    if (this.hasKeyword(first, 'time')) {
      this.advance();
      if (this.peek().kind === 'word' && this.peek().value === '-p') this.advance();
      const after = this.peek();
      const emptyTimed =
        after.kind === 'newline' ||
        after.kind === 'eof' ||
        this.hasOperator(after, ';') ||
        this.hasOperator(after, '&');
      if (!emptyTimed) this.parsePipeline();
      return;
    }
    this.parseCommand();
    while (this.hasOperator(this.peek(), '|') || this.hasOperator(this.peek(), '|&')) {
      this.advance();
      this.consumeNewlines();
      this.parseCommand();
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Dispatches function definitions, coprocesses, compound constructs, and simple commands.
  private parseCommand(): void {
    this.text.nested(() => {
      const lead = this.peek();
      if (lead.kind === 'word' && this.isKeywordToken(lead)) {
        if (CONTINUATION_OR_CLOSING_KEYWORDS.has(lead.value)) this.failUnexpected(lead);
        if (lead.value === 'function') {
          this.parseFunctionKeywordForm();
          return;
        }
        if (lead.value === 'coproc') {
          this.advance();
          this.parseCommand();
          return;
        }
        this.parseCompoundWithRedirections();
        return;
      }
      if (this.hasOperator(lead, '(') || this.hasOperator(lead, '((')) {
        this.parseCompoundWithRedirections();
        return;
      }
      if (lead.kind === 'word' || lead.kind === 'ioNumber' || this.isRedirectionOperator(lead)) {
        this.parseSimpleOrFunctionDef();
        return;
      }
      this.failUnexpected(lead);
    });
  }

  private parseCompoundWithRedirections(): void {
    const requiresSeparator = this.parseCompoundConstruct();
    this.parseTrailingRedirections();
    if (requiresSeparator && this.peek().kind === 'word') this.failUnexpected(this.peek());
  }

  // code-gauge-allow functionNcss -- Dispatches each compound shell construct in the grammar.
  private parseCompoundConstruct(): boolean {
    if (this.hasOperator(this.peek(), '((') && this.tryParseArithmeticConstruct()) return true;
    const lead = this.peek();
    if (this.hasOperator(lead, '(')) {
      this.parseDelimitedCompound(lead, ')');
      return false;
    }
    if (lead.kind !== 'word' || !this.isKeywordToken(lead)) this.failUnexpected(lead);
    switch (lead.value) {
      case 'if': {
        this.parseIfConstruct(lead);
        return false;
      }
      case 'while':
      case 'until': {
        this.parseLoopConstruct(lead);
        return false;
      }
      case 'for':
      case 'select': {
        this.parseForOrSelectConstruct(lead);
        return false;
      }
      case 'case': {
        this.parseCaseConstruct(lead);
        return false;
      }
      case '{': {
        this.parseDelimitedCompound(lead, '}');
        return false;
      }
      case '[[': {
        this.parseConditionalConstruct(lead);
        return true;
      }
      default: {
        this.failUnexpected(lead);
      }
    }
  }

  private tryParseArithmeticConstruct(): boolean {
    const open = this.peek();
    const closeEnd = arithmeticEnd(this.text, open.start);
    if (closeEnd !== undefined) {
      this.seekTo(closeEnd);
      return true;
    }
    this.seekTo(open.start + 1);
    this.cached = { ...open, value: '(', end: open.start + 1 };
    return false;
  }

  private parseLoopConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      this.advance();
      this.parseCompoundList();
      this.requireKeyword('do');
      this.parseCompoundList();
      this.requireKeyword('done');
    });
  }

  private parseIfConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      this.advance();
      this.parseCompoundList();
      this.requireKeyword('then');
      this.parseCompoundList();
      while (this.hasKeyword(this.peek(), 'elif')) {
        this.advance();
        this.parseCompoundList();
        this.requireKeyword('then');
        this.parseCompoundList();
      }
      if (this.hasKeyword(this.peek(), 'else')) {
        this.advance();
        this.parseCompoundList();
      }
      this.requireKeyword('fi');
    });
  }

  private parseForOrSelectConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      this.advance();
      const target = this.peek();
      if (this.hasOperator(target, '((') && open.value === 'for') this.parseCStyleForHeader(open, target);
      else this.parseWordListForHeader(target);
      this.parseLoopBodyGroup();
    });
  }

  private parseWordListForHeader(variable: ShellToken): void {
    if (variable.kind !== 'word') this.failUnexpected(variable);
    this.advance();
    this.consumeNewlines();
    const afterName = this.peek();
    if (afterName.kind === 'word' && afterName.value === 'in' && !afterName.quoted) {
      this.advance();
      while (this.peek().kind === 'word' || this.peek().kind === 'ioNumber') this.advance();
      const term = this.peek();
      if (!this.hasOperator(term, ';') && term.kind !== 'newline') this.failUnexpected(term);
    } else if (!this.hasOperator(afterName, ';')) {
      return;
    }
    this.advance();
    this.consumeNewlines();
  }

  private parseCStyleForHeader(forKeyword: ShellToken, openParens: ShellToken): void {
    const closeEnd = arithmeticEnd(this.text, openParens.start);
    if (closeEnd === undefined) this.failUnexpected({ ...openParens, value: '(' });
    const sections = countHeaderSections(this.text, openParens.start + 2, closeEnd - 2);
    if (sections < 3) this.text.fail(forKeyword.row, 'syntax error: arithmetic expression required');
    if (sections > 3) this.text.fail(forKeyword.row, "syntax error: `;' unexpected");
    this.seekTo(closeEnd);
    if (this.hasOperator(this.peek(), ';')) this.advance();
    this.consumeNewlines();
  }

  private parseLoopBodyGroup(): void {
    const open = this.peek();
    if (this.hasKeyword(open, '{')) {
      this.parseDelimitedCompound(open, '}');
      return;
    }
    this.requireKeyword('do');
    this.parseCompoundList();
    this.requireKeyword('done');
  }

  private parseCaseConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      this.advance();
      const subject = this.peek();
      if (subject.kind !== 'word' && subject.kind !== 'ioNumber') this.failUnexpected(subject);
      this.advance();
      this.consumeNewlines();
      const inKeyword = this.peek();
      if (inKeyword.kind !== 'word' || inKeyword.value !== 'in' || inKeyword.quoted) this.failUnexpected(inKeyword);
      this.advance();
      for (;;) {
        this.consumeNewlines();
        if (this.hasKeyword(this.peek(), 'esac')) {
          this.advance();
          return;
        }
        this.parseCaseBranch();
      }
    });
  }

  private parseCaseBranch(): void {
    if (this.hasOperator(this.peek(), '(')) this.advance();
    this.parseCasePattern();
    while (this.hasOperator(this.peek(), '|')) {
      this.advance();
      this.parseCasePattern();
    }
    if (!this.hasOperator(this.peek(), ')')) this.failUnexpected(this.peek());
    this.advance();
    this.consumeNewlines();
    if (!this.isCaseTerminator(this.peek()) && !this.hasKeyword(this.peek(), 'esac')) {
      this.parseCompoundList();
      const afterBody = this.peek();
      if (!this.isCaseTerminator(afterBody) && !this.hasKeyword(afterBody, 'esac')) this.failUnexpected(afterBody);
    }
    if (this.isCaseTerminator(this.peek())) this.advance();
  }

  private isCaseTerminator(token: ShellToken): boolean {
    return token.kind === 'operator' && CASE_CLAUSE_TERMINATORS.has(token.value);
  }

  private parseCasePattern(): void {
    const pat = this.peek();
    if (pat.kind !== 'word' && pat.kind !== 'ioNumber') this.failUnexpected(pat);
    this.advance();
  }

  private parseDelimitedCompound(open: ShellToken, closeSymbol: string): void {
    this.withBlock(open, () => {
      this.advance();
      this.parseCompoundList();
      const end = this.peek();
      const matched = closeSymbol === ')' ? this.hasOperator(end, ')') : this.hasKeyword(end, closeSymbol);
      if (!matched) this.failUnexpected(end);
      this.advance();
    });
  }

  private parseConditionalConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      const outcome = parseConditional(this.text, open.end);
      if ('error' in outcome) throw new SyntaxFailure(outcome.error.row, outcome.error.text, outcome.error.near);
      this.seekTo(outcome.end);
    });
  }

  private parseFunctionKeywordForm(): void {
    this.advance();
    const fnName = this.peek();
    if (fnName.kind !== 'word') this.failUnexpected(fnName);
    this.advance();
    if (this.hasOperator(this.peek(), '(')) {
      this.advance();
      if (!this.hasOperator(this.peek(), ')')) this.failUnexpected(this.peek());
      this.advance();
    }
    this.parseFunctionBody();
  }

  private parseFunctionBody(): void {
    this.consumeNewlines();
    const bodyLead = this.peek();
    const validCompound =
      this.hasOperator(bodyLead, '(') ||
      this.hasOperator(bodyLead, '((') ||
      (bodyLead.kind === 'word' &&
        this.isKeywordToken(bodyLead) &&
        !CONTINUATION_OR_CLOSING_KEYWORDS.has(bodyLead.value) &&
        bodyLead.value !== '!');
    if (!validCompound || bodyLead.value === 'function' || bodyLead.value === 'time' || bodyLead.value === 'coproc') {
      this.failUnexpected(bodyLead);
    }
    this.parseCompoundWithRedirections();
  }

  // code-gauge-allow functionCognitiveComplexity -- Parses simple commands (redirections, prefix assignments, arguments) and `name () body` functions.
  private parseSimpleOrFunctionDef(): void {
    let commandName: string | undefined;
    for (let position = 0; ; position++) {
      const token = this.peek(commandName === undefined || DECLARATION_NAMES.has(commandName));
      if (token.kind === 'ioNumber' || this.isRedirectionOperator(token)) {
        this.parseOneRedirection();
        continue;
      }
      if (token.kind !== 'word') return;
      this.advance();
      if (commandName === undefined && !COMPOUND_LHS_PATTERN.test(token.value.replace(/=[\s\S]*$/, '='))) {
        commandName = token.value;
      }
      if (position === 0 && this.hasOperator(this.peek(), '(')) {
        this.advance();
        if (!this.hasOperator(this.peek(), ')')) this.failUnexpected(this.peek());
        this.advance();
        this.parseFunctionBody();
        return;
      }
    }
  }

  private parseTrailingRedirections(): void {
    while (this.peek().kind === 'ioNumber' || this.isRedirectionOperator(this.peek())) {
      this.parseOneRedirection();
    }
  }

  private parseOneRedirection(): void {
    if (this.peek().kind === 'ioNumber') this.advance();
    const op = this.peek();
    if (!this.isRedirectionOperator(op)) this.failUnexpected(op);
    this.advance();
    const target = this.peek();
    if (target.kind !== 'word' && target.kind !== 'ioNumber') this.failUnexpected(target);
    this.advance();
  }

  private peek(allowCompoundArray = false): ShellToken {
    if (this.cached && this.cachedAllowsCompound !== allowCompoundArray && this.couldBeCompoundArray(this.cached)) {
      this.stream.position = this.cached.start;
      this.cached = undefined;
    }
    if (!this.cached) {
      this.cached = this.stream.readNext(allowCompoundArray);
      this.cachedAllowsCompound = allowCompoundArray;
    }
    return this.cached;
  }

  private couldBeCompoundArray(token: ShellToken): boolean {
    if (token.kind !== 'word') return false;
    const slice = this.text.source.slice(token.start, token.end + 1);
    const paren = slice.indexOf('(');
    return paren !== -1 && COMPOUND_LHS_PATTERN.test(slice.slice(0, paren));
  }

  private advance(): ShellToken {
    const token = this.cached ?? this.peek();
    this.cached = undefined;
    return token;
  }

  private seekTo(index: number): void {
    this.cached = undefined;
    this.stream.position = index;
  }

  private consumeNewlines(): void {
    while (this.peek().kind === 'newline') this.advance();
  }

  private withBlock(open: ShellToken, body: () => void): void {
    this.activeBlocks.push({ keyword: open.value, row: open.row });
    body();
    this.activeBlocks.pop();
  }

  private requireKeyword(expected: string): void {
    const next = this.peek();
    if (!this.hasKeyword(next, expected)) this.failUnexpected(next);
    this.advance();
  }

  private canBeginCommand(token: ShellToken): boolean {
    if (token.kind === 'ioNumber' || this.isRedirectionOperator(token)) return true;
    if (this.hasOperator(token, '(') || this.hasOperator(token, '((')) return true;
    return token.kind === 'word' && !(this.isKeywordToken(token) && CONTINUATION_OR_CLOSING_KEYWORDS.has(token.value));
  }

  private isKeywordToken(token: ShellToken): boolean {
    return !token.quoted && KEYWORDS.has(token.value);
  }

  private hasKeyword(token: ShellToken, expected: string): boolean {
    return token.kind === 'word' && token.value === expected && !token.quoted;
  }

  private hasOperator(token: ShellToken, expected: string): boolean {
    return token.kind === 'operator' && token.value === expected;
  }

  private isRedirectionOperator(token: ShellToken): boolean {
    return token.kind === 'operator' && REDIRECTION_OPERATORS.has(token.value);
  }

  private failUnexpected(token: ShellToken): never {
    if (token.kind === 'eof') this.failAtEof();
    const shown = token.kind === 'newline' ? 'newline' : token.value === '((' ? '(' : token.value;
    const suffix = this.insideSubstitution && !this.hasOperator(token, ')') ? " while looking for matching `)'" : '';
    this.text.fail(token.row, `syntax error near unexpected token \`${shown}'${suffix}`);
  }

  private failAtEof(): never {
    const row = this.text.eofRow;
    if (this.insideSubstitution) this.text.fail(row, "unexpected EOF while looking for matching `)'");
    const innermost = this.activeBlocks.at(-1);
    if (innermost) {
      this.text.fail(
        row,
        `syntax error: unexpected end of file from \`${innermost.keyword}' command on line ${innermost.row + 1}`
      );
    }
    this.text.fail(row, 'syntax error: unexpected end of file');
  }
}

/** Counts semicolon-delimited sections in `for ((init; condition; update))` outside quotes and nested parentheses. */
function countHeaderSections(text: SourceText, start: number, end: number): number {
  let sections = 1;
  let parenDepth = 0;
  for (let i = start; i < end;) {
    const ch = text.source[i];
    if (ch === ';' && parenDepth === 0) sections++;
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    i = ch === '(' || ch === ')' || ch === ';' ? i + 1 : skipWordPiece(text, i);
  }
  return sections;
}
