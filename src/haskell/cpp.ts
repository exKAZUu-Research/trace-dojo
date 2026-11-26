import { compileError, unsupportedError } from './errors';
import { PACKAGE_VERSIONS } from './packages';
import { RecursionBudget } from './recursionBudget';
import { chargeTypeWork } from './typeWorkBudget';

/**
 * The C preprocessor GHC runs on a program with the CPP extension, in the subset that version and feature guards use:
 *
 * - `#define NAME tokens` and `#undef NAME`, with object-like macros expanded in code (outside strings and comments)
 *   and in conditions, and a macro never expanded inside its own expansion;
 * - `#if`, `#ifdef`, `#ifndef`, `#elif`, `#else`, and `#endif`, whose conditions are made of decimal integers,
 *   macros, `defined NAME` or `defined(NAME)`, `MIN_VERSION_pkg(a,b,c)` and `MIN_VERSION_GLASGOW_HASKELL(a,b,c,d)`,
 *   parentheses, `!`, `&&`, `||`, and the comparisons `==`, `!=`, `<`, `>`, `<=`, `>=`;
 * - the predefined macros `__GLASGOW_HASKELL__` and the others GHC defines, `VERSION_pkg`, and `__LINE__`;
 * - `#error`, and `#warning`, `#line`, `#pragma`, and `#ident`, which change nothing.
 *
 * Function-like macros, `#` and `##` in a macro's body, the other operators of C in a condition, and `#include` are
 * reported as unavailable. Each directive and each line an `#if` leaves out becomes an empty line, so that lines keep
 * their numbers.
 */
export function preprocess(source: string): string {
  return new Preprocessor().run(source);
}

interface Token {
  kind: 'name' | 'space' | 'newline' | 'comment' | 'other';
  text: string;
  row: number;
}

const GHC_VERSION = '9.14.1.0';

/**
 * The versions `MIN_VERSION_pkg(major1,major2,minor)`, as Cabal generates it for each package, and
 * `MIN_VERSION_GLASGOW_HASKELL(ma,mi,pl1,pl2)` compare their arguments with, by macro name.
 */
function versionChecks(): [string, number[]][] {
  return [
    ...Object.entries(PACKAGE_VERSIONS).map(([pkg, version]): [string, number[]] => [
      `MIN_VERSION_${pkg.replaceAll('-', '_')}`,
      versionParts(version, 3),
    ]),
    ['MIN_VERSION_GLASGOW_HASKELL', versionParts(GHC_VERSION, 4)],
  ];
}

function versionParts(version: string, count: number): number[] {
  const parts = version.split('.').map(Number);
  return Array.from({ length: count }, (_, index) => parts[index] ?? 0);
}

/** Macros that tell the operating system or the CPU, which this environment does not let a program depend on. */
const PLATFORM_MACRO = /^\w+_(HOST|BUILD|TARGET)_(OS|ARCH)$/;

