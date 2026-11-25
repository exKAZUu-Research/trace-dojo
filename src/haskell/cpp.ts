import { CompileError } from '../interpreter/diagnostics';
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
  body: string;
}

/** The versions `MIN_VERSION_...` compares with: those GHC 9.14.1 comes with. */
const PACKAGE_VERSIONS: Record<string, number[]> = {
  base: [4, 22, 0, 0],
  containers: [0, 8, 0, 0],
  GLASGOW_HASKELL: [9, 14, 1, 0],
};

/** Macros that tell the operating system or the CPU, which this environment does not let a program depend on. */
const PLATFORM_MACRO = /^\w+_(HOST|BUILD|TARGET)_(OS|ARCH)$/;

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
  private readonly macros = new Map<string, Macro>([
    ['__GLASGOW_HASKELL__', { body: '914' }],
    ['__GLASGOW_HASKELL_FULL_VERSION__', { body: '"9.14.1"' }],
    ['__GLASGOW_HASKELL_PATCHLEVEL1__', { body: '1' }],
    ['__FILE__', { body: '"Main.hs"' }],
  ]);

  private row = 0;
  private inBlockComment = 0;

  run(source: string): string {
    const lines = source.split('\n');
    const output: string[] = [];
    const stack: Conditional[] = [];
    for (let index = 0; index < lines.length; index++) {
      this.row = index;
      let line = lines[index];
      const directive = /^\s*#\s*([A-Za-z]+)?(.*)$/.exec(line);
      if (directive && this.inBlockComment === 0) {
        // A directive continues onto the next line after a backslash.
        let rest = directive[2];
        let joined = 0;
        while (rest.endsWith('\\') && index + 1 < lines.length) {
          rest = rest.slice(0, -1) + lines[++index];
          joined++;
        }
        const active = stack.every((item) => item.active);
        this.directive(directive[1] ?? '', rest.trim(), stack, active);
        output.push(...Array.from({ length: joined + 1 }, () => ''));
        continue;
      }
      if (!stack.every((item) => item.active)) {
        output.push('');
        continue;
      }
      // A macro call's arguments continue onto the code lines after it until its `)`.
      const comment = this.inBlockComment;
      let joined = 0;
      for (;;) {
        try {
          line = this.expandLine(line);
          break;
        } catch (error) {
          const next = lines[index + 1];
          if (!isUnclosedCall(error) || next === undefined || /^\s*#/.test(next)) throw error;
          this.inBlockComment = comment;
          line += `\n${next}`;
          index++;
          joined++;
        }
      }
      output.push(line, ...Array.from({ length: Math.max(joined - (line.split('\n').length - 1), 0) }, () => ''));
    }
    const open = stack.at(-1);
    if (open) throw this.error(open.row, '#if に対応する #endif がありません。');
    return output.join('\n');
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
        this.macros.set(match[1], { ...(params ? { params: params.filter(Boolean) } : {}), body: match[4] });
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

  private checkPlatform(name: string): void {
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
    const expanded = this.expand(withDefined, new Set(), true);
    const error = (message: string): Error => this.error(this.row, message);
    return evaluateCondition(new ConditionParser(expanded, error).parse(), error).value !== 0n;
  }

  /** Expands the macros of a line of code, outside its strings, characters, and comments. */
  private expandLine(line: string): string {
    let result = '';
    let index = 0;
    let code = '';
    const flush = (): void => {
      result += this.expand(code, new Set(), false);
      code = '';
    };
    while (index < line.length) {
      if (this.inBlockComment > 0) {
        const start = index;
        while (index < line.length && this.inBlockComment > 0) {
          if (line.startsWith('{-', index)) {
            this.inBlockComment++;
            index += 2;
          } else if (line.startsWith('-}', index)) {
            this.inBlockComment--;
            index += 2;
          } else index++;
        }
        result += line.slice(start, index);
        continue;
      }
      const char = line[index];
      if (line.startsWith('{-', index)) {
        flush();
        this.inBlockComment = 1;
        result += '{-';
        index += 2;
        continue;
      }
      if (line.startsWith('--', index) && /^--+(?![!#$%&*+./<=>?@\\^|~:])/.test(line.slice(index))) {
        flush();
        result += line.slice(index);
        break;
      }
      if (char === '"' || isCharacterLiteral(line, index, code)) {
        // A literal stays in the code, which a macro call's arguments may hold; expansion copies it as it is.
        const end = literalEnd(line, index);
        code += line.slice(index, end);
        index = end;
        continue;
      }
      code += char;
      index++;
    }
    flush();
    return result;
  }

  /** Expands the macros of a piece of code; a macro being expanded is not expanded again inside itself. */
  private expand(code: string, active: Set<string>, condition: boolean): string {
    let text = code;
    let result = '';
    let index = 0;
    while (index < text.length) {
      if (text[index] === '"' || isCharacterLiteral(text, index, result)) {
        const end = literalEnd(text, index);
        result += text.slice(index, end);
        index = end;
        continue;
      }
      const match = /^[A-Za-z_][\w']*/.exec(text.slice(index));
      if (!match || (index > 0 && /[\w']/.test(text[index - 1]))) {
        result += text[index];
        index++;
        continue;
      }
      const name = match[0];
      index += name.length;
      if (condition) this.checkPlatform(name);
      const expanded = this.expandName(name, text, index, active, condition);
      chargeTypeWork(expanded.text.length);
      // As C rescans a replacement with the code after it, a function-like macro's name that ends the replacement
      // takes the arguments that follow it.
      const tail = /(?<![\w'])[A-Za-z_][\w']*$/.exec(expanded.text);
      const follower = tail && tail[0] !== name && !active.has(tail[0]) ? this.macros.get(tail[0]) : undefined;
      if (follower?.params && /^\s*\(/.test(text.slice(expanded.end))) {
        result += expanded.text.slice(0, tail?.index);
        text = (tail?.[0] ?? '') + text.slice(expanded.end);
        index = 0;
        continue;
      }
      result += expanded.text;
      index = expanded.end;
    }
    return result;
  }

  /** What a name in code expands to, with where the code after it, past a macro call's arguments, starts. */
  private expandName(
    name: string,
    text: string,
    index: number,
    active: Set<string>,
    condition: boolean
  ): { text: string; end: number } {
    if (name === '__LINE__') return { text: String(this.row + 1), end: index };
    const version = /^MIN_VERSION_(\w+)$/.exec(name);
    const macro = active.has(name) ? undefined : this.macros.get(name);
    if (!macro && !version) return { text: condition ? '0' : name, end: index };
    if (macro && !macro.params) {
      return { text: this.blocking(active, name, () => this.expand(macro.body, active, condition)), end: index };
    }
    const call = /^\s*\(/.exec(text.slice(index));
    if (!call) return { text: name, end: index };
    const { args, end } = splitArguments(text, index + call[0].length - 1, (message) => this.error(this.row, message));
    if (version) {
      // In code, GHC's macro is a comparison, which Haskell reads as a Bool.
      const satisfied = this.minVersion(version[1], args);
      return { text: condition ? String(satisfied) : satisfied === 1 ? 'True' : 'False', end };
    }
    const params = (macro as Macro).params ?? [];
    if (params.length !== args.length) {
      throw this.error(this.row, `マクロ ${name} には、引数を ${params.length} 個書いてください。`);
    }
    // As C does, each argument is expanded in full first, under the macros being expanded around the call, and the
    // body with the results in it is then expanded again with this macro blocked.
    const expandedArgs = args.map((arg) => this.expand(arg.trim(), active, condition));
    const body = (macro as Macro).body.replaceAll(/[A-Za-z_]\w*/g, (word) => {
      const position = params.indexOf(word);
      return position === -1 ? word : expandedArgs[position];
    });
    return { text: this.blocking(active, name, () => this.expand(body, active, condition)), end };
  }

  /** Expands with a macro blocked, in the one set of the macros being expanded, which nested expansions share. */
  private blocking(active: Set<string>, name: string, expand: () => string): string {
    active.add(name);
    try {
      return expand();
    } finally {
      active.delete(name);
    }
  }

  private minVersion(packageName: string, args: string[]): number {
    const version = PACKAGE_VERSIONS[packageName];
    if (!version) throw this.error(this.row, `パッケージ ${packageName} の版のマクロはありません。`);
    const wanted = args.map((arg) => Number.parseInt(this.expand(arg, new Set(), true).trim(), 10));
    for (const [position, part] of wanted.entries()) {
      const have = version[position] ?? 0;
      if (have !== part) return have > part ? 1 : 0;
    }
    return 1;
  }

  private error(row: number, message: string): Error {
    return compileError(row, message);
  }
}

/** Whether a character literal starts at a position: a `'` that does not end a name such as `x'`. */
function isCharacterLiteral(text: string, index: number, before: string): boolean {
  return text[index] === "'" && /^'(\\.[^']*|[^\\'])'/.test(text.slice(index)) && !/[\w']$/.test(before);
}

/** Where a string or character literal starting at a position ends. */
function literalEnd(line: string, start: number): number {
  const quote = line[start];
  let index = start + 1;
  while (index < line.length && line[index] !== quote) index += line[index] === '\\' ? 2 : 1;
  return Math.min(index + 1, line.length);
}

/** The arguments of a macro call whose `(` is at a position, split at the commas outside parentheses. */
function splitArguments(
  text: string,
  open: number,
  error: (message: string) => Error
): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || isCharacterLiteral(text, index, current)) {
      const end = literalEnd(text, index);
      current += text.slice(index, end);
      index = end - 1;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')' && depth-- === 0) {
      args.push(current);
      return { args: args.length === 1 && args[0].trim() === '' ? [] : args, end: index + 1 };
    }
    if (char === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else current += char;
  }
  throw error(UNCLOSED_CALL);
}

const UNCLOSED_CALL = 'マクロの呼び出しの ) がありません。';

function isUnclosedCall(error: unknown): boolean {
  return error instanceof CompileError && error.diagnostics[0]?.message === UNCLOSED_CALL;
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
