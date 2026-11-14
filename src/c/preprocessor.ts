// code-gauge-allow-file fileNcss 520 -- Directive handling and macro expansion share preprocessing state.
import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { type LogicalLine, type PPToken, spell, tokenize } from './lexer';
import { decodeStringLiteral } from './literals';
import { evaluatePreprocessorCondition } from './preprocessorCondition';
import { TokenStream } from './tokenStream';
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
  dynamic?: 'line' | 'file';
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
  private readonly budget = new ExecutionBudget();
  private readonly macros = new Map<string, Macro>();
  private readonly includes: IncludedHeader[] = [];
  private readonly included = new Set<string>();
  private readonly errors: SourceDiagnostic[] = [];
  /** The #line directives, in order. */
  private readonly lines: { fromRow: number; line: number; file?: string }[] = [];
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
    this.macros.set('__LINE__', { name: '__LINE__', body: [], variadic: false, fromHeader: true, dynamic: 'line' });
    this.macros.set('__FILE__', { name: '__FILE__', body: [], variadic: false, fromHeader: true, dynamic: 'file' });
  }

  run(source: string): PreprocessedSource {
    const { lines, rowCount } = tokenize(source, this.budget);
    const output: string[][] = Array.from({ length: rowCount }, () => []);
    const emit = (tokens: PPToken[]): void => {
      for (const token of tokens) output[token.row]?.push(token.text);
    };
    this.process(lines, emit);
    if (this.errors.length > 0) throw new CompileError(this.errors.slice(0, 5));
    return { text: output.map((tokens) => tokens.join(' ')).join('\n'), includes: this.includes };
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Directive processing and ordinary-token flushing share source order and conditional state.
  private process(lines: LogicalLine[], emit: (tokens: PPToken[]) => void): void {
    const conditionals: Conditional[] = [];
    let pending: PPToken[] = [];
    const isActive = (): boolean => conditionals.every((conditional) => conditional.active);
    const flush = (): void => {
      if (pending.length === 0) return;
      try {
        rejectTrigraphs(pending);
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
    if (active) rejectTrigraphs(line.tokens);
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

  // code-gauge-allow functionNcss 38 -- Each directive shares one source-row and macro context.
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
      case 'pragma': {
        checkPragma(spell(rest), row);
        return;
      }
      case 'warning': {
        return;
      }
      case 'error': {
        throw new CompileError([{ row, message: `#error で止まりました: ${spell(rest)}` }]);
      }
      case 'line': {
        this.setLine(this.expand(rest), row);
        return;
      }
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
    if (nameToken?.kind === 'number') {
      // GNU's line marker, `# 12 "file.c"`, is #line in another spelling.
      this.setLine([nameToken, ...rest], row);
      return;
    }
    throw new CompileError([{ row, message: `「#${name}」という指令はありません。` }]);
  }

  /** `#line N "file"`: the next line is line N of that file, for __LINE__ and __FILE__. */
  private setLine(tokens: PPToken[], row: number): void {
    const [number, file] = tokens;
    if (number?.kind !== 'number' || !/^\d+$/.test(number.text)) {
      throw new CompileError([{ row, message: '#line の後には行番号を書いてください。' }]);
    }
    if (file && file.kind !== 'string')
      throw new CompileError([{ row, message: '#line のファイル名は文字列で書いてください。' }]);
    this.lines.push({ fromRow: row + 1, line: Number(number.text), file: file?.text });
  }

  /** The line number and the file name of a row, as #line set them. */
  private lineOf(row: number): { line: number; file: string } {
    let line = row + 1;
    let file = JSON.stringify(FILE_NAME);
    for (const entry of this.lines) {
      if (entry.fromRow > row) break;
      line = entry.line + (row - entry.fromRow);
      file = entry.file ?? file;
    }
    return { line, file };
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
    }
    if (body[0]?.text === '##' || body.at(-1)?.text === '##') {
      throw new CompileError([{ row, message: '## はマクロの本体の最初と最後には書けません。' }]);
    }
    if (params) checkStringizing(body, params, variadic, row);
    if (body.length > 0) body = [{ ...body[0], space: false }, ...body.slice(1)];
    this.macros.set(name, { name, params, variadic, body, fromHeader: this.inHeader });
  }

  // code-gauge-allow functionNcss 36 -- Include expansion, lookup, declarations, and source rows form one ordered header operation.
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
    if (name !== 'assert.h' && this.included.has(name)) return;
    this.included.add(name);
    if (name === 'assert.h') this.macros.delete('assert');
    const declarations: string[] = [];
    const wasInHeader = this.inHeader;
    this.inHeader = true;
    try {
      const { lines } = tokenize(found.text, this.budget);
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

  // code-gauge-allow functionCognitiveComplexity 16 -- defined replacement and identifier normalization precede one shared integer-expression evaluator.
  private evaluateCondition(tokens: PPToken[], row: number): boolean {
    rejectTrigraphs(tokens);
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
    return evaluatePreprocessorCondition(expanded, row) !== 0n;
  }

  // Expansion -----------------------------------------------------------------------------------------------------

  /** The value of __LINE__, __FILE__, __DATE__, or __TIME__. */
  private builtinMacro(token: PPToken): PPToken | undefined {
    switch (token.text) {
      case '__LINE__': {
        return { ...token, kind: 'number', text: String(this.lineOf(token.row).line) };
      }
      case '__FILE__': {
        return { ...token, kind: 'string', text: this.lineOf(token.row).file };
      }
      // A real build shows when it was built; every run here was built at the time time() gives.
      case '__DATE__': {
        return { ...token, kind: 'string', text: '"Jan  1 2026"' };
      }
      case '__TIME__': {
        return { ...token, kind: 'string', text: '"00:00:00"' };
      }
    }
    return undefined;
  }

  /** Expands the macros in a list of tokens, as C's rescanning with hide sets does. */
  // code-gauge-allow functionCognitiveComplexity 23 -- Macro recursion, hide sets, and argument substitution share the token worklist.
  private expand(input: PPToken[]): PPToken[] {
    const output: PPToken[] = [];
    const queue = new TokenStream(input, this.budget);
    for (let token = queue.take(); token; token = queue.take()) {
      const macro = token.kind === 'identifier' ? this.macros.get(token.text) : undefined;
      const builtin =
        token.kind === 'identifier' && (macro?.dynamic || token.text === '__DATE__' || token.text === '__TIME__')
          ? this.builtinMacro(token)
          : undefined;
      if (builtin && !token.hide?.has(token.text)) {
        output.push(builtin);
        continue;
      }
      if (skipIgnored(queue, token, (tokens) => this.expand(tokens))) continue;
      if (!macro || token.hide?.has(macro.name)) {
        output.push(token);
        continue;
      }
      if (!macro.params) {
        const hide = new Set([...(token.hide ?? []), macro.name]);
        const replacement = this.substitute(macro, [], hide, token);
        queue.prepend(replacement);
        continue;
      }
      if (queue.peek()?.text !== '(') {
        output.push(token);
        continue;
      }
      const { args, closing } = this.collectArguments(queue, macro, token.row);
      const hide = new Set([...[...(token.hide ?? [])].filter((name) => closing.hide?.has(name) ?? false), macro.name]);
      const replacement = this.substitute(macro, args, hide, token);
      queue.prepend(replacement);
    }
    return output;
  }

  // code-gauge-allow functionNcss 31 -- Nested argument scanning and its final arity check share the macro invocation.
  // code-gauge-allow functionCognitiveComplexity 23 -- Nested parentheses, separators, and the closing token share one argument cursor.
  private collectArguments(queue: TokenStream, macro: Macro, row: number): { args: PPToken[][]; closing: PPToken } {
    const params = macro.params as string[];
    const args: PPToken[][] = [[]];
    let depth = 0;
    queue.take();
    let closing: PPToken;
    for (;;) {
      const token = queue.take();
      if (!token) {
        throw new CompileError([{ row, message: `マクロ「${macro.name}」の呼び出しが ) で閉じられていません。` }]);
      }
      if (token.text === '(') depth++;
      if (token.text === ')') {
        if (depth === 0) {
          closing = token;
          break;
        }
        depth--;
      }
      const isSeparator = token.text === ',' && depth === 0 && !(macro.variadic && args.length > params.length);
      if (isSeparator) args.push([]);
      else (args.at(-1) as PPToken[]).push(token);
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
    return { args, closing };
  }

  // code-gauge-allow functionNcss 34 -- Stringification, variadic substitution and token pasting form one ordered pass.
  // code-gauge-allow functionCognitiveComplexity 29 -- Token pasting, variadic comma removal and argument expansion share replacement state.
  private substitute(macro: Macro, args: PPToken[][], hide: ReadonlySet<string>, call: PPToken): PPToken[] {
    const params = macro.variadic ? [...(macro.params ?? []), '__VA_ARGS__'] : (macro.params ?? []);
    const argumentsByPosition = args.map((tokens) => macroArgument(tokens, (input) => this.expand(input)));
    const argumentOf = (token: PPToken | undefined): ReturnType<typeof macroArgument> | undefined => {
      if (token?.kind !== 'identifier') return undefined;
      const position = params.indexOf(token.text);
      return position === -1 ? undefined : argumentsByPosition[position];
    };
    const result: (PPToken | undefined)[] = [];
    const body =
      macro.variadic && macro.body.some((token) => token.text === '__VA_OPT__')
        ? withVaOpt(macro.body, (argumentsByPosition.at(-1)?.expanded.length ?? 0) > 0, call.row)
        : macro.body;
    for (let index = 0; index < body.length; index++) {
      const token = body[index];
      this.budget.spend(1 + hide.size);
      if (token.text === '#' && macro.params) {
        const arg = argumentOf(body[index + 1])!;
        result.push({ kind: 'string', text: stringify(arg.raw, this.budget), row: call.row, space: token.space });
        index++;
        continue;
      }
      const pastesNext = body[index + 1]?.text === '##';
      const pastedPrevious = body[index - 1]?.text === '##';
      if (token.text === '##') continue;
      const arg = argumentOf(token);
      const copies = arg
        ? copyArgument(pastesNext || pastedPrevious ? arg.raw : arg.expanded, call.row, token.space, this.budget)
        : [{ ...token, row: call.row }];
      if (pastedPrevious && arg !== undefined && token.text === '__VA_ARGS__' && result.at(-1)?.text === ',') {
        if (copies.length === 0) result.pop();
        else result.push(...copies);
      } else appendSubstitution(result, copies, pastedPrevious, pastesNext, call.row, this.budget);
    }
    return result
      .filter((token): token is PPToken => token !== undefined)
      .map((token, position) => {
        this.budget.spend(1 + (token.hide?.size ?? 0) + hide.size);
        return {
          ...token,
          space: position === 0 ? call.space : token.space,
          hide: new Set([...(token.hide ?? []), ...hide]),
        };
      });
  }
}

function macroArgument(
  raw: PPToken[],
  expand: (tokens: PPToken[]) => PPToken[]
): { raw: PPToken[]; readonly expanded: PPToken[] } {
  let expanded: PPToken[] | undefined;
  return {
    raw,
    get expanded() {
      return (expanded ??= expand(raw));
    },
  };
}

const GNU_ATTRIBUTE_KEYWORDS = new Set(['__attribute__', '__attribute']);

function skipIgnored(queue: TokenStream, token: PPToken, expand: (tokens: PPToken[]) => PPToken[]): boolean {
  if (token.text === '[' && queue.peek()?.text === '[') {
    const tokens = takeAnnotation(queue, '[', ']', token.row, token);
    const expanded = [...tokens.slice(0, 2), ...expand(tokens.slice(2, -2)), ...tokens.slice(-2)];
    checkAttributes(spell(expanded), token.row);
    return true;
  }
  if (
    token.kind !== 'identifier' ||
    queue.peek()?.text !== '(' ||
    (token.text !== '_Pragma' && !GNU_ATTRIBUTE_KEYWORDS.has(token.text))
  )
    return false;
  const tokens = takeAnnotation(queue, '(', ')', token.row);
  const expanded = expand(tokens);
  if (token.text === '_Pragma') {
    if (expanded.length !== 3 || expanded[1].kind !== 'string')
      throw new CompileError([{ row: token.row, message: '_Pragma の後には ( と文字列と ) を書いてください。' }]);
    const text = new TextDecoder().decode(decodeStringLiteral([expanded[1].text], token.row).slice(0, -1));
    checkPragma(text, token.row);
  } else checkAttributes(spell(expanded), token.row);
  return true;
}

function takeAnnotation(queue: TokenStream, open: string, close: string, row: number, first?: PPToken): PPToken[] {
  const tokens: PPToken[] = first ? [first] : [];
  let depth = first ? 1 : 0;
  do {
    const next = queue.take();
    if (!next) throw new CompileError([{ row, message: '属性を囲む括弧の数が合いません。' }]);
    tokens.push(next);
    if (next.text === open) depth++;
    else if (next.text === close) depth--;
  } while (depth > 0);
  return tokens;
}

const LAYOUT_ATTRIBUTES = new Set(['packed', 'aligned', 'vector_size', 'mode', 'transparent_union']);
const IGNORED_ATTRIBUTES = new Set([
  'unused',
  'maybe_unused',
  'nodiscard',
  'warn_unused_result',
  'deprecated',
  'fallthrough',
  'noreturn',
  'format',
  'format_arg',
  'nonnull',
  'returns_nonnull',
  'sentinel',
  'alloc_size',
  'alloc_align',
  'noinline',
  'pure',
  'const',
  'hot',
  'cold',
  'flatten',
  'leaf',
  'artificial',
  'not_tail_called',
  'optnone',
  'annotate',
  'no_sanitize',
  'disable_sanitizer_instrumentation',
]);

// code-gauge-allow functionCognitiveComplexity 19 -- Attribute names are classified only at list depth, leaving argument identifiers and strings untouched.
export function checkAttributes(text: string, row: number): void {
  let depth = 0;
  const tokens = tokenize(text).lines.flatMap((line) => line.tokens);
  for (const [index, token] of tokens.entries()) {
    if (token.text === '(' || token.text === '[') depth++;
    else if (token.text === ')' || token.text === ']') depth--;
    else if (depth === 2 && token.kind === 'identifier' && tokens[index + 1]?.text !== ':') {
      const name = token.text.replaceAll(/^__|__$/g, '');
      if (LAYOUT_ATTRIBUTES.has(name)) unsupported(row, `配置や型を変える属性（${name}）`);
      if (!IGNORED_ATTRIBUTES.has(name)) unsupported(row, `属性（${name}）`);
    }
  }
}

function checkPragma(text: string, row: number): void {
  if (!text || /^(?:once|mark|message)\b/.test(text) || /^(?:GCC|clang)\s+diagnostic\b/.test(text)) return;
  unsupported(row, `#pragma ${text}`);
}

// code-gauge-allow functionCognitiveComplexity 16 -- Balanced parentheses and variadic presence determine replacement.
function withVaOpt(body: PPToken[], hasExtra: boolean, row: number): PPToken[] {
  const result: PPToken[] = [];
  for (let index = 0; index < body.length; index++) {
    const token = body[index];
    if (token.text !== '__VA_OPT__') {
      result.push(token);
      continue;
    }
    if (body[index + 1]?.text !== '(')
      throw new CompileError([{ row, message: '__VA_OPT__ の後には ( を書いてください。' }]);
    let depth = 0;
    let end = index + 1;
    for (; end < body.length; end++) {
      if (body[end].text === '(') depth++;
      if (body[end].text === ')' && --depth === 0) break;
    }
    if (hasExtra) result.push(...body.slice(index + 2, end));
    index = end;
  }
  return result;
}

function appendSubstitution(
  result: (PPToken | undefined)[],
  copies: PPToken[],
  pastedPrevious: boolean,
  pastesNext: boolean,
  row: number,
  budget: ExecutionBudget
): void {
  if (pastedPrevious) {
    const previous = result.pop();
    const next = copies[0];
    result.push(previous && next ? paste(previous, next, row, budget) : (previous ?? next));
    for (let i = 1; i < copies.length; i++) result.push(copies[i]);
  } else if (copies.length === 0 && pastesNext) result.push(undefined);
  else for (const copy of copies) result.push(copy);
}

// code-gauge-allow functionCognitiveComplexity 18 -- Parameter names and variadic placement are validated in one sequential macro signature.
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

function stringify(tokens: PPToken[], budget: ExecutionBudget): string {
  for (const token of tokens) budget.spend(token.text.length);
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

function paste(left: PPToken, right: PPToken, row: number, budget: ExecutionBudget): PPToken {
  const text = left.text + right.text;
  const { lines } = tokenize(text, budget);
  const tokens = lines.flatMap((line) => line.tokens);
  if (tokens.length !== 1) {
    throw new CompileError([{ row, message: `## でつないだ「${text}」は、1つの字句になりません。` }]);
  }
  return { ...tokens[0], row, space: left.space };
}

function rejectTrigraphs(tokens: PPToken[]): void {
  const token = tokens.find((item) => item.hasTrigraph);
  if (token) unsupported(token.row, 'トライグラフ');
}

function copyArgument(tokens: PPToken[], row: number, space: boolean, budget: ExecutionBudget): PPToken[] {
  budget.spend(tokens.length);
  return tokens.map((token, index) => ({ ...token, row, space: index === 0 ? space : token.space }));
}