const DIRECTIVE = /^\s*#\s*([A-Za-z]+)?(.*)$/;

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
  readonly macros = new Map<string, Token[]>([
    ['__GLASGOW_HASKELL__', tokenize('914', 0)],
    ['__GLASGOW_HASKELL_FULL_VERSION__', tokenize('"9.14.1"', 0)],
    ['__GLASGOW_HASKELL_PATCHLEVEL1__', tokenize('1', 0)],
    ['__FILE__', tokenize('"Main.hs"', 0)],
    ...Object.entries(PACKAGE_VERSIONS).map(([pkg, version]): [string, Token[]] => [
      `VERSION_${pkg.replaceAll('-', '_')}`,
      tokenize(`"${version}"`, 0),
    ]),
  ]);

  readonly versionChecks = new Map(versionChecks());

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
        output += new Expansion(this, lexer.line(), 'code')
          .run()
          .map((token) => token.text)
          .join('');
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
        this.define(rest);
        return;
      }
      case 'undef': {
        const macro = this.macroName(rest);
        this.macros.delete(macro);
        this.versionChecks.delete(macro);
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

  private define(rest: string): void {
    const match = /^([A-Za-z_]\w*)(.*)$/.exec(rest);
    if (!match) throw this.error(this.row, '#define の書き方に誤りがあります。');
    const [, name, definition] = match;
    this.checkPlatform(name);
    if (definition.startsWith('(')) {
      throw unsupportedError(this.row, `関数のようなマクロの定義（#define ${name}(...)）`);
    }
    const body = tokenize(definition.trim(), this.row);
    if (body.some((token) => token.text === '#')) {
      throw unsupportedError(this.row, 'マクロの本体での # や ##（文字列化やトークンの連結）');
    }
    this.versionChecks.delete(name);
    this.macros.set(name, body);
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

  isDefined(name: string): boolean {
    return this.macros.has(name) || this.versionChecks.has(name) || name === '__LINE__';
  }

  checkPlatform(name: string): void {
    if (PLATFORM_MACRO.test(name)) {
      throw unsupportedError(this.row, `OS や CPU の種類による切り替え（${name}）`);
    }
  }

  private evaluate(expression: string): boolean {
    const expanded = new Expansion(this, tokenize(expression, this.row), 'condition').run();
    const text = expanded.map((token) => token.text).join('');
    return new ConditionParser(text, this.row).parse() !== 0n;
  }

  error(row: number, message: string): Error {
    return compileError(row, message);
  }
}

/** A run of tokens being read: the input, a macro's body, or tokens put back. */
interface Frame {
  tokens: Token[];
  position: number;
  /** The macro whose body the frame holds, which is not expanded while the frame is open. */
  macro?: string;
}

/**
 * Where the expansion of a line goes: code, where a version check becomes `True` or `False`; a condition, where
 * `defined` is applied and a name that is no macro becomes `0`; or an argument of a version check.
 */
type Destination = 'code' | 'condition' | 'argument';

/** The expansion of the object-like macros and version checks in a line, until no macro is left. */
class Expansion {
  private readonly frames: Frame[];
  private readonly output: Token[] = [];
  /** The macros of the open frames. */
  private readonly disabled = new Set<string>();

  constructor(
    private readonly preprocessor: Preprocessor,
    tokens: Token[],
    private readonly destination: Destination
  ) {
    this.frames = [{ tokens, position: 0 }];
  }

  run(): Token[] {
    for (let token = this.read(); token; token = this.read()) this.examine(token);
    return this.output;
  }

  private examine(token: Token): void {
    if (token.kind !== 'name') {
      this.output.push(token);
      return;
    }
    const { preprocessor, destination } = this;
    // An argument's tokens may come from a macro's body, whose row is that of its `#define`.
    if (this.frames.length === 1 && destination !== 'argument') preprocessor.row = token.row;
    const name = token.text;
    if (destination !== 'code') preprocessor.checkPlatform(name);
    const body = preprocessor.macros.get(name);
    if (name === '__LINE__') {
      this.emit(String(preprocessor.row + 1), token);
    } else if (destination === 'condition' && name === 'defined') {
      this.emit(preprocessor.isDefined(this.definedName()) ? '1' : '0', token);
    } else if (body && !this.disabled.has(name)) {
      chargeTypeWork(1 + body.length);
      this.frames.push({ tokens: body, position: 0, macro: name });
      this.disabled.add(name);
    } else if (!body && destination !== 'argument' && /^MIN_VERSION_\w+$/.test(name) && this.takeOpenParen()) {
      const atLeast = this.versionCheck(name);
      this.emit(destination === 'code' ? (atLeast ? 'True' : 'False') : atLeast ? '1' : '0', token);
    } else {
      this.output.push(destination === 'condition' ? { ...token, kind: 'other', text: '0' } : token);
    }
  }

  private emit(text: string, token: Token): void {
    this.output.push({ kind: 'other', text, row: token.row });
  }

  /** The next token, past the frames that have ended; none at the end of the line. */
  private read(): Token | undefined {
    for (;;) {
      const frame = this.frames.at(-1);
      if (!frame) return undefined;
      if (frame.position < frame.tokens.length) return frame.tokens[frame.position++];
      this.frames.pop();
      if (frame.macro !== undefined) this.disabled.delete(frame.macro);
    }
  }

  private readNonSpace(): Token | undefined {
    let token = this.read();
    while (token?.kind === 'space') token = this.read();
    return token;
  }

  /** Reads the `(` after a name, or puts back what follows the name. */
  private takeOpenParen(): boolean {
    const skipped: Token[] = [];
    let token = this.read();
    for (; token?.kind === 'space'; token = this.read()) skipped.push(token);
    if (token?.kind === 'other' && token.text === '(') return true;
    if (token) skipped.push(token);
    if (skipped.length > 0) this.frames.push({ tokens: skipped, position: 0 });
    return false;
  }

  /** The name after `defined`, in parentheses or not. */
  private definedName(): string {
    const error = (): Error =>
      this.preprocessor.error(this.preprocessor.row, 'defined の後にマクロの名前を書いてください。');
    let token = this.readNonSpace();
    const parenthesized = token?.text === '(';
    if (parenthesized) token = this.readNonSpace();
    if (token?.kind !== 'name') throw error();
    if (parenthesized && this.readNonSpace()?.text !== ')') throw error();
    this.preprocessor.checkPlatform(token.text);
    return token.text;
  }

  /** Whether the version a `MIN_VERSION_...(` checks is at least the one its arguments, read up to the `)`, give. */
  private versionCheck(name: string): boolean {
    const { preprocessor } = this;
    const version = preprocessor.versionChecks.get(name);
    if (!version) throw unsupportedError(preprocessor.row, `ほかのパッケージのバージョンの確認（${name}）`);
    const args = this.collectArguments(name).map((arg) => {
      const text = new Expansion(preprocessor, arg, 'argument')
        .run()
        .map((token) => token.text)
        .join('')
        .trim();
      if (!/^\d+$/.test(text)) {
        throw unsupportedError(preprocessor.row, `${name} の整数でない引数（${text}）`);
      }
      return Number(text);
    });
    if (args.length !== version.length) {
      throw preprocessor.error(preprocessor.row, `${name} には、引数を ${version.length} 個書いてください。`);
    }
    const differing = args.findIndex((arg, index) => arg !== version[index]);
    return differing === -1 || args[differing] < version[differing];
  }

  /** The arguments of a call after its `(`, split at the commas outside parentheses. */
  private collectArguments(name: string): Token[][] {
    const args: Token[][] = [[]];
    let depth = 0;
    for (;;) {
      const token = this.read();
      if (!token) throw unsupportedError(this.preprocessor.row, `複数の行にわたる ${name} の呼び出し`);
      chargeTypeWork(1);
      const punctuation = token.kind === 'other' ? token.text : '';
      if (punctuation === ')' && depth-- === 0) return args;
      if (punctuation === ',' && depth === 0) {
        args.push([]);
        continue;
      }
      if (punctuation === '(') depth++;
      (args.at(-1) as Token[]).push(token);
    }
  }
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

/** The tokens of an `#if` condition after its macros are expanded. */
const CONDITION_TOKEN = /\d[\w.]*|'(?:\\.[^']*|[^\\'])'|&&|\|\||==|!=|<=|>=|<<|>>|\S/g;

const COMPARISONS: readonly (readonly string[])[] = [
  ['==', '!='],
  ['<', '>', '<=', '>='],
];

/** C's operators outside the subset, which a version or feature guard does not need. */
const UNAVAILABLE_OPERATORS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '~', '<<', '>>', '?', ':']);

