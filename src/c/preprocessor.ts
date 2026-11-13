import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { type LogicalLine, type PPToken, spell, tokenize } from './lexer';
import { decodeCharLiteral, parseNumber } from './literals';
import { INT_PROPERTIES } from './types';
import { unsupported } from './unsupported';

/** A macro, as `#define` records it. */
interface Macro {
  name: string;
  /** The parameter names of a function-like macro, or undefined for an object-like one. */
  params?: string[];
  variadic: boolean;
  body: PPToken[];
  /** Whether a header the program includes defined the macro, which may use features learners cannot. */
  fromHeader: boolean;
}

/** A standard header, written as C source the preprocessor reads when a program includes it. */
export interface HeaderSource {
  /** Directives (macros) and declarations, which the compiler reads as if they stood at the `#include`. */
  text: string;
}

/** What `#include <name>` finds: a header's source, or a message saying why the header cannot be used. */
export type HeaderLookup = (name: string, quoted: boolean) => HeaderSource | { refusal: string };

/** A header the program included, with the declarations that become visible at its row. */
export interface IncludedHeader {
  row: number;
  name: string;
  /** The header's declarations after preprocessing, as C source. */
  declarations: string;
}

export interface PreprocessedSource {
  /** The source with directives removed and macros expanded, where every token stays on its original row. */
  text: string;
  includes: IncludedHeader[];
}

export const FILE_NAME = 'main.c';

/** Runs C's preprocessor on a program, keeping every token on the row it came from. */
export function preprocess(source: string, lookup: HeaderLookup): PreprocessedSource {
  return new Preprocessor(lookup).run(source);
}

interface Conditional {
  /** Whether the lines of the current branch are kept. */
  active: boolean;
  /** Whether some branch of this conditional has been taken. */
  taken: boolean;
  /** Whether the enclosing lines are kept. */
  parentActive: boolean;
  sawElse: boolean;
  row: number;
}

const CONDITIONAL_DIRECTIVES = new Set(['if', 'ifdef', 'ifndef', 'elif', 'elifdef', 'elifndef', 'else', 'endif']);

class Preprocessor {
  private readonly macros = new Map<string, Macro>();
  private readonly includes: IncludedHeader[] = [];
  private readonly included = new Set<string>();
  private readonly errors: SourceDiagnostic[] = [];
  /** Whether a header is being read, whose macros may use what learners cannot. */
  private inHeader = false;

  constructor(private readonly lookup: HeaderLookup) {
    for (const [name, value] of [
      ['__STDC__', '1'],
      ['__STDC_VERSION__', '201710L'],
      ['__STDC_HOSTED__', '1'],
      ['__APPLE__', '1'],
      ['__MACH__', '1'],
      ['__aarch64__', '1'],
      ['__arm64__', '1'],
      ['__LP64__', '1'],
      ['__clang__', '1'],
      ['__STDC_UTF_16__', '1'],
      ['__STDC_UTF_32__', '1'],
    ] as const) {
      this.macros.set(name, {
        name,
        variadic: false,
        body: [{ kind: 'number', text: value, row: 0, space: false }],
        fromHeader: true,
      });
    }
  }

  run(source: string): PreprocessedSource {
    const { lines, rowCount } = tokenize(source);
    const output: string[][] = Array.from({ length: rowCount }, () => []);
    const emit = (tokens: PPToken[]): void => {
      for (const token of tokens) output[token.row]?.push(token.text);
    };
    this.process(lines, emit);
    if (this.errors.length > 0) throw new CompileError(this.errors.slice(0, 5));
    return { text: output.map((tokens) => tokens.join(' ')).join('\n'), includes: this.includes };
  }

