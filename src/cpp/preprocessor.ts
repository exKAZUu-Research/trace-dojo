import type { PPToken } from '../c/lexer';
import { evaluatePreprocessorCondition } from '../c/preprocessorCondition';
import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { unsupported } from './errors';
import { isStandardHeader } from './library/headers';
import { isLibcHeaderMacro } from './library/libcGlobals';

/** A preprocessing token of a line, with whether white space comes before it. */
interface Token {
  kind: 'identifier' | 'number' | 'string' | 'char' | 'punctuator' | 'other';
  text: string;
  space: boolean;
  /** The macros whose expansion made the token, which it must not expand again. */
  hide?: ReadonlySet<string>;
}

interface Macro {
  /** The parameters of a function-like macro, or undefined for an object-like one. */
  params?: string[];
  variadic: boolean;
  body: Token[];
}

interface Conditional {
  row: number;
  active: boolean;
  taken: boolean;
  parentActive: boolean;
  sawElse: boolean;
}

/** The directives a program may use besides `#include`, whose presence makes the preprocessor run. */
const DIRECTIVE =
  /^[ \t]*#[ \t]*(?:define|undef|if|ifdef|ifndef|elif|elifdef|elifndef|else|endif|error|warning|line|pragma)\b/m;
const PREDEFINED = /\b(?:__LINE__|__FILE__|__cplusplus|__DATE__|__TIME__|_Pragma)\b/;

const PUNCTUATORS = [
  '%:%:',
  '<=>',
  '->*',
  '...',
  '<<=',
  '>>=',
  '##',
  '::',
  '.*',
  '->',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '*=',
  '/=',
  '%=',
  '+=',
  '-=',
  '&=',
  '^=',
  '|=',
  '<:',
  ':>',
  '<%',
  '%>',
  '%:',
];

/** The macros clang++ defines before a program's first line (`-std=c++20` on arm64 macOS). */
const PREDEFINED_MACROS: Record<string, string> = {
  __cplusplus: '202002L',
  __STDC_HOSTED__: '1',
  __clang__: '1',
  __clang_major__: '21',
  __GNUC__: '4',
  __GNUC_MINOR__: '2',
  __APPLE__: '1',
  __MACH__: '1',
  __aarch64__: '1',
  __arm64__: '1',
  __LP64__: '1',
  __CHAR_BIT__: '8',
  __SIZEOF_INT__: '4',
  __SIZEOF_LONG__: '8',
  __SIZEOF_POINTER__: '8',
  __cpp_concepts: '202002L',
  __cpp_constexpr: '201907L',
  __cpp_lambdas: '200907L',
  __cpp_structured_bindings: '201606L',
};

/** The name a program's file has, which `__FILE__` gives. */
const FILE_NAME = 'main.cpp';

/**
 * Runs the C++ preprocessor (C++20 [cpp]) on a program, keeping every line on its row: directives and the lines that
 * conditional inclusion leaves out become empty, and the lines that use macros take their expansion. A program
 * without directives besides `#include` stays as written. `#include` lines stay for the compiler to read.
 */
export function preprocessCpp(source: string): string {
  if (!DIRECTIVE.test(source) && !PREDEFINED.test(source)) return source;
  return new Preprocessor().run(source);
}

class Preprocessor {
  private readonly macros = new Map<string, Macro>();
  private readonly headers = new Set<string>();
  private readonly budget = new ExecutionBudget();
  private readonly errors: SourceDiagnostic[] = [];
  private lineOffset = 0;
  private row = 0;

  constructor() {
    for (const [name, value] of Object.entries(PREDEFINED_MACROS))
      this.macros.set(name, { variadic: false, body: tokenize(value) });
  }

