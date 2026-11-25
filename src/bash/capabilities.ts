import { isIdentifier } from './associativeTable';
import type { Assignment } from './ast';
import { EXTERNAL_COMMANDS } from './externalCommands';
import { quoteReusable } from './quoting';
import { UnsupportedFeatureError, unsupportedMessage } from './unsupported';

/** Variable attribute flags recognized by the supported declaration surface and listed by `declare -p`. */
export type Attribute = 'a' | 'A' | 'i' | 'n' | 'r' | 'x';

/** Canonical display order of variable attribute flags for `declare -p` and `${x@a}`. */
export const ATTRIBUTE_ORDER: readonly Attribute[] = ['a', 'A', 'i', 'n', 'r', 'x'];

/** Supported dynamic variables computed on read through store-owned descriptors. */
export const DYNAMIC_VARIABLES = new Set(['RANDOM', 'LINENO', 'FUNCNAME']);

export const SCALAR_DYNAMIC_VARIABLES = new Set(['RANDOM', 'LINENO']);

/** Deferred Bash internal variables whose reads, writes, declarations, tests, and unsets are rejected. */
export const UNSUPPORTED_SPECIAL_VARIABLES = new Set(['PIPESTATUS', 'BASH_LINENO', 'BASH_SOURCE', 'BASH_SUBSHELL']);

/** Special variables whose user writes, unsets, and declarations are rejected except scalar `RANDOM` seeding. */
export const SPECIAL_MUTATION_BLOCKED = new Set([
  ...DYNAMIC_VARIABLES,
  'BASH_REMATCH',
  ...UNSUPPORTED_SPECIAL_VARIABLES,
]);

/** Host environment variables absent in the browser grading sandbox. */
export const ENVIRONMENT_VARIABLES = new Set([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'TMPDIR',
  'HOSTNAME',
  'HOSTTYPE',
  'OSTYPE',
  'MACHTYPE',
  'UID',
  'EUID',
  'PPID',
  'BASHPID',
  'BASH',
  'SHLVL',
  'SECONDS',
  'BASH_MONOSECONDS',
  'EPOCHSECONDS',
  'EPOCHREALTIME',
  'SRANDOM',
  'GROUPS',
  'DIRSTACK',
  'MAIL',
  'MAILCHECK',
  'BASH_ARGV',
  'BASH_ARGC',
  'BASH_ARGV0',
  'BASH_COMMAND',
  'BASH_EXECUTION_STRING',
  'BASHOPTS',
  'SHELLOPTS',
  'BASH_ALIASES',
  'BASH_CMDS',
  'BASH_LOADABLES_PATH',
  'COMP_WORDBREAKS',
  'HISTCMD',
  'COLUMNS',
  'LINES',
  'EDITOR',
  'PS1',
  'PS2',
  '_',
]);

export const DECLARATION_BUILTIN_NAMES = new Set(['declare', 'typeset', 'local', 'readonly', 'export']);

export const DECLARATION_OPTIONS: Record<string, string> = {
  declare: 'aAcfFgiIlnrtuxp',
  typeset: 'aAcfFgiIlnrtuxp',
  local: 'aAcfFgiIlnrtuxp',
  readonly: 'aAfp',
  export: 'fnp',
};

export const FILE_TEST_OPERATORS = new Set([
  '-a',
  '-b',
  '-c',
  '-d',
  '-e',
  '-f',
  '-g',
  '-h',
  '-k',
  '-p',
  '-r',
  '-s',
  '-u',
  '-w',
  '-x',
  '-G',
  '-L',
  '-N',
  '-O',
  '-S',
  '-nt',
  '-ot',
  '-ef',
]);

export type UnsupportedSyntaxKind =
  | 'background'
  | 'pipeline'
  | 'subshell'
  | 'coproc'
  | 'time'
  | 'functionRedirect'
  | 'heredoc'
  | 'herestring'
  | 'redirect'
  | 'select'
  | 'subshellFunctionBody'
  | 'processSubstitution'
  | 'extglob'
  | 'currentShellSubstitution';