  private process(lines: LogicalLine[], emit: (tokens: PPToken[]) => void): void {
    const conditionals: Conditional[] = [];
    let pending: PPToken[] = [];
    const isActive = (): boolean => conditionals.every((conditional) => conditional.active);
    const flush = (): void => {
      if (pending.length === 0) return;
      try {
        emit(this.expand(pending));
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        this.errors.push(...error.diagnostics);
      }
      pending = [];
    };
    for (const line of lines) {
      const [first, second] = line.tokens;
      if (first?.text === '#' && first.kind === 'punctuator') {
        flush();
        try {
          this.directive(line, second, conditionals, isActive);
        } catch (error) {
          if (!(error instanceof CompileError)) throw error;
          this.errors.push(...error.diagnostics);
        }
        continue;
      }
      if (isActive()) pending.push(...line.tokens);
    }
    flush();
    const open = conditionals.at(-1);
    if (open) this.errors.push({ row: open.row, message: '#if に対応する #endif がありません。' });
  }

  private directive(
    line: LogicalLine,
    nameToken: PPToken | undefined,
    conditionals: Conditional[],
    isActive: () => boolean
  ): void {
    const { row } = line;
    const name = nameToken?.text ?? '';
    const rest = line.tokens.slice(2);
    const active = isActive();
    if (CONDITIONAL_DIRECTIVES.has(name)) this.conditionalDirective(name, rest, row, conditionals, active);
    else if (active) this.otherDirective(name, nameToken, rest, row);
  }