  run(source: string): string {
    const lines = logicalLines(source);
    const output: string[] = [];
    const conditionals: Conditional[] = [];
    const isActive = (): boolean => conditionals.every((conditional) => conditional.active);
    for (const line of lines) {
      this.row = line.row;
      this.budget.spend(Math.ceil((line.text.length + 1) / 64));
      const blank = '\n'.repeat(line.rows - 1);
      const directive = /^[ \t]*#[ \t]*([A-Za-z_]*)(.*)$/s.exec(line.code);
      try {
        if (directive && !line.startsInComment) {
          const [, name, rest] = directive;
          const kept = this.directive(name, rest.trim(), conditionals, isActive());
          output.push((kept && isActive() ? line.text : '') + blank);
          continue;
        }
        if (!isActive()) {
          output.push(blank);
          continue;
        }
        output.push(this.expandLine(line) + blank);
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        this.errors.push(...error.diagnostics);
        output.push(blank);
      }
    }
    const unterminated = conditionals.at(-1);
    if (unterminated) this.errors.push({ row: unterminated.row, message: '#if に対応する #endif がありません。' });
    if (this.errors.length > 0) throw new CompileError(this.errors.slice(0, 5));
    return output.join('\n');
  }

  /** Handles a directive, telling whether its line stays for the compiler (an `#include`). */
  private directive(name: string, rest: string, conditionals: Conditional[], active: boolean): boolean {
    const top = conditionals.at(-1);
    switch (name) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        const value = active && this.condition(name, rest);
        conditionals.push({ row: this.row, active: value, taken: value, parentActive: active, sawElse: false });
        return false;
      }
      case 'elif':
      case 'elifdef':
      case 'elifndef': {
        if (!top || top.sawElse) return this.fail(`#${name} に対応する #if がありません。`);
        const value = top.parentActive && !top.taken && this.condition(name.replace('el', ''), rest);
        top.active = value;
        top.taken ||= value;
        return false;
      }
      case 'else': {
        if (!top || top.sawElse) return this.fail('#else に対応する #if がありません。');
        top.active = top.parentActive && !top.taken;
        top.taken = true;
        top.sawElse = true;
        return false;
      }
      case 'endif': {
        if (!top) return this.fail('#endif に対応する #if がありません。');
        conditionals.pop();
        return false;
      }
      default: {
        break;
      }
    }
    if (!active) return false;
    switch (name) {
      case 'include': {
        const header = /^<([^>]+)>/.exec(rest)?.[1]?.trim();
        if (header) this.headers.add(header);
        return true;
      }
      case 'define': {
        this.define(rest);
        return false;
      }
      case 'undef': {
        this.macros.delete(rest.split(/\s/)[0]);
        return false;
      }
      case 'error': {
        return this.fail(`#error ${rest}`);
      }
      case 'warning':
      case 'pragma':
      case '': {
        return false;
      }
      case 'line': {
        const line = Number(/^\d+/.exec(rest)?.[0]);
        if (!Number.isFinite(line)) return this.fail('#line には行番号を書いてください。');
        this.lineOffset = line - (this.row + 2);
        return false;
      }
      default: {
        return this.fail(`プリプロセッサの指令 #${name} はありません。`);
      }
    }
  }

  private fail(message: string): never {
    throw new CompileError([{ row: this.row, message }]);
  }

  private define(rest: string): void {
    const match = /^([A-Za-z_]\w*)(\()?/.exec(rest);
    if (!match) return this.fail('#define の後にマクロの名前を書いてください。');
    const name = match[1];
    if (name === 'defined') return this.fail('defined はマクロの名前にできません。');
    if (!match[2]) {
      this.macros.set(name, { variadic: false, body: tokenize(rest.slice(name.length)) });
      return;
    }
    const close = rest.indexOf(')');
    if (close === -1) return this.fail(`マクロ ${name} の引数の並びに ) がありません。`);
    const params = rest
      .slice(name.length + 1, close)
      .split(',')
      .map((param) => param.trim())
      .filter((param) => param !== '');
    const variadic = params.at(-1) === '...';
    if (variadic) params.pop();
    this.macros.set(name, { params, variadic, body: tokenize(rest.slice(close + 1)) });
  }

  private condition(kind: string, rest: string): boolean {
    if (kind === 'ifdef' || kind === 'ifndef') {
      const name = rest.split(/\s/)[0];
      if (!name) return this.fail(`#${kind} の後にマクロの名前を書いてください。`);
      return this.isDefined(name) === (kind === 'ifdef');
    }
    const tokens = this.resolveDefined(tokenize(rest));
    const expanded = this.expand(tokens).map((token): Token => {
      if (token.kind !== 'identifier') return token;
      // The names left after expansion are 0, but for C++'s `true` (C++20 [cpp.cond]p12).
      return { ...token, kind: 'number', text: token.text === 'true' ? '1' : '0' };
    });
    const pp = expanded.map((token): PPToken => ({
      kind: token.kind,
      text: token.text,
      row: this.row,
      space: token.space,
    }));
    return evaluatePreprocessorCondition(pp, this.row) !== 0n;
  }

  private isDefined(name: string): boolean {
    return this.macros.has(name) || ['__LINE__', '__FILE__'].includes(name) || isLibcHeaderMacro(name, this.headers);
  }

  /** Replaces `defined X`, `defined(X)`, and `__has_include(<h>)` with 1 or 0, before macros expand. */
  private resolveDefined(tokens: Token[]): Token[] {
    const result: Token[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.text === 'defined' || token.text === '__has_include') {
        const parenthesized = tokens[index + 1]?.text === '(';
        let value: boolean;
        let end: number;
        if (token.text === '__has_include') {
          const close = tokens.findIndex((candidate, at) => at > index && candidate.text === ')');
          const header = tokens
            .slice(index + 2, close)
            .map((part) => part.text)
            .join('')
            .replaceAll(/^[<"]|[>"]$/g, '');
          value = isStandardHeader(header);
          end = close;
        } else {
          const name = tokens[index + (parenthesized ? 2 : 1)];
          if (name?.kind !== 'identifier') return this.fail('defined の後にマクロの名前を書いてください。');
          value = this.isDefined(name.text);
          end = index + (parenthesized ? 3 : 1);
        }
        result.push({ kind: 'number', text: value ? '1' : '0', space: token.space });
        index = end;
        continue;
      }
      result.push(token);
    }
    return result;
  }

  private expandLine(line: LogicalLine): string {
    const tokens = tokenize(line.code);
    if (!tokens.some((token) => token.kind === 'identifier' && (this.macros.has(token.text) || isDynamic(token.text))))
      return line.text;
    const expanded = spell(this.removePragmaOperators(this.expand(tokens)));
    return line.endsInComment ? `${expanded} /*` : expanded;
  }

  /** Removes `_Pragma("...")`, which asks only for what the interpreter does anyway. */
  private removePragmaOperators(tokens: Token[]): Token[] {
    const result: Token[] = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].text === '_Pragma' && tokens[index + 1]?.text === '(') {
        index += 3;
        continue;
      }
      result.push(tokens[index]);
    }
    return result;
  }

  /** Expands the macros of a token list, rescanning each replacement (C++20 [cpp.rescan]). */
  private expand(tokens: Token[]): Token[] {
    const result: Token[] = [];
    for (let index = 0; index < tokens.length; index++) {
      this.budget.spend();
      const token = tokens[index];
      if (token.kind !== 'identifier' || token.hide?.has(token.text)) {
        result.push(token);
        continue;
      }
      if (isDynamic(token.text)) {
        result.push(this.dynamic(token));
        continue;
      }
      const macro = this.macros.get(token.text);
      if (!macro) {
        result.push(token);
        continue;
      }
      const hide = new Set([...(token.hide ?? []), token.text]);
      if (!macro.params) {
        const body = macro.body.map((part, at) => ({ ...part, space: at === 0 ? token.space : part.space, hide }));
        result.push(...this.expand(this.paste(body)));
        continue;
      }
      if (tokens[index + 1]?.text !== '(') {
        result.push(token);
        continue;
      }
      const { args, end } = this.collectArguments(tokens, index + 1, token.text);
      index = end;
      const replaced = this.substitute(macro, args, token.text).map((part, at) => ({
        ...part,
        space: at === 0 ? token.space : part.space,
        hide: new Set([...(part.hide ?? []), ...hide]),
      }));
      result.push(...this.expand(replaced));
    }
    return result;
  }

  private dynamic(token: Token): Token {
    if (token.text === '__LINE__')
      return { kind: 'number', text: String(this.row + 1 + this.lineOffset), space: token.space };
    if (token.text === '__FILE__') return { kind: 'string', text: `"${FILE_NAME}"`, space: token.space };
    return unsupported(this.row, `${token.text}（翻訳した日時）`);
  }

  /** The arguments of a function-like macro's invocation, from its `(` to the matching `)`. */
  private collectArguments(tokens: Token[], open: number, name: string): { args: Token[][]; end: number } {
    const args: Token[][] = [[]];
    let depth = 0;
    for (let index = open + 1; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.text === '(') depth++;
      if (token.text === ')') {
        if (depth === 0) return { args: args.length === 1 && args[0].length === 0 ? [] : args, end: index };
        depth--;
      }
      if (token.text === ',' && depth === 0) {
        args.push([]);
        continue;
      }
      (args.at(-1) as Token[]).push(token);
    }
    return this.fail(`マクロ ${name} の呼び出しに ) がありません（引数は1行に書いてください）。`);
  }

  /** The replacement of a function-like macro with its arguments: `#`, `##`, `__VA_ARGS__`, and `__VA_OPT__`. */
  private substitute(macro: Macro, written: Token[][], name: string): Token[] {
    const params = macro.params as string[];
    let args = written;
    if (params.length === 1 && args.length === 0 && !macro.variadic) args = [[]];
    if (macro.variadic) {
      const named = args.slice(0, params.length);
      const rest = args.slice(params.length);
      const variadic: Token[] = rest.flatMap((arg, at) =>
        at === 0 ? arg : [{ kind: 'punctuator', text: ',', space: false }, ...arg]
      );
      args = [...named, variadic];
    }
    const names = macro.variadic ? [...params, '__VA_ARGS__'] : params;
    if (args.length !== names.length && !(macro.variadic && args.length >= params.length))
      return this.fail(`マクロ ${name} の引数の数が合いません。`);
    const argumentOf = (token: Token): Token[] | undefined => {
      const index = token.kind === 'identifier' ? names.indexOf(token.text) : -1;
      return index < 0 ? undefined : (args[index] ?? []);
    };
    const body = macro.body;
    const result: Token[] = [];
    for (let index = 0; index < body.length; index++) {
      const token = body[index];
      if (token.text === '#' && body[index + 1] && argumentOf(body[index + 1])) {
        const arg = argumentOf(body[index + 1]) as Token[];
        result.push({ kind: 'string', text: stringize(arg), space: token.space });
        index++;
        continue;
      }
      if (token.text === '__VA_OPT__' && body[index + 1]?.text === '(') {
        const end = matchingParenthesis(body, index + 1);
        if (end < 0) return this.fail('__VA_OPT__ の ( に対応する ) がありません。');
        const content = body.slice(index + 2, end);
        const hasArguments = (args.at(-1) ?? []).length > 0;
        if (hasArguments) result.push(...this.substituteParts(content, argumentOf, false));
        index = end;
        continue;
      }
      const arg = argumentOf(token);
      if (arg) {
        const isPasted = body[index - 1]?.text === '##' || body[index + 1]?.text === '##';
        const replacement = isPasted ? arg : this.expand(arg);
        result.push(...replacement.map((part, at) => ({ ...part, space: at === 0 ? token.space : part.space })));
        continue;
      }
      result.push(token);
    }
    return this.paste(result);
  }

  private substituteParts(
    tokens: Token[],
    argumentOf: (token: Token) => Token[] | undefined,
    isPasted: boolean
  ): Token[] {
    return tokens.flatMap((token) => {
      const arg = argumentOf(token);
      return arg ? (isPasted ? arg : this.expand(arg)) : [token];
    });
  }

  /** Joins the tokens around each `##` into one (C++20 [cpp.concat]). */
  private paste(tokens: Token[]): Token[] {
    const result: Token[] = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].text === '##' && result.length > 0 && tokens[index + 1]) {
        const left = result.pop() as Token;
        const [joined] = tokenize(left.text + tokens[index + 1].text);
        result.push({ ...(joined ?? left), space: left.space, hide: left.hide });
        index++;
        continue;
      }
      result.push(tokens[index]);
    }
    return result;
  }
}

