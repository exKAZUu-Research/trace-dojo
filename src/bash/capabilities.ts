import type { Assignment } from './ast';
import { EXTERNAL_COMMANDS } from './externalCommands';
import { UnsupportedFeatureError } from './unsupported';

/** Variable attribute flags recognized by `declare` and listed by `declare -p`. */
export type Attribute = 'a' | 'A' | 'i' | 'n' | 'r' | 't' | 'x' | 'c' | 'l' | 'u';

/** Canonical display order of variable attribute flags for `declare -p` and `${x@a}`. */
export const ATTRIBUTE_ORDER: readonly Attribute[] = ['a', 'A', 'i', 'n', 'r', 't', 'x', 'c', 'l', 'u'];

/** Dynamic variables computed on read through store-owned descriptors. */
export const DYNAMIC_VARIABLES = new Set([
  'RANDOM',
  'LINENO',
  'FUNCNAME',
  'BASH_LINENO',
  'BASH_SOURCE',
  'BASH_SUBSHELL',
  'PIPESTATUS',
]);

export const SCALAR_DYNAMIC_VARIABLES = new Set(['RANDOM', 'LINENO', 'BASH_SUBSHELL']);

/** Special variables whose user writes, unsets, and declarations are rejected except scalar `RANDOM` seeding. */
export const SPECIAL_MUTATION_BLOCKED = new Set([...DYNAMIC_VARIABLES, 'BASH_REMATCH']);

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

/** Rejects special/dynamic variable mutations except plain scalar `RANDOM` seeding. */
export function rejectSpecialVariableMutation(name: string, allowScalarRandomSeed = false): void {
  if (!SPECIAL_MUTATION_BLOCKED.has(name)) return;
  if (allowScalarRandomSeed && name === 'RANDOM') return;
  throw new UnsupportedFeatureError(`特殊変数（${name}）の変更`);
}

/** Rejects nameref targets that contain element designators or name special/unread-host-environment variables. */
export function rejectUnsupportedNamerefTarget(target: string, isUnreadHostEnv: (name: string) => boolean): void {
  if (target === '') return;
  if (target.includes('[')) throw new UnsupportedFeatureError(`配列要素への名前参照（${target}）`);
  if (SPECIAL_MUTATION_BLOCKED.has(target)) {
    throw new UnsupportedFeatureError(`特殊変数への名前参照（${target}）`);
  }
  if (isUnreadHostEnv(target)) {
    throw new UnsupportedFeatureError(`環境変数（${target}）`);
  }
}

const UNSUPPORTED_DECLARE_SET_OPTIONS = new Set(['I', 'c', 't']);

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

/** Rejects excluded declaration operand combinations (`-g` with subscripts/namerefs, nameref conversions, special targets). */
export function rejectUnsupportedDeclarationOperand(
  builtin: string,
  name: string,
  options: ReadonlySet<string>,
  flags: { isSubscripted: boolean; isCompound: boolean; append: boolean; existingIsNameref: boolean }
): void {
  rejectSpecialVariableMutation(name, false);
  if (options.has('n') && (flags.isSubscripted || flags.isCompound || flags.append)) {
    throw new UnsupportedFeatureError(`${builtin} -n での配列・複合代入・追記`);
  }
  if (options.has('g') && flags.isSubscripted) {
    throw new UnsupportedFeatureError(`${builtin} -g での配列要素指定`);
  }
  if (flags.existingIsNameref && !options.has('n')) {
    throw new UnsupportedFeatureError(`名前参照（${name}）への宣言・属性変更`);
  }
}

/** Rejects command-prefix bindings before declaration builtins or onto non-plain-scalar targets. */
export function rejectUnsupportedPrefixAssignment(
  assignment: Assignment,
  existingAttributes: ReadonlySet<Attribute> | undefined,
  existingIsArray: boolean
): void {
  if (assignment.subscript !== undefined || assignment.array !== undefined) {
    throw new UnsupportedFeatureError(`配列への前置代入（${assignment.name}）`);
  }
  rejectSpecialVariableMutation(assignment.name, false);
  if (!existingAttributes && !existingIsArray) return;
  if (
    existingIsArray ||
    existingAttributes?.has('n') ||
    existingAttributes?.has('i') ||
    existingAttributes?.has('l') ||
    existingAttributes?.has('u') ||
    existingAttributes?.has('c')
  ) {
    throw new UnsupportedFeatureError(`属性付き変数・配列への前置代入（${assignment.name}）`);
  }
}