  private conditionalDirective(
    name: string,
    rest: PPToken[],
    row: number,
    conditionals: Conditional[],
    active: boolean
  ): void {
    switch (name) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        let value = false;
        if (active) {
          value =
            name === 'if' ? this.evaluateCondition(rest, row) : this.isDefined(rest, row, name) === (name === 'ifdef');
        }
        conditionals.push({ active: active && value, taken: value, parentActive: active, sawElse: false, row });
        return;
      }
      case 'elif':
      case 'elifdef':
      case 'elifndef': {
        this.elif(name, rest, row, conditionals);
        return;
      }
      case 'else': {
        const top = conditionals.at(-1);
        if (!top) throw new CompileError([{ row, message: '#else に対応する #if がありません。' }]);
        if (top.sawElse) throw new CompileError([{ row, message: '#else が2つあります。' }]);
        top.sawElse = true;
        top.active = top.parentActive && !top.taken;
        top.taken = true;
        return;
      }
      default: {
        if (!conditionals.pop()) throw new CompileError([{ row, message: '#endif に対応する #if がありません。' }]);
      }
    }
  }

  private elif(name: string, rest: PPToken[], row: number, conditionals: Conditional[]): void {
    if (name !== 'elif' && !this.inHeader) unsupported(row, `#${name}`);
    const top = conditionals.at(-1);
    if (!top) throw new CompileError([{ row, message: `#${name} に対応する #if がありません。` }]);
    if (top.sawElse) throw new CompileError([{ row, message: `#else の後に #${name} は書けません。` }]);
    if (top.taken || !top.parentActive) {
      top.active = false;
      return;
    }
    const value =
      name === 'elif' ? this.evaluateCondition(rest, row) : this.isDefined(rest, row, name) === (name === 'elifdef');
    top.active = value;
    top.taken = value;
  }

  private otherDirective(name: string, nameToken: PPToken | undefined, rest: PPToken[], row: number): void {
    switch (name) {
      case '': {
        return;
      }
      case 'define': {
        this.define(rest, row);
        return;
      }
      case 'undef': {
        const target = rest[0];
        if (target?.kind !== 'identifier')
          throw new CompileError([{ row, message: '#undef の後にはマクロの名前を書いてください。' }]);
        this.macros.delete(target.text);
        return;
      }
      case 'include': {
        this.include(rest, row);
        return;
      }
      case 'pragma':
      case 'error':
      case 'warning':
      case 'line':
      case 'ident':
      case 'sccs':
      case 'assert':
      case 'unassert':
      case 'include_next':
      case 'import': {
        unsupported(row, `#${name}`);
        return;
      }
    }
    if (nameToken?.kind === 'number' && !this.inHeader) unsupported(row, '# の後に行番号を書く指令');
    throw new CompileError([{ row, message: `「#${name}」という指令はありません。` }]);
  }

  private define(tokens: PPToken[], row: number): void {
    const [nameToken, ...rest] = tokens;
    if (nameToken?.kind !== 'identifier') {
      throw new CompileError([{ row, message: '#define の後にはマクロの名前を書いてください。' }]);
    }
    const name = nameToken.text;
    if (name === 'defined') throw new CompileError([{ row, message: '「defined」はマクロの名前にできません。' }]);
    let params: string[] | undefined;
    let variadic = false;
    let body = rest;
    // A function-like macro's parameters follow its name with no space between.
    if (rest[0]?.text === '(' && !rest[0].space) {
      ({ params, variadic, body } = macroParameters(rest, row));
      if (variadic && !this.inHeader) unsupported(row, '可変長の引数をとるマクロ（...）');
    }
    if (body[0]?.text === '##' || body.at(-1)?.text === '##') {
      throw new CompileError([{ row, message: '## はマクロの本体の最初と最後には書けません。' }]);
    }
    if (params) checkStringizing(body, params, variadic, row);
    if (body.length > 0) body = [{ ...body[0], space: false }, ...body.slice(1)];
    this.macros.set(name, { name, params, variadic, body, fromHeader: this.inHeader });
  }

  private include(tokens: PPToken[], row: number): void {
    let target = tokens;
    if (target[0]?.kind !== 'string' && target[0]?.text !== '<') target = this.expand(target);
    let name: string;
    let quoted: boolean;
    if (target[0]?.kind === 'string' && target[0].text.startsWith('"')) {
      name = target[0].text.slice(1, -1);
      quoted = true;
    } else if (target[0]?.text === '<' && target.some((token) => token.text === '>')) {
      const end = target.findIndex((token) => token.text === '>');
      name = spell(target.slice(1, end));
      quoted = false;
    } else {
      throw new CompileError([{ row, message: '#include の後には <stdio.h> のようにヘッダの名前を書いてください。' }]);
    }
    const found = this.lookup(name, quoted);
    if ('refusal' in found) throw new CompileError([{ row, message: found.refusal }]);
    if (this.included.has(name)) return;
    this.included.add(name);
    const declarations: string[] = [];
    const wasInHeader = this.inHeader;
    this.inHeader = true;
    try {
      const { lines } = tokenize(found.text);
      // A header's tokens all take the row of its #include, where its declarations become visible.
      for (const line of lines) {
        line.row = row;
        for (const token of line.tokens) token.row = row;
      }
      this.process(lines, (expanded) => declarations.push(spell(expanded)));
    } finally {
      this.inHeader = wasInHeader;
    }
    this.includes.push({ row, name, declarations: declarations.join('\n') });
  }

  private isDefined(tokens: PPToken[], row: number, directive: string): boolean {
    const [name] = tokens;
    if (name?.kind !== 'identifier') {
      throw new CompileError([{ row, message: `#${directive} の後にはマクロの名前を書いてください。` }]);
    }
    return this.macros.has(name.text);
  }

  // Conditions ----------------------------------------------------------------------------------------------------

  private evaluateCondition(tokens: PPToken[], row: number): boolean {
    const replaced: PPToken[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.text !== 'defined') {
        replaced.push(token);
        continue;
      }
      const parenthesized = tokens[index + 1]?.text === '(';
      const name = tokens[index + (parenthesized ? 2 : 1)];
      if (name?.kind !== 'identifier' || (parenthesized && tokens[index + 3]?.text !== ')')) {
        throw new CompileError([{ row, message: 'defined の後にはマクロの名前を書いてください。' }]);
      }
      replaced.push({ ...token, kind: 'number', text: this.macros.has(name.text) ? '1' : '0' });
      index += parenthesized ? 3 : 1;
    }
    const expanded = this.expand(replaced).map((token): PPToken =>
      token.kind === 'identifier' ? { ...token, kind: 'number', text: '0' } : token
    );
    if (expanded.length === 0) throw new CompileError([{ row, message: '#if の後には条件を書いてください。' }]);
    return new ConditionParser(expanded, row).parse() !== 0n;
  }

  // Expansion -----------------------------------------------------------------------------------------------------

  /** Expands the macros in a list of tokens, as C's rescanning with hide sets does. */
  private expand(input: PPToken[]): PPToken[] {
    const output: PPToken[] = [];
    const queue = [...input];
    let index = 0;
    while (index < queue.length) {
      const token = queue[index++];
      const macro = token.kind === 'identifier' ? this.macros.get(token.text) : undefined;
      if (token.kind === 'identifier' && token.text === '__LINE__' && !token.hide?.has('__LINE__')) {
        output.push({ ...token, kind: 'number', text: String(token.row + 1) });
        continue;
      }
      if (token.kind === 'identifier' && token.text === '__FILE__') {
        output.push({ ...token, kind: 'string', text: JSON.stringify(FILE_NAME) });
        continue;
      }
      if (token.kind === 'identifier' && (token.text === '__DATE__' || token.text === '__TIME__')) {
        unsupported(token.row, token.text);
      }
      if (!macro || token.hide?.has(macro.name)) {
        output.push(token);
        continue;
      }
      if (!macro.params) {
        const hide = new Set([...(token.hide ?? []), macro.name]);
        const replacement = this.substitute(macro, [], hide, token);
        queue.splice(index, 0, ...replacement);
        continue;
      }
      if (queue[index]?.text !== '(') {
        output.push(token);
        continue;
      }
      const { args, end } = this.collectArguments(queue, index, macro, token.row);
      const closing = queue[end];
      const hide = new Set([...[...(token.hide ?? [])].filter((name) => closing.hide?.has(name) ?? false), macro.name]);
      const replacement = this.substitute(macro, args, hide, token);
      queue.splice(index - 1, end - index + 2, ...replacement);
      index--;
    }
    return output;
  }

  private collectArguments(
    queue: PPToken[],
    open: number,
    macro: Macro,
    row: number
  ): { args: PPToken[][]; end: number } {
    const params = macro.params as string[];
    const args: PPToken[][] = [[]];
    let depth = 0;
    let index = open + 1;
    for (;;) {
      const token = queue[index];
      if (!token) {
        throw new CompileError([{ row, message: `マクロ「${macro.name}」の呼び出しが ) で閉じられていません。` }]);
      }
      if (token.text === '(') depth++;
      if (token.text === ')') {
        if (depth === 0) break;
        depth--;
      }
      const isSeparator = token.text === ',' && depth === 0 && !(macro.variadic && args.length > params.length);
      if (isSeparator) args.push([]);
      else (args.at(-1) as PPToken[]).push(token);
      index++;
    }
    const expected = params.length + (macro.variadic ? 1 : 0);
    if (args.length === 1 && args[0].length === 0 && params.length === 0) args.length = 0;
    if (macro.variadic && args.length === params.length) args.push([]);
    if (args.length !== expected) {
      const message =
        args.length < expected
          ? `マクロ「${macro.name}」の引数が足りません。`
          : `マクロ「${macro.name}」の引数が多すぎます。`;
      throw new CompileError([{ row, message }]);
    }
    return { args, end: index };
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- C's substitution rules for #, ##, and arguments.
  private substitute(macro: Macro, args: PPToken[][], hide: ReadonlySet<string>, call: PPToken): PPToken[] {
    const params = macro.variadic ? [...(macro.params ?? []), '__VA_ARGS__'] : (macro.params ?? []);
    const argumentOf = (token: PPToken | undefined): PPToken[] | undefined => {
      if (token?.kind !== 'identifier') return undefined;
      const position = params.indexOf(token.text);
      return position === -1 ? undefined : args[position];
    };
    const result: PPToken[] = [];
    const body = macro.body;
    for (let index = 0; index < body.length; index++) {
      const token = body[index];
      if (token.text === '#' && macro.params) {
        const arg = argumentOf(body[index + 1]) as PPToken[];
        result.push({ kind: 'string', text: stringify(arg), row: call.row, space: token.space });
        index++;
        continue;
      }
      const pastesNext = body[index + 1]?.text === '##';
      const pastedPrevious = body[index - 1]?.text === '##';
      if (token.text === '##') continue;
      const arg = argumentOf(token);
      const copies = arg
        ? (pastesNext || pastedPrevious ? arg : this.expand(arg)).map((item, position) => ({
            ...item,
            row: call.row,
            space: position === 0 ? token.space : item.space,
          }))
        : [{ ...token, row: call.row }];
      if (pastedPrevious && result.length > 0 && copies.length > 0) {
        result.push(paste(result.pop() as PPToken, copies[0], call.row), ...copies.slice(1));
      } else {
        result.push(...copies);
      }
    }
    return result.map((token, position) => ({
      ...token,
      space: position === 0 ? call.space : token.space,
      hide: new Set([...(token.hide ?? []), ...hide]),
    }));
  }
}

