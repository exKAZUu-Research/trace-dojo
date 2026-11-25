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
  const lines = source.split('\n');
  const symbols = new Set(PREDEFINED_SYMBOLS);
  const options: BuildOptions = { allowUnsafe: false, checkOverflow: false, implicitUsings: true };
  const diagnostics: SourceDiagnostic[] = [];
  const conditionals: Conditional[] = [];
  const regions: number[] = [];
  const scanner = new LineScanner();
  let tokenSeen = false;
  const isActive = (): boolean => conditionals.length === 0 || isBranchActive(conditionals.at(-1) as Conditional);
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const directive = scanner.isInCode ? /^(\s*)#(.*)$/s.exec(line.replace(/\r$/, '')) : undefined;
    if (!directive) {
      if (isActive()) {
        if (scanner.scan(line)) tokenSeen = true;
      } else {
        lines[row] = '';
      }
      continue;
    }
    lines[row] = '';
    const column = directive[1].length + 1;
    const body = directive[2];
    if (row === 0 && column === 1 && body.startsWith('!')) continue;
    const name = /^\s*([a-z]*)/.exec(body)?.[1] ?? '';
    const restColumn = column + (/^\s*[a-z]*\s*/.exec(body)?.[0].length ?? 0);
    const rest = body.slice(restColumn - column);
    const error = (code: string, message: string, _column = column - 1): void => {
      diagnostics.push({ row, message: `${code}: ${message}` });
    };
    if (body.startsWith(':')) {
      if (tokenSeen)
        error('CS9297', "ファイル内の最初のトークンの後に '#:' ディレクティブを指定することはできません", column);
      else if (isActive()) applyFileDirective(body.slice(1), row, options);
      continue;
    }
    if (!isActive() && !['if', 'elif', 'else', 'endif', 'region', 'endregion'].includes(name)) continue;
    switch (name) {
      case 'define':
      case 'undef': {
        if (tokenSeen) {
          error(
            'CS1032',
            'ファイルの最初のトークンの後でプリプロセッサのシンボルの定義または定義の解除を行えませんでした',
            column
          );
          break;
        }
        const symbol = /^([\p{L}_][\p{L}\p{N}_]*)\s*(\/\/.*)?$/u.exec(rest.trimEnd());
        if (!symbol || symbol[1] === 'true' || symbol[1] === 'false') {
          error('CS1001', '識別子がありません', restColumn - 1);
          break;
        }
        if (name === 'define') symbols.add(symbol[1]);
        else symbols.delete(symbol[1]);
        break;
      }
      case 'if': {
        const parentActive = isActive();
        const value = parentActive ? evaluateCondition(rest, row, restColumn - 1, symbols, diagnostics) : false;
        conditionals.push({
          row,
          taken: value,
          parentActive,
          hasElse: false,
          regions: regions.length,
        });
        break;
      }
      case 'elif':
      case 'else': {
        const current = conditionals.at(-1);
        if (!current || current.hasElse) {
          error('CS1028', '不適切なプリプロセッサ ディレクティブです');
          break;
        }
        if (name === 'else') {
          current.hasElse = true;
          current.active = current.parentActive && !current.taken;
          checkLineEnd(rest, row, restColumn - 1, diagnostics);
        } else {
          const value =
            current.parentActive && !current.taken
              ? evaluateCondition(rest, row, restColumn - 1, symbols, diagnostics)
              : false;
          current.active = value;
        }
        if (current.active) current.taken = true;
        break;
      }
      case 'endif': {
        if (conditionals.length === 0) error('CS1028', '不適切なプリプロセッサ ディレクティブです');
        else {
          const { regions: openAtIf } = conditionals.pop() as Conditional;
          if (regions.length > openAtIf) {
            error('CS1038', '#endregion ディレクティブが必要です');
            regions.length = openAtIf;
          }
          checkLineEnd(rest, row, restColumn - 1, diagnostics);
        }
        break;
      }
      case 'region': {
        regions.push(row);
        break;
      }
      case 'endregion': {
        if (regions.length === 0) error('CS1028', '不適切なプリプロセッサ ディレクティブです');
        else regions.pop();
        break;
      }
      case 'error': {
        error('CS1029', `#error: '${rest.trimEnd()}'`, restColumn - 1);
        break;
      }
      case 'warning':
      case 'line':
      case 'pragma':
      case 'nullable': {
        // Warnings, nullable analysis, and line mapping change only the warnings and the lines that messages cite.
        break;
      }
      default: {
        error('CS1024', 'プリプロセッサ ディレクティブが必要です', column);
      }
    }
  }
  const end = lines.length;
  if (regions.length > 0) diagnostics.push({ row: end - 1, message: 'CS1038: #endregion ディレクティブが必要です' });
  if (conditionals.length > 0) diagnostics.push({ row: end - 1, message: 'CS1027: #endif ディレクティブ が必要です' });
  if (diagnostics.length > 0) throw new CompileError(diagnostics.map(({ row, message }) => ({ row, message })));
  return { text: lines.join('\n'), options };
}

