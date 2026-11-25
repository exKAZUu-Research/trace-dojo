import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { unsupported } from './convertBase';

/**
 * The symbols `dotnet run` defines for a file-based app: the Debug configuration's `DEBUG` and `TRACE`, and the target
 * framework's symbols for .NET 10.
 */
const PREDEFINED_SYMBOLS = [
  'DEBUG',
  'TRACE',
  'NET',
  'NET10_0',
  'NETCOREAPP',
  ...['5_0', '6_0', '7_0', '8_0', '9_0', '10_0'].map((version) => `NET${version}_OR_GREATER`),
  ...['1_0', '1_1', '2_0', '2_1', '2_2', '3_0', '3_1'].map((version) => `NETCOREAPP${version}_OR_GREATER`),
];

/** The compiler options that a program's `#:property` directives set. */
export interface BuildOptions {
  allowUnsafe: boolean;
  /** `CheckForOverflowUnderflow`, which makes integer arithmetic checked by default. */
  checkOverflow: boolean;
  implicitUsings: boolean;
  /** The symbols defined at the end of the file, which `[Conditional]` methods test. */
  symbols: string[];
}

export interface PreprocessedSource {
  /** The source with directives and the lines they leave out blanked, so that rows and columns stay as written. */
  text: string;
  options: BuildOptions;
}

/** The `#:property` names whose values the run follows, and those that change nothing a program can observe. */
const IGNORED_PROPERTIES = new Set([
  'Nullable',
  'WarningLevel',
  'NoWarn',
  'Optimize',
  'OutputType',
  'RootNamespace',
  'AssemblyName',
  'PublishAot',
  'Deterministic',
  'DebugType',
  'DebugSymbols',
  'GenerateDocumentationFile',
]);
const LANGUAGE_VERSIONS = new Set(['latest', 'latestmajor', 'preview', 'default', '14', '14.0']);

interface Conditional {
  row: number;
  /** Whether a branch has already been taken, so that later `#elif` and `#else` branches are skipped. */
  taken: boolean;
  /** Whether the enclosing region is active. */
  parentActive: boolean;
  hasElse: boolean;
  /** How many `#region`s were open at the `#if`, which must close the ones opened inside before its `#endif`. */
  regions: number;
  /** Whether the current branch is active, once an `#elif` or `#else` has chosen it. */
  active?: boolean;
}

/**
 * Runs C#'s preprocessing directives (C# spec §6.5) before the program is parsed: it evaluates `#if`, `#elif`,
 * `#else`, and `#endif` with the symbols `#define` and `#undef` set, and blanks the directives and the skipped lines.
 * Roslyn processes directives while it reads tokens, so a `#` starts a directive only at the start of a line outside
 * comments and strings; the scanner below follows those to know where lines start.
 */
export function preprocess(source: string): PreprocessedSource {
  return new Preprocessor(source).run();
}

/** The state of one run of `preprocess`: the symbols, the open `#if`s and `#region`s, and the errors so far. */
class Preprocessor {
  private readonly lines: string[];
  private readonly symbols = new Set(PREDEFINED_SYMBOLS);
  private readonly options: BuildOptions = {
    allowUnsafe: false,
    checkOverflow: false,
    implicitUsings: true,
    symbols: [],
  };
  private readonly diagnostics: SourceDiagnostic[] = [];
  private readonly conditionals: Conditional[] = [];
  private readonly regions: number[] = [];
  private readonly scanner = new LineScanner();
  /** Whether a token came before, after which `#define`, `#undef`, and `#:` may not come. */
  private tokenSeen = false;

  constructor(source: string) {
    this.lines = source.split('\n');
  }