function macroParameters(rest: PPToken[], row: number): { params: string[]; variadic: boolean; body: PPToken[] } {
  const params: string[] = [];
  let variadic = false;
  let index = 1;
  for (;;) {
    const token = rest[index++];
    if (!token) throw new CompileError([{ row, message: 'マクロの引数の並びが ) で閉じられていません。' }]);
    if (token.text === ')' && params.length === 0 && !variadic) break;
    if (token.text === '...') {
      variadic = true;
    } else if (token.kind === 'identifier') {
      if (params.includes(token.text)) {
        throw new CompileError([{ row, message: `マクロの引数「${token.text}」が2つあります。` }]);
      }
      params.push(token.text);
    } else {
      throw new CompileError([{ row, message: 'マクロの引数には名前を書いてください。' }]);
    }
    const separator = rest[index++];
    if (separator?.text === ')') break;
    if (separator?.text !== ',' || variadic) {
      throw new CompileError([{ row, message: 'マクロの引数の並びが ) で閉じられていません。' }]);
    }
  }
  return { params, variadic, body: rest.slice(index) };
}

function checkStringizing(body: PPToken[], params: string[], variadic: boolean, row: number): void {
  for (const [index, token] of body.entries()) {
    if (token.text !== '#') continue;
    const operand = body[index + 1];
    if (
      operand?.kind !== 'identifier' ||
      !(params.includes(operand.text) || (variadic && operand.text === '__VA_ARGS__'))
    ) {
      throw new CompileError([{ row, message: '# の後にはマクロの引数を書いてください。' }]);
    }
  }
}