function isBranchActive(conditional: Conditional): boolean {
  if (conditional.active !== undefined) return conditional.active;
  return conditional.parentActive && conditional.taken;
}

/**
 * Applies a `#:` directive of a file-based app. Only `#:property` sets what the compiler does; the others bring in
 * NuGet packages, other projects, or another SDK, which a run cannot reach.
 */
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

function checkLineEnd(rest: string, row: number, column: number, diagnostics: SourceDiagnostic[]): void {
  const trimmed = rest.trimEnd();
  if (trimmed !== '' && !trimmed.startsWith('//'))
    diagnostics.push({ row, message: 'CS1025: 単一行コメントか行末が必要です' });
}

/** Evaluates a directive's condition (C# spec §6.5.3), reporting a malformed one as Roslyn does. */
function evaluateCondition(
  text: string,
  row: number,
  column: number,
  symbols: ReadonlySet<string>,
  diagnostics: SourceDiagnostic[]
): boolean {
  const tokens: { text: string; column: number }[] = [];
  const pattern = /\s*(\/\/.*$|\|\||&&|==|!=|[!()]|[\p{L}_][\p{L}\p{N}_]*|\S)/uy;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[1].startsWith('//')) break;
    tokens.push({
      text: match[1],
      column: column + match.index + match[0].length - match[1].length,
    });
  }
  let index = 0;
  const fail = (code: string, message: string): never => {
    throw new DirectiveError({ row, message: `${code}: ${message}` });
  };
  const primary = (): boolean => {
    const token = tokens[index];
    if (!token) return fail('CS1517', '無効なプリプロセッサの式です');
    index++;
    if (token.text === '!') return !primary();
    if (token.text === '(') {
      const value = or();
      if (tokens[index]?.text !== ')') return fail('CS1026', ') が必要です');
      index++;
      return value;
    }
    if (token.text === 'true') return true;
    if (token.text === 'false') return false;
    if (/^[\p{L}_]/u.test(token.text)) return symbols.has(token.text);
    index--;
    return fail('CS1517', '無効なプリプロセッサの式です');
  };
  const equality = (): boolean => {
    let value = primary();
    while (tokens[index]?.text === '==' || tokens[index]?.text === '!=') {
      const isEqual = tokens[index++].text === '==';
      value = isEqual ? value === primary() : value !== primary();
    }
    return value;
  };
  const and = (): boolean => {
    let value = equality();
    while (tokens[index]?.text === '&&') {
      index++;
      value = equality() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (tokens[index]?.text === '||') {
      index++;
      value = and() || value;
    }
    return value;
  };
  try {
    const value = or();
    if (index < tokens.length) fail('CS1025', '単一行コメントか行末が必要です');
    return value;
  } catch (error) {
    if (!(error instanceof DirectiveError)) throw error;
    diagnostics.push(error.diagnostic);
    return false;
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
  // code-gauge-allow functionCognitiveComplexity -- A small lexer, with one branch per kind of token that spans lines.
  scan(line: string): boolean {
    let hasToken = false;
    let index = 0;
    while (index < line.length) {
      const state = this.stack.at(-1) as ScanState;
      const char = line[index];
      switch (state.kind) {
        case 'blockComment': {
          const end = line.indexOf('*/', index);
          if (end === -1) return hasToken;
          this.stack.pop();
          index = end + 2;
          break;
        }
        case 'verbatim':
        case 'regular': {
          if (state.kind === 'regular' && char === '\\') index += 2;
          else if (char === '"') {
            if (state.kind === 'verbatim' && line[index + 1] === '"') index += 2;
            else {
              this.stack.pop();
              index++;
            }
          } else if (state.interpolated && char === '{') {
            if (line[index + 1] === '{') index += 2;
            else {
              this.stack.push({ kind: 'code', braces: 0 });
              index++;
            }
          } else index++;
          break;
        }
        case 'raw': {
          const quotes = '"'.repeat(state.quotes);
          if (line.startsWith(quotes, index)) {
            this.stack.pop();
            index += state.quotes;
          } else if (state.dollars > 0 && line.startsWith('{'.repeat(state.dollars), index)) {
            index += state.dollars;
            this.stack.push({ kind: 'code', braces: 0 });
          } else index++;
          break;
        }
        case 'code': {
          if (/\s/.test(char)) {
            index++;
            break;
          }
          if (line.startsWith('//', index)) return hasToken;
          if (line.startsWith('/*', index)) {
            this.stack.push({ kind: 'blockComment' });
            index += 2;
            break;
          }
          hasToken = true;
          index = this.scanCodeToken(line, index, state);
        }
      }
    }
    // A regular string or character cannot go on past its line.
    const last = this.stack.at(-1) as ScanState;
    if (last.kind === 'regular') this.stack.pop();
    return hasToken;
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