  run(): PreprocessedSource {
    const { lines, diagnostics } = this;
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row];
      const directive = this.scanner.isInCode ? /^(\s*)#(.*)$/s.exec(line.replace(/\r$/, '')) : undefined;
      if (directive) {
        lines[row] = '';
        this.directive(directive[2], row, directive[1].length === 0);
      } else if (this.isActive()) {
        if (this.scanner.scan(line)) this.tokenSeen = true;
      } else lines[row] = '';
    }
    const end = lines.length;
    if (this.regions.length > 0)
      diagnostics.push({ row: end - 1, message: 'CS1038: #endregion ディレクティブが必要です' });
    if (this.conditionals.length > 0)
      diagnostics.push({ row: end - 1, message: 'CS1027: #endif ディレクティブ が必要です' });
    if (diagnostics.length > 0) throw new CompileError(diagnostics.map(({ row, message }) => ({ row, message })));
    this.options.symbols = [...this.symbols];
    return { text: lines.join('\n'), options: this.options };
  }

  private isActive(): boolean {
    return this.conditionals.length === 0 || isBranchActive(this.conditionals.at(-1) as Conditional);
  }

  private error(row: number, code: string, message: string): void {
    this.diagnostics.push({ row, message: `${code}: ${message}` });
  }

  /** Runs one directive, the text after its `#`; a `#!` on the first line, at its start, is a shebang. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  private directive(body: string, row: number, startsLine: boolean): void {
    if (row === 0 && startsLine && body.startsWith('!')) return;
    const name = /^\s*([a-z]*)/.exec(body)?.[1] ?? '';
    const rest = body.slice(/^\s*[a-z]*\s*/.exec(body)?.[0].length ?? 0);
    if (body.startsWith(':')) {
      if (this.tokenSeen)
        this.error(row, 'CS9297', "ファイル内の最初のトークンの後に '#:' ディレクティブを指定することはできません");
      else if (this.isActive()) applyFileDirective(body.slice(1), row, this.options);
      return;
    }
    if (!this.isActive() && !['if', 'elif', 'else', 'endif', 'region', 'endregion'].includes(name)) return;
    switch (name) {
      case 'define':
      case 'undef': {
        this.defineOrUndefine(name, rest, row);
        return;
      }
      case 'if':
      case 'elif':
      case 'else':
      case 'endif': {
        this.conditional(name, rest, row);
        return;
      }
      case 'region': {
        this.regions.push(row);
        return;
      }
      case 'endregion': {
        if (this.regions.length === 0) this.error(row, 'CS1028', '不適切なプリプロセッサ ディレクティブです');
        else this.regions.pop();
        return;
      }
      case 'error': {
        this.error(row, 'CS1029', `#error: '${rest.trimEnd()}'`);
        return;
      }
      case 'warning':
      case 'line':
      case 'pragma':
      case 'nullable': {
        // Warnings, nullable analysis, and line mapping change only the warnings and the lines that messages cite.
        return;
      }
      default: {
        this.error(row, 'CS1024', 'プリプロセッサ ディレクティブが必要です');
      }
    }
  }

  private defineOrUndefine(name: 'define' | 'undef', rest: string, row: number): void {
    if (this.tokenSeen) {
      this.error(
        row,
        'CS1032',
        'ファイルの最初のトークンの後でプリプロセッサのシンボルの定義または定義の解除を行えませんでした'
      );
      return;
    }
    const symbol = /^([\p{L}_][\p{L}\p{N}_]*)\s*(\/\/.*)?$/u.exec(rest.trimEnd());
    if (!symbol || symbol[1] === 'true' || symbol[1] === 'false') {
      this.error(row, 'CS1001', '識別子がありません');
      return;
    }
    if (name === 'define') this.symbols.add(symbol[1]);
    else this.symbols.delete(symbol[1]);
  }

  /** `#if`, `#elif`, `#else`, and `#endif`, which choose the branch whose lines stay. */
  private conditional(name: 'if' | 'elif' | 'else' | 'endif', rest: string, row: number): void {
    const { conditionals, diagnostics, symbols } = this;
    if (name === 'if') {
      const parentActive = this.isActive();
      const value = parentActive ? evaluateCondition(rest, row, symbols, diagnostics) : false;
      conditionals.push({ row, taken: value, parentActive, hasElse: false, regions: this.regions.length });
      return;
    }
    if (name === 'endif') {
      this.endConditional(rest, row);
      return;
    }
    const current = conditionals.at(-1);
    if (!current || current.hasElse) {
      this.error(row, 'CS1028', '不適切なプリプロセッサ ディレクティブです');
      return;
    }
    const isCandidate = current.parentActive && !current.taken;
    if (name === 'else') {
      current.hasElse = true;
      current.active = isCandidate;
      checkLineEnd(rest, row, diagnostics);
    } else current.active = isCandidate ? evaluateCondition(rest, row, symbols, diagnostics) : false;
    if (current.active) current.taken = true;
  }

  private endConditional(rest: string, row: number): void {
    const closed = this.conditionals.pop();
    if (!closed) {
      this.error(row, 'CS1028', '不適切なプリプロセッサ ディレクティブです');
      return;
    }
    if (this.regions.length > closed.regions) {
      this.error(row, 'CS1038', '#endregion ディレクティブが必要です');
      this.regions.length = closed.regions;
    }
    checkLineEnd(rest, row, this.diagnostics);
  }
}

function isBranchActive(conditional: Conditional): boolean {
  if (conditional.active !== undefined) return conditional.active;
  return conditional.parentActive && conditional.taken;
}

/**
 * Applies a `#:` directive of a file-based app. Only `#:property` sets what the compiler does; the others bring in
 * NuGet packages, other projects, or another SDK, which a run cannot reach.
 */
// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
function applyFileDirective(text: string, row: number, options: BuildOptions): void {
  const [kind, ...parts] = text.trim().split(/\s+/);
  const value = parts.join(' ');
  if (kind === 'package' || kind === 'project' || kind === 'sdk')
    unsupported({ row, column: 0 }, `\`#:${kind}\` ディレクティブ（外部のパッケージ・プロジェクト・SDK）`);
  if (kind !== 'property')
    throw new CompileError([{ row, message: `エラー: 認識されないディレクティブ '${kind}' です。` }]);
  const separator = value.indexOf('=');
  if (separator === -1) {
    throw new CompileError([
      {
        row,
        message:
          "エラー: プロパティ ディレクティブには、'#:property PropertyName=PropertyValue' のように '=' で区切られた 2 つの部分が必要です。",
      },
    ]);
  }
  const name = value.slice(0, separator).trim();
  const setting = value.slice(separator + 1).trim();
  const flag = setting.toLowerCase() === 'true';
  switch (name) {
    case 'AllowUnsafeBlocks': {
      options.allowUnsafe = flag;
      return;
    }
    case 'CheckForOverflowUnderflow': {
      options.checkOverflow = flag;
      return;
    }
    case 'ImplicitUsings': {
      options.implicitUsings = ['enable', 'true'].includes(setting.toLowerCase());
      return;
    }
    case 'LangVersion': {
      if (LANGUAGE_VERSIONS.has(setting.toLowerCase())) return;
      break;
    }
    default: {
      if (IGNORED_PROPERTIES.has(name)) return;
    }
  }
  unsupported({ row, column: 0 }, `\`#:property ${name}=${setting}\``);
}

function checkLineEnd(rest: string, row: number, diagnostics: SourceDiagnostic[]): void {
  const trimmed = rest.trimEnd();
  if (trimmed !== '' && !trimmed.startsWith('//'))
    diagnostics.push({ row, message: 'CS1025: 単一行コメントか行末が必要です' });
}

/** Evaluates a directive's condition (C# spec §6.5.3), reporting a malformed one as Roslyn does. */
function evaluateCondition(
  text: string,
  row: number,
  symbols: ReadonlySet<string>,
  diagnostics: SourceDiagnostic[]
): boolean {
  const tokens: string[] = [];
  const pattern = /\s*(\/\/.*$|\|\||&&|==|!=|[!()]|[\p{L}_][\p{L}\p{N}_]*|\S)/uy;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[1].startsWith('//')) break;
    tokens.push(match[1]);
  }
  try {
    return new ConditionParser(tokens, row, symbols).parse();
  } catch (error) {
    if (!(error instanceof DirectiveError)) throw error;
    diagnostics.push(error.diagnostic);
    return false;
  }
}

/** A recursive-descent parser of a directive's condition: `||`, then `&&`, then `==` and `!=`, then `!` and `()`. */
class ConditionParser {
  private index = 0;

  constructor(
    private readonly tokens: string[],
    private readonly row: number,
    private readonly symbols: ReadonlySet<string>
  ) {}

  parse(): boolean {
    const value = this.or();
    if (this.index < this.tokens.length) this.fail('CS1025', '単一行コメントか行末が必要です');
    return value;
  }

  private fail(code: string, message: string): never {
    throw new DirectiveError({ row: this.row, message: `${code}: ${message}` });
  }

  private next(): string | undefined {
    return this.tokens[this.index];
  }

  private or(): boolean {
    let value = this.and();
    while (this.next() === '||') {
      this.index++;
      value = this.and() || value;
    }
    return value;
  }

  private and(): boolean {
    let value = this.equality();
    while (this.next() === '&&') {
      this.index++;
      value = this.equality() && value;
    }
    return value;
  }

  private equality(): boolean {
    let value = this.primary();
    while (this.next() === '==' || this.next() === '!=') {
      const isEqual = this.tokens[this.index++] === '==';
      value = isEqual ? value === this.primary() : value !== this.primary();
    }
    return value;
  }

  private primary(): boolean {
    const token = this.next();
    if (token === undefined) return this.fail('CS1517', '無効なプリプロセッサの式です');
    this.index++;
    if (token === '!') return !this.primary();
    if (token === '(') {
      const value = this.or();
      if (this.next() !== ')') return this.fail('CS1026', ') が必要です');
      this.index++;
      return value;
    }
    if (token === 'true' || token === 'false') return token === 'true';
    if (/^[\p{L}_]/u.test(token)) return this.symbols.has(token);
    this.index--;
    return this.fail('CS1517', '無効なプリプロセッサの式です');
  }
}