function stringify(tokens: PPToken[]): string {
  const text = tokens
    .map((token, index) => {
      const spelled =
        token.kind === 'string' || token.kind === 'char'
          ? token.text.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)
          : token.text;
      return (index > 0 && token.space ? ' ' : '') + spelled;
    })
    .join('');
  return `"${text}"`;
}

function paste(left: PPToken, right: PPToken, row: number): PPToken {
  const text = left.text + right.text;
  const { lines } = tokenize(text);
  const tokens = lines.flatMap((line) => line.tokens);
  if (tokens.length !== 1) {
    throw new CompileError([{ row, message: `## でつないだ「${text}」は、1つの字句になりません。` }]);
  }
  return { ...tokens[0], row, space: left.space };
}

const truth = (value: boolean): bigint => (value ? 1n : 0n);

interface ConditionValue {
  value: bigint;
  unsigned: boolean;
}

function conditionValue(value: bigint, unsigned = false): ConditionValue {
  return { value: unsigned ? BigInt.asUintN(64, value) : BigInt.asIntN(64, value), unsigned };
}

const CONDITION_OPERATIONS: Record<string, (a: bigint, b: bigint) => bigint> = {
  '||': (a, b) => truth(a !== 0n || b !== 0n),
  '&&': (a, b) => truth(a !== 0n && b !== 0n),
  '|': (a, b) => a | b,
  '^': (a, b) => a ^ b,
  '&': (a, b) => a & b,
  '==': (a, b) => truth(a === b),
  '!=': (a, b) => truth(a !== b),
  '<': (a, b) => truth(a < b),
  '>': (a, b) => truth(a > b),
  '<=': (a, b) => truth(a <= b),
  '>=': (a, b) => truth(a >= b),
  '<<': (a, b) => a << b,
  '>>': (a, b) => a >> b,
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
};

