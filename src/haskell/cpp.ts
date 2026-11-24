import { compileError, unsupportedError } from './errors';

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
      this.row = index + 1;
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
      line = this.expandLine(line);
      output.push(line);
    }
    const open = stack.at(-1);
    if (open) throw this.error(open.row, '#if に対応する #endif がありません。');
    return output.join('\n');
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per directive, as cpp handles them.
  private directive(name: string, rest: string, stack: Conditional[], active: boolean): void {
    switch (name) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        const value =
          active &&
          (name === 'if' ? this.evaluate(rest) !== 0 : this.isDefined(this.macroName(rest)) === (name === 'ifdef'));
        stack.push({ active: value, taken: value, outerActive: active, seenElse: false, row: this.row });
        return;
      }
      case 'elif': {
        const top = this.top(stack, '#elif');
        if (top.seenElse) throw this.error(this.row, '#else の後に #elif は書けません。');
        const value = top.outerActive && !top.taken && this.evaluate(rest) !== 0;
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

  /** Evaluates an `#if` condition: `defined`, integers, macros, and C's operators. */
  private evaluate(expression: string): number {
    const withDefined = expression.replaceAll(
      /\bdefined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g,
      (_, inParens: string | undefined, bare: string | undefined) => {
        const name = (inParens ?? bare) as string;
        this.checkPlatform(name);
        return this.isDefined(name) ? '1' : '0';
      }
    );
    const expanded = this.expand(withDefined, new Set(), true);
    return new ConditionParser(expanded, (message) => this.error(this.row, message)).parse();
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
      if (char === '"' || (char === "'" && /^'(\\.[^']*|[^\\'])'/.test(line.slice(index)) && !/[\w']$/.test(code))) {
        flush();
        const end = literalEnd(line, index);
        result += line.slice(index, end);
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
  private expand(text: string, active: ReadonlySet<string>, condition: boolean): string {
    let result = '';
    let index = 0;
    while (index < text.length) {
      const match = /^[A-Za-z_][\w']*/.exec(text.slice(index));
      if (!match || (index > 0 && /[\w']/.test(text[index - 1]))) {
        result += text[index];
        index++;
        continue;
      }
      const name = match[0];
      index += name.length;
      if (condition) this.checkPlatform(name);
      if (name === '__LINE__') {
        result += String(this.row);
        continue;
      }
      const version = /^MIN_VERSION_(\w+)$/.exec(name);
      const macro = active.has(name) ? undefined : this.macros.get(name);
      if (!macro && !version) {
        result += condition && !name.startsWith("'") ? '0' : name;
        continue;
      }
      if (!macro?.params && !version) {
        result += this.expand((macro as Macro).body, new Set([...active, name]), condition);
        continue;
      }
      const call = /^\s*\(/.exec(text.slice(index));
      if (!call) {
        result += name;
        continue;
      }
      const { args, end } = splitArguments(text, index + call[0].length - 1, (message) =>
        this.error(this.row, message)
      );
      index = end;
      if (version) {
        // In code, GHC's macro is a comparison, which Haskell reads as a Bool.
        const satisfied = this.minVersion(version[1], args);
        result += condition ? String(satisfied) : satisfied === 1 ? 'True' : 'False';
        continue;
      }
      const params = (macro as Macro).params ?? [];
      if (params.length !== args.length) {
        throw this.error(this.row, `マクロ ${name} には、引数を ${params.length} 個書いてください。`);
      }
      const body = (macro as Macro).body.replaceAll(/[A-Za-z_]\w*/g, (word) => {
        const position = params.indexOf(word);
        return position === -1 ? word : args[position].trim();
      });
      result += this.expand(body, new Set([...active, name]), condition);
    }
    return result;
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
  throw error('マクロの呼び出しの ) がありません。');
}

/** Parses and evaluates the integer expression of an `#if`, after its macros are expanded. */
class ConditionParser {
  private readonly tokens: string[];
  private position = 0;

  constructor(
    text: string,
    private readonly error: (message: string) => Error
  ) {
    this.tokens = text.match(/\d+|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%()<>!~&|^?:]|\S/g) ?? [];
  }

  parse(): number {
    const value = this.ternary();
    if (this.position < this.tokens.length) throw this.error(`#if の式 ${this.tokens.join(' ')} に誤りがあります。`);
    return value;
  }

  private ternary(): number {
    const condition = this.binary(0);
    if (this.tokens[this.position] !== '?') return condition;
    this.position++;
    const ifTrue = this.ternary();
    this.expect(':');
    const ifFalse = this.ternary();
    return condition === 0 ? ifFalse : ifTrue;
  }

  private static readonly LEVELS: string[][] = [
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

  private binary(level: number): number {
    if (level >= ConditionParser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    while (ConditionParser.LEVELS[level].includes(this.tokens[this.position])) {
      const operator = this.tokens[this.position++];
      const right = this.binary(level + 1);
      left = applyOperator(operator, left, right, this.error);
    }
    return left;
  }

  private unary(): number {
    const token = this.tokens[this.position++];
    switch (token) {
      case '!': {
        return this.unary() === 0 ? 1 : 0;
      }
      case '-': {
        return -this.unary();
      }
      case '+': {
        return this.unary();
      }
      case '~': {
        return ~this.unary();
      }
      case '(': {
        const value = this.ternary();
        this.expect(')');
        return value;
      }
      default: {
        if (token !== undefined && /^\d+$/.test(token)) return Number.parseInt(token, 10);
        throw this.error(`#if の式に誤りがあります（${token ?? '式の終わり'}）。`);
      }
    }
  }

  private expect(token: string): void {
    if (this.tokens[this.position] !== token) throw this.error(`#if の式に ${token} がありません。`);
    this.position++;
  }
}

// code-gauge-allow functionCognitiveComplexity -- One case per C operator.
function applyOperator(operator: string, left: number, right: number, error: (message: string) => Error): number {
  switch (operator) {
    case '||': {
      return left !== 0 || right !== 0 ? 1 : 0;
    }
    case '&&': {
      return left !== 0 && right !== 0 ? 1 : 0;
    }
    case '|': {
      return left | right;
    }
    case '^': {
      return left ^ right;
    }
    case '&': {
      return left & right;
    }
    case '==': {
      return left === right ? 1 : 0;
    }
    case '!=': {
      return left === right ? 0 : 1;
    }
    case '<': {
      return left < right ? 1 : 0;
    }
    case '>': {
      return left > right ? 1 : 0;
    }
    case '<=': {
      return left <= right ? 1 : 0;
    }
    case '>=': {
      return left >= right ? 1 : 0;
    }
    case '<<': {
      return left << right;
    }
    case '>>': {
      return left >> right;
    }
    case '+': {
      return left + right;
    }
    case '-': {
      return left - right;
    }
    case '*': {
      return left * right;
    }
    default: {
      if (right === 0) throw error('#if の式で 0 で割っています。');
      return operator === '/' ? Math.trunc(left / right) : left % right;
    }
  }
}
