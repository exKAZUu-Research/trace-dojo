import { compileError, unsupportedError } from './errors';
import { chargeTypeWork } from './typeWorkBudget';

/**
 * The C preprocessor GHC runs on a program with the CPP extension, in its traditional mode: directives (`#define`,
 * `#if`, `#ifdef`, and so on) and the expansion of macros in the code outside strings and comments. Each directive
 * and each line an `#if` leaves out becomes an empty line, so that lines keep their numbers.
 */
export function preprocess(source: string): string {
  return new Preprocessor().run(source);
}

interface Macro {
  params?: string[];
  body: Token[];
}

interface Token {
  kind: 'name' | 'space' | 'newline' | 'comment' | 'other';
  text: string;
  row: number;
  /** Whether the name was met inside the expansion of its own macro, after which C never expands it ("blue paint"). */
  painted?: boolean;
}

/** The versions `MIN_VERSION_...` compares with: those GHC 9.14.1 comes with. */
const PACKAGE_VERSIONS: Record<string, number[]> = {
  base: [4, 22, 0, 0],
  containers: [0, 8, 0, 0],
  GLASGOW_HASKELL: [9, 14, 1, 0],
};

/** Macros that tell the operating system or the CPU, which this environment does not let a program depend on. */
const PLATFORM_MACRO = /^\w+_(HOST|BUILD|TARGET)_(OS|ARCH)$/;

const DIRECTIVE = /^\s*#\s*([A-Za-z]+)?(.*)$/;

const UNCLOSED_CALL = 'マクロの呼び出しの ) がありません。';

interface Conditional {
  /** Whether the lines of the current branch are kept. */
  active: boolean;
  /** Whether a branch of this `#if` has been taken. */
  taken: boolean;
  /** Whether the `#if` is inside a branch that is left out. */
  outerActive: boolean;
  seenElse: boolean;
  row: number;
}

class Preprocessor {
  readonly macros = new Map<string, Macro>([
    ['__GLASGOW_HASKELL__', { body: tokenize('914', 0) }],
    ['__GLASGOW_HASKELL_FULL_VERSION__', { body: tokenize('"9.14.1"', 0) }],
    ['__GLASGOW_HASKELL_PATCHLEVEL1__', { body: tokenize('1', 0) }],
    ['__FILE__', { body: tokenize('"Main.hs"', 0) }],
  ]);

  /** The row that `__LINE__` and errors refer to. */
  row = 0;

  run(source: string): string {
    const lexer = new Lexer(source, true, 0);
    const stack: Conditional[] = [];
    let output = '';
    while (!lexer.done) {
      this.row = lexer.row;
      const directive = DIRECTIVE.exec(lexer.peekLine());
      if (directive) {
        const { rest, newlines } = lexer.skipDirective(directive[2]);
        this.directive(
          directive[1] ?? '',
          rest.trim(),
          stack,
          stack.every((item) => item.active)
        );
        output += '\n'.repeat(newlines);
      } else if (stack.every((item) => item.active)) {
        // A macro call's arguments continue onto the code lines after it until its `)`.
        output += new Expansion(this, lexer.line(), false, () => lexer.codeLine()).run();
      } else if (lexer.skipLine()) {
        output += '\n';
      }
    }
    const open = stack.at(-1);
    if (open) throw this.error(open.row, '#if に対応する #endif がありません。');
    return output;
  }