/** Evaluates the integer constant expression of `#if`, in the widest integer type as C requires. */
class ConditionParser {
  private index = 0;

  constructor(
    private readonly tokens: PPToken[],
    private readonly row: number
  ) {}

  parse(): bigint {
    const value = this.conditional();
    if (this.index < this.tokens.length) this.fail();
    return value.value;
  }

  private fail(): never {
    throw new CompileError([{ row: this.row, message: '#if の条件の書き方に誤りがあります。' }]);
  }

  private peek(): string | undefined {
    return this.tokens[this.index]?.text;
  }

  private conditional(evaluate = true): ConditionValue {
    const condition = this.binary(0, evaluate);
    if (this.peek() !== '?') return condition;
    this.index++;
    const whenTrue = this.conditional(evaluate && condition.value !== 0n);
    if (this.peek() !== ':') this.fail();
    this.index++;
    const whenFalse = this.conditional(evaluate && condition.value === 0n);
    const selected = condition.value === 0n ? whenFalse : whenTrue;
    return conditionValue(selected.value, whenTrue.unsigned || whenFalse.unsigned);
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

  private binary(level: number, evaluate: boolean): ConditionValue {
    if (level >= ConditionParser.LEVELS.length) return this.unary(evaluate);
    let left = this.binary(level + 1, evaluate);
    for (;;) {
      const operator = this.peek();
      if (operator === undefined || !ConditionParser.LEVELS[level].includes(operator)) return left;
      this.index++;
      const skipped = (operator === '&&' && left.value === 0n) || (operator === '||' && left.value !== 0n);
      const right = this.binary(level + 1, evaluate && !skipped);
      left = this.apply(operator, left, right, evaluate);
    }
  }

  private apply(operator: string, a: ConditionValue, b: ConditionValue, evaluate: boolean): ConditionValue {
    const comparison = ['||', '&&', '==', '!=', '<', '>', '<=', '>='].includes(operator);
    const shift = operator === '<<' || operator === '>>';
    const unsigned = !comparison && (shift ? a.unsigned : a.unsigned || b.unsigned);
    if (!evaluate) return conditionValue(0n, unsigned);
    const left = conditionValue(a.value, a.unsigned || (!shift && b.unsigned)).value;
    const right = conditionValue(b.value, b.unsigned || (!shift && a.unsigned)).value;
    if ((operator === '/' || operator === '%') && right === 0n)
      throw new CompileError([{ row: this.row, message: '#if の条件で 0 で割っています。' }]);
    if (shift && (right < 0n || right >= 64n)) this.fail();
    const value = CONDITION_OPERATIONS[operator](left, right);
    return conditionValue(value, unsigned);
  }

  private unary(evaluate: boolean): ConditionValue {
    const token = this.tokens[this.index++];
    if (!token) this.fail();
    switch (token.text) {
      case '-': {
        const value = this.unary(evaluate);
        return conditionValue(-value.value, value.unsigned);
      }
      case '+': {
        return this.unary(evaluate);
      }
      case '!': {
        return conditionValue(truth(this.unary(evaluate).value === 0n));
      }
      case '~': {
        const value = this.unary(evaluate);
        return conditionValue(~value.value, value.unsigned);
      }
      case '(': {
        const value = this.conditional(evaluate);
        if (this.peek() !== ')') this.fail();
        this.index++;
        return value;
      }
    }
    if (token.kind === 'number') {
      const parsed = parseNumber(token.text, this.row);
      if (parsed.type.kind !== 'int') this.fail();
      return conditionValue(BigInt(parsed.value), !INT_PROPERTIES[parsed.type.name].signed);
    }
    if (token.kind === 'char') return conditionValue(BigInt(decodeCharLiteral(token.text, this.row)));
    this.fail();
  }
}