class DirectiveError extends Error {
  constructor(readonly diagnostic: SourceDiagnostic) {
    super(diagnostic.message);
  }
}

/** What a multi-line token the scanner is inside expects next. */
type ScanState =
  | { kind: 'code'; braces: number }
  | { kind: 'blockComment' }
  | { kind: 'verbatim'; interpolated: boolean }
  | { kind: 'raw'; quotes: number; dollars: number }
  | { kind: 'regular'; interpolated: boolean };

/**
 * Follows the comments and strings that may span lines, so that `preprocess` knows which lines start in code, where
 * `#` begins a directive. An interpolation's hole is code inside a string, which the scanner nests as a stack.
 */
class LineScanner {
  private readonly stack: ScanState[] = [{ kind: 'code', braces: 0 }];

  get isInCode(): boolean {
    return this.stack.length === 1;
  }

  /** Scans a line, returning whether it holds a token, not just whitespace and comments. */
  scan(line: string): boolean {
    let hasToken = false;
    let index = 0;
    while (index < line.length) {
      const state = this.stack.at(-1) as ScanState;
      if (state.kind === 'code') {
        const step = this.scanCode(line, index, state);
        if (step === undefined) return hasToken;
        hasToken ||= step.isToken;
        index = step.index;
      } else if (state.kind === 'blockComment') {
        const end = line.indexOf('*/', index);
        if (end === -1) return hasToken;
        this.stack.pop();
        index = end + 2;
      } else index = state.kind === 'raw' ? this.scanRaw(line, index, state) : this.scanString(line, index, state);
    }
    // A regular string or character cannot go on past its line.
    const last = this.stack.at(-1) as ScanState;
    if (last.kind === 'regular') this.stack.pop();
    return hasToken;
  }

  /** One step in code: whitespace, a comment's start, or a token; undefined when a line comment ends the line. */
  private scanCode(
    line: string,
    index: number,
    state: Extract<ScanState, { kind: 'code' }>
  ): { index: number; isToken: boolean } | undefined {
    if (/\s/.test(line[index])) return { index: index + 1, isToken: false };
    if (line.startsWith('//', index)) return undefined;
    if (line.startsWith('/*', index)) {
      this.stack.push({ kind: 'blockComment' });
      return { index: index + 2, isToken: false };
    }
    return { index: this.scanCodeToken(line, index, state), isToken: true };
  }

  /** One step in a regular or verbatim string: an escape, a doubled quote, its end, or an interpolation's hole. */
  private scanString(line: string, index: number, state: Extract<ScanState, { kind: 'verbatim' | 'regular' }>): number {
    const char = line[index];
    if (state.kind === 'regular' && char === '\\') return index + 2;
    if (char === '"') {
      if (state.kind === 'verbatim' && line[index + 1] === '"') return index + 2;
      this.stack.pop();
      return index + 1;
    }
    if (state.interpolated && char === '{') {
      if (line[index + 1] === '{') return index + 2;
      this.stack.push({ kind: 'code', braces: 0 });
    }
    return index + 1;
  }

  /** One step in a raw string: its closing quotes, an interpolation's hole, or another character. */
  private scanRaw(line: string, index: number, state: Extract<ScanState, { kind: 'raw' }>): number {
    if (line.startsWith('"'.repeat(state.quotes), index)) {
      this.stack.pop();
      return index + state.quotes;
    }
    if (state.dollars > 0 && line.startsWith('{'.repeat(state.dollars), index)) {
      this.stack.push({ kind: 'code', braces: 0 });
      return index + state.dollars;
    }
    return index + 1;
  }

  private scanCodeToken(line: string, index: number, state: Extract<ScanState, { kind: 'code' }>): number {
    const prefix = /^(\$*)(@?)(\$*)("+)/.exec(line.slice(index));
    if (prefix) {
      const dollars = prefix[1].length + prefix[3].length;
      const quotes = prefix[4].length;
      if (!prefix[2] && quotes >= 3) {
        this.stack.push({ kind: 'raw', quotes, dollars });
        return index + prefix[0].length;
      }
      this.stack.push({ kind: prefix[2] ? 'verbatim' : 'regular', interpolated: dollars > 0 });
      return index + prefix[0].length - quotes + 1;
    }
    const char = line[index];
    if (char === "'") {
      const end = /^'(\\.|[^'\\])*'?/.exec(line.slice(index));
      return index + (end?.[0].length ?? 1);
    }
    if (char === '{') state.braces++;
    else if (char === '}') {
      if (state.braces === 0 && this.stack.length > 1) {
        this.stack.pop();
        return index + 1;
      }
      state.braces--;
    }
    return index + 1;
  }
}