  private directive(name: string, rest: string, stack: Conditional[], active: boolean): void {
    switch (name) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        const value =
          active && (name === 'if' ? this.evaluate(rest) : this.isDefined(this.macroName(rest)) === (name === 'ifdef'));
        stack.push({ active: value, taken: value, outerActive: active, seenElse: false, row: this.row });
        return;
      }
      case 'elif': {
        const top = this.top(stack, '#elif');
        if (top.seenElse) throw this.error(this.row, '#else の後に #elif は書けません。');
        const value = top.outerActive && !top.taken && this.evaluate(rest);
        top.active = value;
        top.taken ||= value;
        return;
      }
      case 'else': {
        const top = this.top(stack, '#else');
        if (top.seenElse) throw this.error(this.row, '#else が重複しています。');
        top.seenElse = true;
        top.active = top.outerActive && !top.taken;
        top.taken = true;
        return;
      }
      case 'endif': {
        this.top(stack, '#endif');
        stack.pop();
        return;
      }
      default: {
        if (active) this.activeDirective(name, rest);
      }
    }
  }

  private activeDirective(name: string, rest: string): void {
    switch (name) {
      case 'define': {
        const match = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
        if (!match) throw this.error(this.row, '#define の書き方に誤りがあります。');
        this.checkPlatform(match[1]);
        const params = match[2] === undefined ? undefined : match[3].split(',').map((param) => param.trim());
        const body = tokenize(match[4], this.row);
        this.macros.set(match[1], { ...(params ? { params: params.filter(Boolean) } : {}), body });
        return;
      }
      case 'undef': {
        this.macros.delete(this.macroName(rest));
        return;
      }
      case 'error': {
        throw this.error(this.row, `#error ${rest}`);
      }
      case 'include': {
        throw unsupportedError(this.row, 'C プリプロセッサでのファイルの取り込み（#include）');
      }
      case 'warning':
      case 'line':
      case 'pragma':
      case 'ident':
      case '': {
        return;
      }
      default: {
        throw this.error(this.row, `C プリプロセッサの指令 #${name} はありません。`);
      }
    }
  }

  private top(stack: Conditional[], what: string): Conditional {
    const top = stack.at(-1);
    if (!top) throw this.error(this.row, `${what} に対応する #if がありません。`);
    return top;
  }

  private macroName(rest: string): string {
    const name = /^[A-Za-z_]\w*/.exec(rest)?.[0];
    if (!name) throw this.error(this.row, 'マクロの名前を書いてください。');
    this.checkPlatform(name);
    return name;
  }

  private isDefined(name: string): boolean {
    return this.macros.has(name) || name === '__LINE__';
  }

  checkPlatform(name: string): void {
    if (PLATFORM_MACRO.test(name)) {
      throw unsupportedError(this.row, `OS や CPU の種類による切り替え（${name}）`);
    }
  }

  /** Whether an `#if` condition holds: `defined`, integers, macros, and C's operators. */
  private evaluate(expression: string): boolean {
    const withDefined = expression.replaceAll(
      /\bdefined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g,
      (_, inParens: string | undefined, bare: string | undefined) => {
        const name = (inParens ?? bare) as string;
        this.checkPlatform(name);
        return this.isDefined(name) ? '1' : '0';
      }
    );
    const expanded = new Expansion(this, tokenize(withDefined, this.row), true).run();
    const error = (message: string): Error => this.error(this.row, message);
    return evaluateCondition(new ConditionParser(expanded, error).parse(), error).value !== 0n;
  }

  error(row: number, message: string): Error {
    return compileError(row, message);
  }
}

/** A run of tokens being read: the input, a macro's replacement, an argument being expanded, or tokens put back. */
interface Frame {
  tokens: Token[];
  position: number;
  /** The macro whose replacement the frame holds, which is not expanded while the frame is open. */
  macro?: string;
  /** Whether the frame holds an argument expanded on its own, whose end ends the expansion of the argument. */
  argument?: boolean;
}

/** Where expanded tokens go; in a condition, a name that is no macro becomes `0`. */
interface Sink {
  tokens: Token[];
  condition: boolean;
}

/** A call of a function-like macro, or of `MIN_VERSION_...`, whose arguments are being expanded. */
interface Call {
  name: string;
  macro?: Macro;
  version?: string;
  args: Token[][];
  expanded: Token[][];
}