/** The index of the `)` that closes the `(` at `open`, or -1. */
function matchingParenthesis(tokens: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index].text === '(') depth++;
    if (tokens[index].text === ')' && --depth === 0) return index;
  }
  return -1;
}

function isDynamic(name: string): boolean {
  return name === '__LINE__' || name === '__FILE__' || name === '__DATE__' || name === '__TIME__';
}

/** A string literal of an argument's spelling, as `#` makes it (C++20 [cpp.stringize]). */
function stringize(tokens: Token[]): string {
  const text = tokens
    .map((token, index) => {
      const spelled =
        token.kind === 'string' || token.kind === 'char'
          ? token.text.replaceAll(/[\\"]/g, String.raw`\$&`)
          : token.text;
      return index > 0 && token.space ? ` ${spelled}` : spelled;
    })
    .join('');
  return `"${text}"`;
}

function spell(tokens: Token[]): string {
  return tokens.map((token, index) => (index > 0 && token.space ? ` ${token.text}` : token.text)).join('');
}

/** A logical line: physical lines that backslashes join, with its text without comments. */
interface LogicalLine {
  row: number;
  rows: number;
  text: string;
  /** The text with comments replaced by spaces and the backslash-newlines removed. */
  code: string;
  startsInComment: boolean;
  /** Whether a block comment the line starts goes on past it, which an expansion must keep open. */
  endsInComment: boolean;
}

function logicalLines(source: string): LogicalLine[] {
  const physical = source.split('\n');
  const lines: LogicalLine[] = [];
  let inComment = false;
  for (let row = 0; row < physical.length;) {
    const startsInComment = inComment;
    let text = physical[row];
    let rows = 1;
    while (text.endsWith('\\') && row + rows < physical.length) {
      text = `${text.slice(0, -1)}${physical[row + rows]}`;
      rows++;
    }
    const stripped = stripComments(text, inComment);
    inComment = stripped.inComment;
    // A line continued with backslashes keeps its rows: its text goes on the first, and the others stay empty.
    lines.push({ row, rows, text, code: stripped.code, startsInComment, endsInComment: inComment });
    row += rows;
  }
  return lines;
}

/** A line's code with its comments replaced by a space, and whether a block comment continues past it. */
function stripComments(text: string, startsInComment: boolean): { code: string; inComment: boolean } {
  let code = '';
  let inComment = startsInComment;
  for (let index = 0; index < text.length; index++) {
    if (inComment) {
      if (text.startsWith('*/', index)) {
        inComment = false;
        index++;
        code += ' ';
      }
      continue;
    }
    const char = text[index];
    if (char === '"' || char === "'") {
      const end = literalEnd(text, index);
      code += text.slice(index, end);
      index = end - 1;
      continue;
    }
    if (text.startsWith('//', index)) break;
    if (text.startsWith('/*', index)) {
      inComment = true;
      index++;
      continue;
    }
    code += char;
  }
  return { code, inComment };
}

function literalEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === quote) return index + 1;
  }
  return text.length;
}