const UNSUPPORTED_SYNTAX_LABELS: Record<Exclude<UnsupportedSyntaxKind, 'redirect'>, string> = {
  background: 'バックグラウンド実行（&）',
  pipeline: 'パイプ（|）',
  subshell: 'サブシェル（( ... )）',
  coproc: 'coproc',
  time: 'time',
  functionRedirect: '関数の定義に付けたリダイレクト',
  heredoc: 'ヒアドキュメント（<<）',
  herestring: 'ヒアストリング（<<<）',
  select: 'select（標準入力を読む）',
  subshellFunctionBody: 'サブシェルを本体にした関数（f() ( ... )）',
  processSubstitution: 'プロセス置換（<( ... )）',
  extglob: '拡張パターン（@( ... ) など）',
  currentShellSubstitution: '現在のシェルで実行するコマンド置換（${ ...; }）',
};

/** Formats static unsupported-syntax diagnostics from one declarative catalog for `Converter`. */
export function unsupportedSyntaxMessage(kind: UnsupportedSyntaxKind, detail = ''): string {
  if (kind === 'redirect') return unsupportedMessage(`リダイレクト（${detail}）`);
  return unsupportedMessage(UNSUPPORTED_SYNTAX_LABELS[kind]);
}

export const UNSUPPORTED_BUILTIN_FEATURES: Record<string, string> = {
  read: '標準入力（read）',
  mapfile: '標準入力（mapfile）',
  readarray: '標準入力（readarray）',
  eval: '文字列の評価（eval）',
  source: '別ファイルの読み込み（source）',
  '.': '別ファイルの読み込み（.）',
  exec: 'exec',
  trap: 'trap',
  wait: 'wait',
  jobs: 'ジョブ制御（jobs）',
  fg: 'ジョブ制御（fg）',
  bg: 'ジョブ制御（bg）',
  kill: 'kill',
  disown: 'disown',
  suspend: 'suspend',
  cd: 'ディレクトリの移動（cd）',
  pwd: 'pwd',
  pushd: 'pushd',
  popd: 'popd',
  dirs: 'dirs',
  umask: 'umask',
  ulimit: 'ulimit',
  times: 'times',
  type: 'type',
  command: 'command',
  builtin: 'builtin',
  caller: 'caller',
  getopts: 'getopts',
  hash: 'hash',
  enable: 'enable',
  help: 'help',
  history: 'history',
  fc: 'fc',
  bind: 'bind',
  alias: 'エイリアス（alias）',
  unalias: 'エイリアス（unalias）',
  complete: 'complete',
  compgen: 'compgen',
  compopt: 'compopt',
  logout: 'logout',
  shopt: 'シェルのオプション（shopt）',
};

export type CommandClassification =
  | { kind: 'function' }
  | { kind: 'declarationBuiltin'; name: string }
  | { kind: 'unsupportedBuiltin'; feature: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'external'; feature: string }
  | { kind: 'notFound' };

/** Classifies a command name in one catalog shared by execution and tracing. */
export function classifyCommandName(
  name: string,
  hasFunction: boolean,
  hasRegularBuiltin: boolean
): CommandClassification {
  if (hasFunction) return { kind: 'function' };
  if (DECLARATION_BUILTIN_NAMES.has(name)) return { kind: 'declarationBuiltin', name };
  if (Object.hasOwn(UNSUPPORTED_BUILTIN_FEATURES, name)) {
    return { kind: 'unsupportedBuiltin', feature: UNSUPPORTED_BUILTIN_FEATURES[name] };
  }
  if (hasRegularBuiltin) return { kind: 'builtin', name };
  if (EXTERNAL_COMMANDS.has(name) || name.includes('/')) {
    return { kind: 'external', feature: `外部コマンド（${name}）` };
  }
  return { kind: 'notFound' };
}

export function rejectUnsupportedFeature(feature: string): never {
  throw new UnsupportedFeatureError(feature);
}

export function rejectUnsupportedHostEnv(name: string): never {
  throw new UnsupportedFeatureError(`環境変数（${name}）`);
}