/**
 * The expansion of macros in a run of tokens, by C's rules: a function-like macro's arguments are expanded each on
 * its own first, and the replacement is then read again, with the tokens after it, while the macro is disabled. The
 * frames being read form an explicit stack rather than nested calls, so a replacement ending in a function-like
 * macro's name takes the arguments that follow it, and the input may supply further lines to an unclosed call.
 */
class Expansion {
  private readonly frames: Frame[];
  private readonly sinks: Sink[];
  private readonly calls: Call[] = [];
  /** The macros of the open frames. */
  private readonly disabled = new Set<string>();
  /** The newlines inside calls, which follow the line the calls end in so that later rows keep their numbers. */
  private skippedRows = 0;

  constructor(
    private readonly preprocessor: Preprocessor,
    tokens: Token[],
    condition: boolean,
    private readonly continuation?: () => Token[] | undefined
  ) {
    this.frames = [{ tokens, position: 0 }];
    this.sinks = [{ tokens: [], condition }];
  }

  run(): string {
    for (;;) {
      const frame = this.frames.at(-1) as Frame;
      if (frame.position < frame.tokens.length) {
        this.examine(frame.tokens[frame.position++], this.frames.length === 1);
      } else if (this.frames.length === 1) {
        return this.sinks[0].tokens.map((token) => token.text).join('') + '\n'.repeat(this.skippedRows);
      } else {
        this.close();
        if (frame.argument) this.finishArgument();
      }
    }
  }

  private get condition(): boolean {
    return (this.sinks.at(-1) as Sink).condition;
  }

  private examine(token: Token, fromInput: boolean): void {
    if (token.kind !== 'name') {
      this.emit(token);
      return;
    }
    const { preprocessor } = this;
    if (fromInput) preprocessor.row = token.row;
    const name = token.text;
    if (this.condition) preprocessor.checkPlatform(name);
    if (name === '__LINE__') {
      this.emit({ kind: 'other', text: String(preprocessor.row + 1), row: token.row });
      return;
    }
    const macro = token.painted ? undefined : preprocessor.macros.get(name);
    if (macro && this.disabled.has(name)) {
      token.painted = true;
      this.emitName(token, false);
      return;
    }
    const version = /^MIN_VERSION_(\w+)$/.exec(name)?.[1];
    if (!macro && version === undefined) {
      this.emitName(token, false);
    } else if (macro && !macro.params) {
      chargeTypeWork(1 + macro.body.length);
      this.open(
        name,
        macro.body.map((bodyToken) => ({ ...bodyToken }))
      );
    } else if (this.takeOpenParen()) {
      this.call({
        name,
        ...(version === undefined ? { macro } : { version }),
        args: this.collectArguments(),
        expanded: [],
      });
    } else {
      this.emitName(token, true);
    }
  }

  /** Emits a name that is not expanded, which a condition reads as `0` unless it may yet be a call. */
  private emitName(token: Token, functionLike: boolean): void {
    this.emit(this.condition && !functionLike ? { kind: 'other', text: '0', row: token.row } : token);
  }

  private emit(token: Token): void {
    (this.sinks.at(-1) as Sink).tokens.push(token);
  }

  private open(macro: string, tokens: Token[]): void {
    this.frames.push({ tokens, position: 0, macro });
    this.disabled.add(macro);
  }

  private close(): void {
    const { macro } = this.frames.pop() as Frame;
    if (macro !== undefined) this.disabled.delete(macro);
  }

  /**
   * The next token, past the frames that have ended; none at the end of an argument, or at the end of the input when
   * no more lines are wanted or there are none.
   */
  private read(moreLines: boolean): Token | undefined {
    for (;;) {
      const frame = this.frames.at(-1) as Frame;
      if (frame.position < frame.tokens.length) return frame.tokens[frame.position++];
      if (frame.argument) return undefined;
      if (this.frames.length > 1) {
        this.close();
      } else {
        const line = moreLines ? this.continuation?.() : undefined;
        if (!line) return undefined;
        frame.tokens = line;
        frame.position = 0;
      }
    }
  }