/** Splits code into preprocessing tokens (C++20 [lex.pptoken]). */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let space = false;
  for (let index = 0; index < code.length;) {
    const char = code[index];
    if (/\s/.test(char)) {
      space = true;
      index++;
      continue;
    }
    const raw = /^(?:u8|[uUL])?R"([^(\s]*)\(/.exec(code.slice(index));
    if (raw) {
      const close = code.indexOf(`)${raw[1]}"`, index + raw[0].length);
      const end = close === -1 ? code.length : close + raw[1].length + 2;
      tokens.push({ kind: 'string', text: code.slice(index, end), space });
      index = end;
      space = false;
      continue;
    }
    const prefix = /^(?:u8|[uUL])?(["'])/.exec(code.slice(index));
    if (prefix) {
      const start = index + prefix[0].length - 1;
      let end = literalEnd(code, start);
      const suffix = /^[A-Za-z_]\w*/.exec(code.slice(end));
      if (suffix) end += suffix[0].length;
      tokens.push({ kind: prefix[1] === '"' ? 'string' : 'char', text: code.slice(index, end), space });
      index = end;
      space = false;
      continue;
    }
    const number = /^\.?\d(?:[eEpP][+-]|['\w.])*/.exec(code.slice(index));
    if (number) {
      tokens.push({ kind: 'number', text: number[0], space });
      index += number[0].length;
      space = false;
      continue;
    }
    const identifier = /^[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/.exec(code.slice(index));
    if (identifier) {
      tokens.push({ kind: 'identifier', text: identifier[0], space });
      index += identifier[0].length;
      space = false;
      continue;
    }
    const punctuator = PUNCTUATORS.find((candidate) => code.startsWith(candidate, index)) ?? char;
    tokens.push({ kind: punctuator.length > 0 ? 'punctuator' : 'other', text: punctuator, space });
    index += punctuator.length;
    space = false;
  }
  return tokens;
}