/** Rejects deferred special variables (`PIPESTATUS`, `BASH_LINENO`, `BASH_SOURCE`, `BASH_SUBSHELL`) on any access. */
export function rejectUnsupportedSpecialVariable(name: string): void {
  if (UNSUPPORTED_SPECIAL_VARIABLES.has(name)) {
    throw new UnsupportedFeatureError(`特殊変数（${name}）`);
  }
}

/** Single read gate for deferred special variables and host environment variables. */
export function rejectUnsupportedVariableRead(name: string): void {
  rejectUnsupportedSpecialVariable(name);
  if (ENVIRONMENT_VARIABLES.has(name)) rejectUnsupportedHostEnv(name);
}

/** Single mutation/unset/declare gate for special and host environment variables (allowing plain scalar `RANDOM` seeding). */
export function rejectUnsupportedVariableMutation(name: string, allowScalarRandomSeed = false): void {
  rejectUnsupportedVariableRead(name);
  if (!SPECIAL_MUTATION_BLOCKED.has(name)) return;
  if (allowScalarRandomSeed && name === 'RANDOM') return;
  throw new UnsupportedFeatureError(`特殊変数（${name}）の変更`);
}

export interface ExistingCellShape {
  readonly kind: 'unset' | 'scalar' | 'indexed' | 'associative';
  readonly attributes: ReadonlySet<Attribute>;
}

/** Enforces that namerefs are declared only via initialized `local -n name=target` inside a function. */
export function rejectUnsupportedNamerefDeclaration(
  builtin: string,
  name: string,
  value: string | undefined,
  inFunction: boolean,
  hasExistingLocal: boolean
): void {
  if (builtin !== 'local' || !inFunction) {
    throw new UnsupportedFeatureError(`関数外・local 以外での名前参照（${builtin} -n）`);
  }
  if (value === undefined) {
    throw new UnsupportedFeatureError(`初期化子のない名前参照（${name}）`);
  }
  if (hasExistingLocal) {
    throw new UnsupportedFeatureError(`既存ローカル変数（${name}）の名前参照化`);
  }
}

/** Enforces that a nameref target names an existing non-nameref whole variable in an enclosing scope. */
export function rejectUnsupportedNamerefTarget(
  name: string,
  target: string,
  outerShape: ExistingCellShape | undefined
): void {
  if (target === '') return;
  if (target.includes('[')) throw new UnsupportedFeatureError(`配列要素への名前参照（${target}）`);
  rejectUnsupportedVariableMutation(target, false);
  if (!isIdentifier(target)) return;
  if (target === name) throw new UnsupportedFeatureError(`自己参照の名前参照（${name}）`);
  if (!outerShape) throw new UnsupportedFeatureError(`未定義変数への名前参照（${target}）`);
  if (outerShape.attributes.has('n')) {
    throw new UnsupportedFeatureError(`多段の名前参照（${name} -> ${target}）`);
  }
}

/** Rejects dereferencing a nameref whose target disappeared or was converted into a nameref. */
export function rejectUnsupportedNamerefDereference(
  name: string,
  target: string,
  targetShape: ExistingCellShape | undefined
): void {
  if (!targetShape || targetShape.attributes.has('n')) {
    throw new UnsupportedFeatureError(`無効または多段の名前参照（${name} -> ${target}）`);
  }
}

export function rejectUnsupportedNamerefShadowing(name: string): never {
  throw new UnsupportedFeatureError(`名前参照先と同名のローカル宣言（${name}）`);
}

export function rejectUnsupportedNamerefMutation(kind: 'for' | 'unset' | 'indirect', name: string): never {
  if (kind === 'for') throw new UnsupportedFeatureError(`名前参照ループ変数（${name}）`);
  if (kind === 'unset') throw new UnsupportedFeatureError(`名前参照（${name}）の unset`);
  throw new UnsupportedFeatureError(`名前参照に対する間接展開（\${!${name}}）`);
}

export function rejectSelfReferencingCompound(name: string): never {
  throw new UnsupportedFeatureError(`複合代入（${name}=(...)）における同一変数の参照・変更`);
}