  /** Reads the `(` of a call after a function-like macro's name, or puts back what follows the name. */
  private takeOpenParen(): boolean {
    const skipped: Token[] = [];
    for (;;) {
      const token = this.read(false);
      if (token?.kind === 'space') {
        skipped.push(token);
        continue;
      }
      if (token?.kind === 'other' && token.text === '(') return true;
      if (token) skipped.push(token);
      if (skipped.length > 0) this.frames.push({ tokens: skipped, position: 0 });
      return false;
    }
  }

  /** The arguments of a call after its `(`, split at the commas outside parentheses and trimmed. */
  private collectArguments(): Token[][] {
    const args: Token[][] = [];
    let current: Token[] = [];
    let depth = 0;
    for (;;) {
      const token = this.readArgumentToken();
      const punctuation = token.kind === 'other' ? token.text : '';
      if (punctuation === ')' && depth-- === 0) {
        args.push(trimSpaces(current));
        return args.length === 1 && args[0].length === 0 ? [] : args;
      }
      if (punctuation === ',' && depth === 0) {
        args.push(trimSpaces(current));
        current = [];
        continue;
      }
      if (punctuation === '(') depth++;
      current.push(token);
    }
  }

  /** The next token of a call's arguments, where a newline or a comment is a space. */
  private readArgumentToken(): Token {
    const token = this.read(true);
    if (!token) throw this.preprocessor.error(this.preprocessor.row, UNCLOSED_CALL);
    if (token.kind !== 'newline' && token.kind !== 'comment') return token;
    this.skippedRows += token.text.split('\n').length - 1;
    return { kind: 'space', text: ' ', row: token.row };
  }

  private call(call: Call): void {
    const { name, macro, version, args } = call;
    if (version !== undefined && !Object.hasOwn(PACKAGE_VERSIONS, version)) {
      throw this.preprocessor.error(this.preprocessor.row, `パッケージ ${version} の版のマクロはありません。`);
    }
    const params = macro?.params ?? [];
    if (macro && params.length !== args.length) {
      throw this.preprocessor.error(
        this.preprocessor.row,
        `マクロ ${name} には、引数を ${params.length} 個書いてください。`
      );
    }
    chargeTypeWork(1 + args.reduce((total, arg) => total + arg.length, 0));
    if (args.length === 0) {
      this.finishCall(call);
    } else {
      this.calls.push(call);
      this.expandArgument(call);
    }
  }

  /** Starts expanding the next argument of a call on its own, under the macros disabled around the call. */
  private expandArgument(call: Call): void {
    // In code, GHC's `MIN_VERSION_...` is a comparison whose arguments are integers, as in a condition.
    this.sinks.push({ tokens: [], condition: call.version !== undefined || this.condition });
    this.frames.push({ tokens: call.args[call.expanded.length], position: 0, argument: true });
  }

  private finishArgument(): void {
    const call = this.calls.at(-1) as Call;
    call.expanded.push((this.sinks.pop() as Sink).tokens);
    if (call.expanded.length < call.args.length) {
      this.expandArgument(call);
    } else {
      this.calls.pop();
      this.finishCall(call);
    }
  }

  private finishCall({ name, macro, version, expanded }: Call): void {
    const { row } = this.preprocessor;
    if (version !== undefined) {
      const wanted = expanded.map((arg) =>
        Number.parseInt(
          arg
            .map((token) => token.text)
            .join('')
            .trim(),
          10
        )
      );
      const satisfied = satisfiesVersion(PACKAGE_VERSIONS[version], wanted);
      // In code, GHC's macro is a comparison, which Haskell reads as a Bool.
      this.emit({
        kind: 'other',
        text: this.condition ? String(Number(satisfied)) : satisfied ? 'True' : 'False',
        row,
      });
      return;
    }
    const { params = [], body } = macro as Macro;
    const argOf = (token: Token): Token[] | undefined =>
      token.kind === 'name' ? expanded[params.indexOf(token.text)] : undefined;
    chargeTypeWork(1 + body.reduce((total, token) => total + (argOf(token)?.length ?? 1), 0));
    this.open(
      name,
      body.flatMap((token) => (argOf(token) ?? [token]).map((replacement) => ({ ...replacement })))
    );
  }
}