/** Evaluates an `#if` condition after its macros are expanded: the grammar the subset of {@link preprocess} allows. */
class ConditionParser {
  private readonly tokens: string[];
  private position = 0;
  private readonly depth = new RecursionBudget();

  constructor(
    text: string,
    private readonly row: number
  ) {
    this.tokens = text.match(CONDITION_TOKEN) ?? [];
    chargeTypeWork(1 + this.tokens.length);
  }

  parse(): bigint {
    const value = this.or();
    if (this.position < this.tokens.length) this.unexpected(this.tokens[this.position]);
    return value;
  }

  private or(): bigint {
    let value = this.and();
    while (this.accept('||')) value = truth(this.and() !== 0n || value !== 0n);
    return value;
  }

  private and(): bigint {
    let value = this.comparison(0);
    while (this.accept('&&')) value = truth(this.comparison(0) !== 0n && value !== 0n);
    return value;
  }

  private comparison(level: number): bigint {
    if (level >= COMPARISONS.length) return this.unary();
    let left = this.comparison(level + 1);
    while (COMPARISONS[level].includes(this.tokens[this.position])) {
      const op = this.tokens[this.position++];
      left = compare(op, left, this.comparison(level + 1));
    }
    return left;
  }

  private unary(): bigint {
    return this.depth.run(() => {
      const token = this.tokens[this.position++];
      if (token === '!') return truth(this.unary() === 0n);
      if (token === '(') {
        const inner = this.or();
        if (!this.accept(')')) throw compileError(this.row, '#if の式に ) がありません。');
        return inner;
      }
      if (token !== undefined && /^\d/.test(token)) return this.integer(token);
      return this.unexpected(token);
    });
  }

  private integer(token: string): bigint {
    if (!/^(?:0|[1-9]\d*)$/.test(token)) throw unsupportedError(this.row, `#if の中の 10 進数でない数（${token}）`);
    return BigInt(token);
  }

  private unexpected(token: string | undefined): never {
    if (token === undefined) throw compileError(this.row, '#if の式に誤りがあります（式の終わり）。');
    if (token.startsWith("'")) throw unsupportedError(this.row, `#if の中の文字定数（${token}）`);
    if (UNAVAILABLE_OPERATORS.has(token)) throw unsupportedError(this.row, `#if の中の算術や条件演算子（${token}）`);
    throw compileError(this.row, `#if の式に誤りがあります（${token}）。`);
  }

  private accept(token: string): boolean {
    if (this.tokens[this.position] !== token) return false;
    this.position++;
    return true;
  }
}

function compare(op: string, left: bigint, right: bigint): bigint {
  switch (op) {
    case '==': {
      return truth(left === right);
    }
    case '!=': {
      return truth(left !== right);
    }
    case '<': {
      return truth(left < right);
    }
    case '>': {
      return truth(left > right);
    }
    case '<=': {
      return truth(left <= right);
    }
    default: {
      return truth(left >= right);
    }
  }
}

const truth = (value: boolean): bigint => (value ? 1n : 0n);