export function rejectListInScalarContext(expansionText: string): never {
  throw new UnsupportedFeatureError(`パラメータ展開の引数や添字の中でのリスト展開（${expansionText}）`);
}

export function rejectQuotedSubscriptExpansion(chunk: string): void {
  if (/['"\\[\]]/.test(chunk)) {
    throw new UnsupportedFeatureError(`添字や算術式への展開結果に含まれる引用符・括弧（${chunk}）`);
  }
}

export function rejectDynamicSubscriptSyntax(raw: string): void {
  if (/[$`'"\\]/.test(raw)) {
    throw new UnsupportedFeatureError(`実行時に組み立てた添字内の引用符・展開（${raw}）`);
  }
}

export function rejectUnsupportedDeclarationPrefix(builtin: string): never {
  throw new UnsupportedFeatureError(`宣言ビルトインへの前置代入（${builtin}）`);
}

export function rejectUnsupportedShadowedCompound(builtin: string): never {
  throw new UnsupportedFeatureError(`関数で上書きされた宣言ビルトイン（${builtin}）での複合代入`);
}

export function rejectUnsupportedDeclarationListing(builtin: string): never {
  throw new UnsupportedFeatureError(`${builtin} の変数の一覧`);
}

const UNSUPPORTED_DECLARE_SET_OPTIONS = new Set(['I', 'c', 't', 'l', 'u']);

/** Enforces the declaration option capability boundary before any operand mutates state. */
export function rejectUnsupportedDeclarationOptions(
  builtin: string,
  set: ReadonlySet<string>,
  unset: ReadonlySet<string>,
  hasPlusOption: boolean
): void {
  if (set.has('f') || set.has('F') || unset.has('f') || unset.has('F')) {
    throw new UnsupportedFeatureError(`${builtin} -f（関数の一覧）`);
  }
  if (builtin === 'export' && unset.has('x') && !hasPlusOption) {
    throw new UnsupportedFeatureError('export -n（エクスポート属性の解除）');
  }
  if (hasPlusOption || unset.size > 0) {
    throw new UnsupportedFeatureError(`${builtin} の + オプション（属性解除）`);
  }
  for (const flag of UNSUPPORTED_DECLARE_SET_OPTIONS) {
    if (set.has(flag)) throw new UnsupportedFeatureError(`${builtin} -${flag}`);
  }
  if (set.has('n') && [...set].some((flag) => flag !== 'n')) {
    throw new UnsupportedFeatureError(`${builtin} -n と他オプションの組み合わせ`);
  }
}

export interface DeclarationOperandFlags {
  readonly isSubscripted: boolean;
  readonly isCompound: boolean;
  readonly append: boolean;
  readonly hasScalarValue: boolean;
  readonly hasEnclosingTempBinding: boolean;
  readonly existing?: ExistingCellShape;
}

/** Rejects excluded declaration operands, enclosing temp-scope bindings, and shape/type-changing redeclarations. */
export function rejectUnsupportedDeclarationOperand(
  builtin: string,
  name: string,
  effectiveSet: ReadonlySet<string>,
  flags: DeclarationOperandFlags
): void {
  rejectUnsupportedVariableMutation(name, false);
  if (flags.isSubscripted) {
    throw new UnsupportedFeatureError(`${builtin} での配列要素指定（${name}）`);
  }
  if (effectiveSet.has('n') && (flags.isCompound || flags.append)) {
    throw new UnsupportedFeatureError(`${builtin} -n での複合代入・追記`);
  }
  if (flags.hasEnclosingTempBinding) {
    throw new UnsupportedFeatureError(`前置代入された変数（${name}）の宣言`);
  }
  if (flags.existing) rejectShapeChangingRedeclaration(name, effectiveSet, flags);
}

function rejectShapeChangingRedeclaration(
  name: string,
  effectiveSet: ReadonlySet<string>,
  flags: DeclarationOperandFlags
): void {
  const existing = flags.existing as ExistingCellShape;
  if (existing.attributes.has('n') !== effectiveSet.has('n')) {
    throw new UnsupportedFeatureError(`名前参照（${name}）と通常変数の相互変換`);
  }
  const existingIsIndexed = existing.kind === 'indexed' || existing.attributes.has('a');
  const existingIsAssoc = existing.kind === 'associative' || existing.attributes.has('A');
  const wantsAssoc = effectiveSet.has('A');
  const wantsIndexed = effectiveSet.has('a') || (flags.isCompound && !wantsAssoc && !existingIsAssoc);
  if ((wantsIndexed && !existingIsIndexed) || (wantsAssoc && !existingIsAssoc)) {
    throw new UnsupportedFeatureError(`既存変数（${name}）の型・配列変換`);
  }
  if (effectiveSet.has('i') && !existing.attributes.has('i')) {
    throw new UnsupportedFeatureError(`既存変数（${name}）への整数属性の追加`);
  }
  if ((existingIsIndexed || existingIsAssoc) && flags.hasScalarValue) {
    throw new UnsupportedFeatureError(`配列変数（${name}）へのスカラー宣言代入`);
  }
}

/** Rejects command-prefix bindings onto non-plain-scalar targets. */
export function rejectUnsupportedPrefixAssignment(
  assignment: Assignment,
  existingAttributes: ReadonlySet<Attribute> | undefined,
  existingIsArray: boolean
): void {
  if (assignment.subscript !== undefined || assignment.array !== undefined) {
    throw new UnsupportedFeatureError(`配列への前置代入（${assignment.name}）`);
  }
  rejectUnsupportedVariableMutation(assignment.name, false);
  if (!existingAttributes && !existingIsArray) return;
  if (existingIsArray || existingAttributes?.has('n') || existingAttributes?.has('i')) {
    throw new UnsupportedFeatureError(`属性付き変数・配列への前置代入（${assignment.name}）`);
  }
}

export function rejectUnsupportedTestOperator(operator: string): never {
  if (operator === '-o') throw new UnsupportedFeatureError('シェルのオプションを調べる演算子（-o）');
  if (operator === '-t') throw new UnsupportedFeatureError('端末を調べる演算子（-t）');
  throw new UnsupportedFeatureError(`ファイルを調べる演算子（${operator}）`);
}

export function rejectUnsupportedPrintfConversion(conversion: 'n' | '('): never {
  if (conversion === 'n') throw new UnsupportedFeatureError('printf の %n');
  throw new UnsupportedFeatureError('printf の時刻の書式（%(...)T）');
}

export function rejectUnsupportedSetArgs(firstArg?: string): never {
  if (firstArg === undefined) throw new UnsupportedFeatureError('set の変数の一覧');
  throw new UnsupportedFeatureError(`シェルのオプション（set ${firstArg}）`);
}

export function rejectUnsupportedBracketClass(): never {
  throw new UnsupportedFeatureError('照合要素・等価クラス（[. .] / [= =]）');
}

export type UnsupportedExpansionKind = 'tilde' | 'pid' | 'bgPid' | 'initialLastArg' | 'extglob' | 'promptTransform';

const UNSUPPORTED_EXPANSION_LABELS: Record<UnsupportedExpansionKind, string> = {
  tilde: '~ の展開',
  pid: 'プロセス番号（$$）',
  bgPid: 'バックグラウンドのプロセス番号（$!）',
  initialLastArg: 'Bash のパス（最初の $_）',
  extglob: '拡張パターン（@( ... ) など）',
  promptTransform: 'プロンプトの展開（${x@P}）',
};

export function rejectUnsupportedExpansion(kind: UnsupportedExpansionKind): never {
  throw new UnsupportedFeatureError(UNSUPPORTED_EXPANSION_LABELS[kind]);
}

export function rejectUnsupportedPathnameExpansion(word: string): never {
  throw new UnsupportedFeatureError(
    `ファイル名の展開（引用符で囲まれていない * ? [ ]。文字として使うときは ${quoteReusable(word)} のように引用符で囲む）`
  );
}

export function rejectUnsupportedPrefixListing(prefix: string): never {
  throw new UnsupportedFeatureError(`シェルの変数の一覧（\${!${prefix}*}）`);
}