function satisfiesVersion(version: number[], wanted: number[]): boolean {
  for (const [position, part] of wanted.entries()) {
    const have = version[position] ?? 0;
    if (have !== part) return have > part;
  }
  return true;
}

function trimSpaces(tokens: Token[]): Token[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start].kind === 'space') start++;
  while (end > start && tokens[end - 1].kind === 'space') end--;
  return tokens.slice(start, end);
}

/** The tokens of a macro's body or a condition, where `--` and `{-` are no comments. */
function tokenize(text: string, row: number): Token[] {
  const lexer = new Lexer(text, false, row);
  const tokens: Token[] = [];
  while (!lexer.done) tokens.push(...lexer.line());
  return tokens;
}

const LINE_COMMENT = /--+(?![!#$%&*+./<=>?@\\^|~:])/y;
/** A character literal, unless its `'` ends a name such as `x'`, which the caller checks. */
const CHARACTER = /'(?:\\.[^'\n]*|[^\\'\n])'/y;
/** A name, a number or a `'` with the name characters after it, or spaces. */
const WORD = /[A-Za-z_][\w']*|[\d'][\w']*|[^\S\n]+/y;

/** Reads the tokens of a text line by line; in code, Haskell's comments are tokens copied as they are. */
class Lexer {
  position = 0;

  constructor(
    private readonly text: string,
    private readonly comments: boolean,
    public row: number
  ) {}

  get done(): boolean {
    return this.position >= this.text.length;
  }

  /** Skips a directive's lines, which a backslash continues, with its text after the name and the newlines skipped. */
  skipDirective(firstRest: string): { rest: string; newlines: number } {
    let rest = firstRest;
    let more = this.skipLine();
    let newlines = Number(more);
    while (rest.endsWith('\\') && more) {
      rest = rest.slice(0, -1) + this.peekLine();
      more = this.skipLine();
      newlines += Number(more);
    }
    return { rest, newlines };
  }

  /** The tokens of the line ahead unless it is a directive or there is none. */
  codeLine(): Token[] | undefined {
    return this.done || /^\s*#/.test(this.peekLine()) ? undefined : this.line();
  }

  /** The line ahead, without its newline. */
  peekLine(): string {
    const end = this.text.indexOf('\n', this.position);
    return this.text.slice(this.position, end === -1 ? undefined : end);
  }

  /** Skips the line ahead, telling whether a newline ended it. */
  skipLine(): boolean {
    const end = this.text.indexOf('\n', this.position);
    this.position = end === -1 ? this.text.length : end + 1;
    if (end === -1) return false;
    this.row++;
    return true;
  }

  /** The tokens of the line ahead through its newline, past the newlines of a block comment. */
  line(): Token[] {
    const tokens: Token[] = [];
    while (!this.done) {
      const start = this.position;
      const kind = this.scan();
      const token: Token = { kind, text: this.text.slice(start, this.position), row: this.row };
      tokens.push(token);
      if (kind === 'newline') {
        this.row++;
        break;
      }
      if (kind === 'comment') this.row += token.text.split('\n').length - 1;
    }
    return tokens;
  }

  private scan(): Token['kind'] {
    const { text, position } = this;
    if (this.comments && text.startsWith('{-', position)) {
      this.position = blockCommentEnd(text, position);
      return 'comment';
    }
    if (this.comments && matchEnd(LINE_COMMENT, text, position) !== undefined) {
      const end = text.indexOf('\n', position);
      this.position = end === -1 ? text.length : end;
      return 'comment';
    }
    if (text[position] === '"') {
      this.position = stringEnd(text, position);
      return 'other';
    }
    const character = /[\w']/.test(text[position - 1] ?? '') ? undefined : matchEnd(CHARACTER, text, position);
    const end = character ?? matchEnd(WORD, text, position);
    if (end === undefined) {
      this.position = position + 1;
      return text[position] === '\n' ? 'newline' : 'other';
    }
    this.position = end;
    if (character !== undefined) return 'other';
    return /[A-Za-z_]/.test(text[position]) ? 'name' : /\s/.test(text[position]) ? 'space' : 'other';
  }
}

function matchEnd(pattern: RegExp, text: string, position: number): number | undefined {
  pattern.lastIndex = position;
  return pattern.test(text) ? pattern.lastIndex : undefined;
}

/** Where a block comment starting at a position ends, after the `-}` matching its `{-` among nested ones. */
function blockCommentEnd(text: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < text.length && depth > 0) {
    if (text.startsWith('{-', index)) {
      depth++;
      index += 2;
    } else if (text.startsWith('-}', index)) {
      depth--;
      index += 2;
    } else index++;
  }
  return index;
}

/** Where a string literal starting at a position ends: after its closing `"`, or at the end of its line. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"' && text[index] !== '\n') {
    index += text[index] === '\\' && text[index + 1] !== '\n' ? 2 : 1;
  }
  return text[index] === '"' ? index + 1 : Math.min(index, text.length);
}

/**
 * An integer of the preprocessor's arithmetic, which C does in its widest types: a 64-bit `value`, signed (two's
 * complement) unless `unsigned`.
 */
interface CInteger {
  value: bigint;
  unsigned: boolean;
}

/** The expression of an `#if`, parsed in full before any of it is evaluated. */
type Condition =
  | { k: 'integer'; integer: CInteger }
  | { k: 'unary'; op: string; operand: Condition }
  | { k: 'binary'; op: string; left: Condition; right: Condition }
  | { k: 'conditional'; test: Condition; ifTrue: Condition; ifFalse: Condition };

/**
 * The integer constants of C, which both read tokens and give their values: a prefix with the digits it takes, and
 * the suffixes C allows (`u` and `l` or `ll`, in either order, in one case each).
 */
const INTEGER_CONSTANT = {
  prefixes: [
    { pattern: /^0[xX]([\da-fA-F]+)$/, radix: 16 },
    { pattern: /^0[bB]([01]+)$/, radix: 2 },
    { pattern: /^(0[0-7]*)$/, radix: 8 },
    { pattern: /^([1-9]\d*)$/, radix: 10 },
  ],
  suffixes: ['', 'u', 'l', 'll', 'ul', 'lu', 'ull', 'llu'].flatMap((suffix) => [
    ...new Set([suffix, suffix.toUpperCase(), suffix.replace('u', 'U'), suffix.replace(/l+/, (l) => l.toUpperCase())]),
  ]),
};

const INT64_MAX = (1n << 63n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

/** The tokens of an `#if` expression: C's numbers (which a word character continues), characters, and operators. */
const CONDITION_TOKEN = /\d[\w.]*|'(?:\\.[^']*|[^\\'])'|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%()<>!~&|^?:]|\S/g;

const BINARY_LEVELS: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

/**
 * Parses the integer expression of an `#if`, after its macros are expanded, into a tree: the whole expression, so
 * that a syntax error is reported even in an operand that evaluation skips.
 */
class ConditionParser {
  private readonly tokens: string[];
  private position = 0;

  constructor(
    text: string,
    private readonly error: (message: string) => Error
  ) {
    this.tokens = text.match(CONDITION_TOKEN) ?? [];
  }

  parse(): Condition {
    const condition = this.ternary();
    if (this.position < this.tokens.length) throw this.error(`#if の式 ${this.tokens.join(' ')} に誤りがあります。`);
    return condition;
  }

  private ternary(): Condition {
    const test = this.binary(0);
    if (this.tokens[this.position] !== '?') return test;
    this.position++;
    const ifTrue = this.ternary();
    this.expect(':');
    const ifFalse = this.ternary();
    return { k: 'conditional', test, ifTrue, ifFalse };
  }

  private binary(level: number): Condition {
    if (level >= BINARY_LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    while (BINARY_LEVELS[level].includes(this.tokens[this.position])) {
      const op = this.tokens[this.position++];
      left = { k: 'binary', op, left, right: this.binary(level + 1) };
    }
    return left;
  }

  private unary(): Condition {
    const token = this.tokens[this.position++];
    switch (token) {
      case '!':
      case '-':
      case '+':
      case '~': {
        return { k: 'unary', op: token, operand: this.unary() };
      }
      case '(': {
        const inner = this.ternary();
        this.expect(')');
        return inner;
      }
      default: {
        if (token === undefined) throw this.error('#if の式に誤りがあります（式の終わり）。');
        if (token.startsWith("'")) return { k: 'integer', integer: { value: characterValue(token), unsigned: false } };
        if (/^\d/.test(token)) return { k: 'integer', integer: this.integerConstant(token) };
        throw this.error(`#if の式に誤りがあります（${token}）。`);
      }
    }
  }

  /** The value of an integer constant, which is unsigned when its suffix says so or only an unsigned type holds it. */
  private integerConstant(token: string): CInteger {
    if (token.includes('.') || /^\d+[eE]/.test(token)) throw this.error('#if の式に小数は書けません。');
    for (const { pattern, radix } of INTEGER_CONSTANT.prefixes) {
      for (const suffix of INTEGER_CONSTANT.suffixes) {
        if (suffix !== '' && !token.endsWith(suffix)) continue;
        const digits = pattern.exec(token.slice(0, token.length - suffix.length))?.[1];
        if (digits === undefined) continue;
        const value = digits
          .split('')
          .reduce((total, digit) => total * BigInt(radix) + BigInt(Number.parseInt(digit, 16)), 0n);
        if (value > UINT64_MAX) throw this.error(`#if の整数 ${token} は大きすぎます。`);
        return { value, unsigned: /u/i.test(suffix) || value > INT64_MAX };
      }
    }
    throw this.error(`#if の整数 ${token} の書き方に誤りがあります。`);
  }

  private expect(token: string): void {
    if (this.tokens[this.position] !== token) throw this.error(`#if の式に ${token} がありません。`);
    this.position++;
  }
}

/** The value of a character constant such as `'a'` or `'\n'`, which is an `int`. */
function characterValue(token: string): bigint {
  const body = token.slice(1, -1);
  if (!body.startsWith('\\')) return BigInt(body.codePointAt(0) ?? 0);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, a: 7, b: 8, f: 12, v: 11 };
  const escaped = body.slice(1);
  if (/^x[\da-fA-F]+$/.test(escaped)) return BigInt(Number.parseInt(escaped.slice(1), 16));
  if (/^[0-7]{1,3}$/.test(escaped)) return BigInt(Number.parseInt(escaped, 8));
  return BigInt(escapes[escaped] ?? escaped.codePointAt(0) ?? 0);
}

/** A value of C's arithmetic, wrapped to 64 bits as its type is signed or not. */
function cInteger(value: bigint, unsigned: boolean): CInteger {
  return { value: unsigned ? BigInt.asUintN(64, value) : BigInt.asIntN(64, value), unsigned };
}

const truth = (value: boolean): CInteger => ({ value: value ? 1n : 0n, unsigned: false });

/**
 * Evaluates a parsed `#if` expression with C's rules: `&&`, `||`, and `?:` evaluate only the operands they select;
 * an operand with an unsigned type makes the other unsigned too.
 */
function evaluateCondition(condition: Condition, error: (message: string) => Error): CInteger {
  const evaluate = (node: Condition): CInteger => evaluateCondition(node, error);
  switch (condition.k) {
    case 'integer': {
      return condition.integer;
    }
    case 'unary': {
      const { value, unsigned } = evaluate(condition.operand);
      if (condition.op === '!') return truth(value === 0n);
      if (condition.op === '-') return cInteger(-value, unsigned);
      if (condition.op === '~') return cInteger(~value, unsigned);
      return { value, unsigned };
    }
    case 'conditional': {
      const test = evaluate(condition.test).value !== 0n;
      // The result has the type both branches convert to, though only the chosen branch is evaluated.
      const unsigned = isUnsigned(condition.ifTrue) || isUnsigned(condition.ifFalse);
      const chosen = evaluate(test ? condition.ifTrue : condition.ifFalse);
      return cInteger(chosen.value, unsigned);
    }
    case 'binary': {
      const { op } = condition;
      if (op === '&&') return truth(evaluate(condition.left).value !== 0n && evaluate(condition.right).value !== 0n);
      if (op === '||') return truth(evaluate(condition.left).value !== 0n || evaluate(condition.right).value !== 0n);
      return applyOperator(op, evaluate(condition.left), evaluate(condition.right), error);
    }
  }
}

/** Whether an expression has an unsigned type, which C decides without evaluating it. */
function isUnsigned(condition: Condition): boolean {
  switch (condition.k) {
    case 'integer': {
      return condition.integer.unsigned;
    }
    case 'unary': {
      return condition.op !== '!' && isUnsigned(condition.operand);
    }
    case 'conditional': {
      return isUnsigned(condition.ifTrue) || isUnsigned(condition.ifFalse);
    }
    case 'binary': {
      if (['||', '&&', '==', '!=', '<', '>', '<=', '>='].includes(condition.op)) return false;
      if (condition.op === '<<' || condition.op === '>>') return isUnsigned(condition.left);
      return isUnsigned(condition.left) || isUnsigned(condition.right);
    }
  }
}

// code-gauge-allow functionCognitiveComplexity -- One case per C operator.
function applyOperator(op: string, left: CInteger, right: CInteger, error: (message: string) => Error): CInteger {
  if (op === '<<' || op === '>>') {
    const shift = right.unsigned ? right.value : BigInt.asIntN(64, right.value);
    const value = left.unsigned ? left.value : BigInt.asIntN(64, left.value);
    if (shift < 0n || shift >= 64n) return cInteger(0n, left.unsigned);
    return cInteger(op === '<<' ? value << shift : value >> shift, left.unsigned);
  }
  // The usual arithmetic conversions: when either operand is unsigned, both are.
  const unsigned = left.unsigned || right.unsigned;
  const a = cInteger(left.value, unsigned).value;
  const b = cInteger(right.value, unsigned).value;
  switch (op) {
    case '|': {
      return cInteger(a | b, unsigned);
    }
    case '^': {
      return cInteger(a ^ b, unsigned);
    }
    case '&': {
      return cInteger(a & b, unsigned);
    }
    case '==': {
      return truth(a === b);
    }
    case '!=': {
      return truth(a !== b);
    }
    case '<': {
      return truth(a < b);
    }
    case '>': {
      return truth(a > b);
    }
    case '<=': {
      return truth(a <= b);
    }
    case '>=': {
      return truth(a >= b);
    }
    case '+': {
      return cInteger(a + b, unsigned);
    }
    case '-': {
      return cInteger(a - b, unsigned);
    }
    case '*': {
      return cInteger(a * b, unsigned);
    }
    default: {
      if (b === 0n) throw error('#if の式で 0 で割っています。');
      // BigInt's division truncates toward zero and its remainder takes the dividend's sign, as C's do.
      return cInteger(op === '/' ? a / b : a % b, unsigned);
    }
  }
}
