import { type DeclarationArgument, runDeclaration } from './declare';
import { decodeBytes, encodeText, formatPrintf } from './printf';
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from './runtime';
import type { Shell } from './shell';
import { testBuiltin } from './testBuiltin';
import { type Builtin, TURTLE_BUILTINS } from './turtle';
import { UnsupportedFeatureError } from './unsupported';
import { ensureWritable, isIdentifier } from './variables';

/** Reads a numeric argument as Bash's `legal_number`, or `undefined` when it is not one. */
function legalNumber(text: string): bigint | undefined {
  const match = /^[ \t\n]*([-+]?\d+)[ \t\n]*$/.exec(text);
  if (!match) return undefined;
  const value = BigInt(match[1]);
  return value === BigInt.asIntN(64, value) ? value : undefined;
}

/** Skips a leading `--`, which Bash's builtins accept before their operands. */
function operands(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

// code-gauge-allow functionCognitiveComplexity -- Bash's echo option scan, which stops at the first word that is not wholly options.
function echo(shell: Shell, args: string[]): number {
  let newline = true;
  let escapes = false;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (!/^-[neE]+$/.test(arg)) break;
    for (const option of arg.slice(1)) {
      if (option === 'n') newline = false;
      else escapes = option === 'e';
    }
  }
  const bytes: number[] = [];
  const words = args.slice(index);
  for (const [position, word] of words.entries()) {
    if (escapes) {
      const { out, stop } = echoEscapes(word);
      bytes.push(...out);
      if (stop) {
        shell.state.fd1.write(decodeBytes(bytes));
        return 0;
      }
    } else bytes.push(...encodeText(word));
    if (position < words.length - 1) bytes.push(32);
  }
  if (newline) bytes.push(10);
  shell.state.fd1.write(decodeBytes(bytes));
  return 0;
}

/** The escapes of `echo -e`, as Bash's `ansicstr` reads them for `echo`. */
function echoEscapes(text: string): { out: number[]; stop: boolean } {
  const bytes = encodeText(text);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 92 || i + 1 >= bytes.length) {
      out.push(bytes[i]);
      continue;
    }
    const c = String.fromCodePoint(bytes[++i]);
    if (c === 'c') return { out, stop: true };
    const escaped = echoEscape(bytes, i, c);
    out.push(...escaped.out);
    i = escaped.last;
  }
  return { out, stop: false };
}

const ECHO_ESCAPES: Record<string, number> = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };

/** One escape of `echo -e` whose letter `c` is at `index`, giving its bytes and the index of its last character. */
// code-gauge-allow functionCognitiveComplexity -- One case per escape that echo -e reads, as Bash's ansicstr.
function echoEscape(bytes: number[], index: number, c: string): { out: number[]; last: number } {
  if (c in ECHO_ESCAPES) return { out: [ECHO_ESCAPES[c]], last: index };
  if (c === '0') {
    const { value, last } = readDigits(bytes, index, 3, 8);
    return { out: [value & 0xff], last };
  }
  if (c === 'x' || c === 'u' || c === 'U') {
    const { value, last } = readDigits(bytes, index, c === 'x' ? 2 : c === 'u' ? 4 : 8, 16);
    // An escape without digits stays as written.
    if (last === index) return { out: [92, bytes[index]], last };
    if (c === 'x' || value <= 0x7f) return { out: [value & 0xff], last };
    return { out: value <= 0x10_ff_ff ? encodeText(String.fromCodePoint(value)) : [], last };
  }
  return { out: [92, bytes[index]], last: index };
}

/** Reads up to `max` digits of `radix` after `index`, giving their value and the index of the last one read. */
function readDigits(bytes: number[], index: number, max: number, radix: number): { value: number; last: number } {
  let value = 0;
  let last = index;
  while (last - index < max && last + 1 < bytes.length) {
    const digit = Number.parseInt(String.fromCodePoint(bytes[last + 1]), radix);
    if (Number.isNaN(digit)) break;
    value = value * radix + digit;
    last++;
  }
  return { value, last };
}

// code-gauge-allow functionCognitiveComplexity -- Bash's printf option and operand checks, each with its own usage error.
// code-gauge-allow functionNcss -- Bash's printf option and operand checks, each with its own usage error.
function printf(shell: Shell, args: string[]): number {
  let list = args;
  let target: string | undefined;
  if (list[0] === '-v') {
    target = list[1];
    if (target === undefined) {
      shell.reportError('printf: -v: option requires an argument');
      shell.state.fd2.write('printf: usage: printf [-v var] format [arguments]\n');
      return 2;
    }
    const split = shell.splitSubscript(target);
    if (split ? !isIdentifier(split.name) || split.subscript === '' : !isIdentifier(target)) {
      shell.reportError(`printf: \`${target}': not a valid identifier`);
      return 2;
    }
    list = list.slice(2);
  } else if (/^-./.test(list[0] ?? '') && list[0] !== '--') {
    shell.reportError(`printf: ${list[0].slice(0, 2)}: invalid option`);
    shell.state.fd2.write('printf: usage: printf [-v var] format [arguments]\n');
    return 2;
  }
  list = operands(list);
  if (list.length === 0) {
    shell.state.fd2.write('printf: usage: printf [-v var] format [arguments]\n');
    return 2;
  }
  const [format, ...rest] = list;
  const { output, ok } = formatPrintf(format, rest, {
    error: (message) => shell.reportError(`printf: ${message}`),
    spend: (cost) => shell.runtime.spend(cost),
  });
  const text = decodeBytes(output);
  if (target === undefined) shell.state.fd1.write(text);
  else {
    const split = shell.splitSubscript(target);
    const stored = split
      ? shell.assignElement(split.name, split.subscript, text, false)
      : shell.assignScalar(target, text);
    if (!stored) return 1;
  }
  return ok ? 0 : 1;
}

function letBuiltin(shell: Shell, args: string[]): number {
  if (args.length === 0) {
    shell.reportError('let: expression expected');
    return 1;
  }
  let value: bigint | undefined = 0n;
  for (const arg of args) {
    value = shell.tryEvaluate(arg, 'let');
    if (value === undefined) return 1;
  }
  return value === 0n ? 1 : 0;
}

function unsetBuiltin(shell: Shell, args: string[]): number {
  const parsed = parseUnsetOptions(shell, args);
  if (!parsed) return 2;
  let status = 0;
  for (const name of parsed.names) {
    if (!unsetName(shell, name, parsed.mode)) status = 1;
  }
  return status;
}

type UnsetMode = 'any' | 'v' | 'f' | 'n';

/** The last of `-v`, `-f`, and `-n`, or `undefined` after reporting an option `unset` does not take, as Bash does. */
function parseUnsetOptions(shell: Shell, args: string[]): { mode: UnsetMode; names: string[] } | undefined {
  let mode: UnsetMode = 'any';
  let index = 0;
  for (; index < args.length && /^-[vfn]+$/.test(args[index]); index++) mode = args[index].at(-1) as UnsetMode;
  const invalid = /^-(?!-$)[vfn]*([^vfn])/.exec(args[index] ?? '');
  if (invalid) {
    shell.reportError(`unset: -${invalid[1]}: invalid option`);
    shell.state.fd2.write('unset: usage: unset [-f] [-v] [-n] [name ...]\n');
    return undefined;
  }
  return { mode, names: operands(args.slice(index)) };
}

/** Unsets one operand of `unset`: a function, an array element, or a variable, telling whether it succeeded. */
function unsetName(shell: Shell, name: string, mode: UnsetMode): boolean {
  const split = shell.splitSubscript(name);
  if (mode === 'f') {
    shell.state.functions.delete(name);
    return true;
  }
  if (split && isIdentifier(split.name)) return unsetElement(shell, split.name, split.subscript);
  if (!isIdentifier(name)) {
    if (mode === 'v') {
      shell.reportError(`unset: \`${name}': not a valid identifier`);
      return false;
    }
    // A word that cannot name a variable names a function, which Bash then unsets if there is one.
    shell.state.functions.delete(name);
    return true;
  }
  // A name that no variable has unsets the function of that name.
  if (!shell.findOwnVariable(name) && mode === 'any' && shell.state.functions.has(name)) {
    return shell.state.functions.delete(name);
  }
  return shell.unsetVariable(name, mode !== 'n');
}

/** `unset 'name[subscript]'`, which clears an indexed array for `@` or `*` and removes an associative key literally. */
function unsetElement(shell: Shell, name: string, subscript: string): boolean {
  const resolved = shell.resolveName(name);
  const variable = shell.findVariable(resolved);
  if (variable?.attributes.has('r')) {
    shell.reportError(`unset: ${resolved}: cannot unset: readonly variable`);
    return false;
  }
  if (!variable?.value) return true;
  ensureWritable(variable);
  if (variable.value.kind === 'associative') {
    variable.value.table.delete(subscript);
    return true;
  }
  if (subscript === '@' || subscript === '*') {
    if (variable.value.kind === 'indexed') variable.value.elements.clear();
    else shell.unsetVariable(resolved);
    return true;
  }
  const index = shell.arrayIndex(resolved, subscript);
  if (index === undefined) {
    shell.reportError(`unset: [${subscript}]: bad array subscript`);
    return false;
  }
  if (variable.value.kind === 'indexed') variable.value.elements.delete(index);
  else if (index === 0n) shell.unsetVariable(resolved);
  return true;
}

/** Bash's `no_args`: a builtin given more operands than it takes abandons the line with status 2. */
function rejectExtraOperands(shell: Shell, name: string, extra: string[]): void {
  if (extra.length > 0) shell.discard(`${name}: too many arguments`, 2);
}

function shift(shell: Shell, args: string[]): number {
  const [countText, ...extra] = operands(args);
  let count = 1n;
  if (countText !== undefined) {
    const parsed = legalNumber(countText);
    if (parsed === undefined) {
      shell.reportError(`shift: ${countText}: numeric argument required`);
      return 2;
    }
    rejectExtraOperands(shell, 'shift', extra);
    count = parsed;
  }
  const positional = shell.state.positional.at(-1) as string[];
  if (count < 0n) {
    shell.reportError(`shift: ${countText}: shift count out of range`);
    return 1;
  }
  if (count > BigInt(positional.length)) return 1;
  positional.splice(0, Number(count));
  return 0;
}

function returnBuiltin(shell: Shell, args: string[]): number {
  if (!shell.isInFunction) {
    shell.reportError("return: can only `return' from a function or sourced script");
    return 2;
  }
  const [statusText, ...extra] = operands(args);
  if (statusText === undefined) throw new ReturnSignal(shell.state.lastStatus);
  const status = legalNumber(statusText);
  if (status === undefined) {
    shell.reportError(`return: ${statusText}: numeric argument required`);
    throw new ReturnSignal(2);
  }
  rejectExtraOperands(shell, 'return', extra);
  throw new ReturnSignal(Number(BigInt.asUintN(8, status)));
}

function exitBuiltin(shell: Shell, args: string[]): number {
  const [statusText, ...extra] = operands(args);
  if (statusText === undefined) throw new ExitSignal(shell.state.lastStatus);
  const status = legalNumber(statusText);
  if (status === undefined) {
    shell.reportError(`exit: ${statusText}: numeric argument required`);
    throw new ExitSignal(2);
  }
  rejectExtraOperands(shell, 'exit', extra);
  throw new ExitSignal(Number(BigInt.asUintN(8, status)));
}

function loopControl(kind: 'break' | 'continue'): Builtin {
  return (shell, args) => {
    if (!shell.isInLoop) {
      shell.reportError(`${kind}: only meaningful in a \`for', \`while', or \`until' loop`);
      return 0;
    }
    const [countText, ...extra] = operands(args);
    let count = 1n;
    if (countText !== undefined) {
      const parsed = legalNumber(countText);
      if (parsed === undefined) {
        // A non-interactive Bash exits at a count that is not a number.
        shell.reportError(`${kind}: ${countText}: numeric argument required`);
        throw new ExitSignal(2);
      }
      rejectExtraOperands(shell, kind, extra);
      if (parsed < 1n) {
        // Bash then leaves every loop, for `continue` too.
        shell.reportError(`${kind}: ${countText}: loop count out of range`);
        throw new BreakSignal(shell.loopCount, 1);
      }
      count = parsed;
    }
    const levels = Number(count > BigInt(shell.loopCount) ? BigInt(shell.loopCount) : count);
    throw kind === 'break' ? new BreakSignal(levels) : new ContinueSignal(levels);
  };
}

function set(shell: Shell, args: string[]): number {
  if (args.length === 0) throw new UnsupportedFeatureError('set の変数の一覧');
  if (args[0] === '--' || args[0] === '-' || !/^[-+]/.test(args[0])) {
    const rest = args[0] === '--' || args[0] === '-' ? args.slice(1) : args;
    const positional = shell.state.positional.at(-1) as string[];
    positional.splice(0, positional.length, ...rest);
    return 0;
  }
  throw new UnsupportedFeatureError(`シェルのオプション（set ${args[0]}）`);
}

function declarationBuiltin(name: string): Builtin {
  return (shell, args) => runDeclaration(shell, name, args as DeclarationArgument[]);
}

function unavailable(feature: string): Builtin {
  return () => {
    throw new UnsupportedFeatureError(feature);
  };
}

export const BUILTINS: Record<string, Builtin> = {
  echo,
  printf,
  ':': () => 0,
  true: () => 0,
  false: () => 1,
  test: (shell, args) => testBuiltin(shell, args, 'test'),
  '[': (shell, args) => testBuiltin(shell, args, '['),
  let: letBuiltin,
  unset: unsetBuiltin,
  shift,
  return: returnBuiltin,
  exit: exitBuiltin,
  break: loopControl('break'),
  continue: loopControl('continue'),
  set,
  declare: declarationBuiltin('declare'),
  typeset: declarationBuiltin('typeset'),
  local: declarationBuiltin('local'),
  readonly: declarationBuiltin('readonly'),
  export: declarationBuiltin('export'),
  ...TURTLE_BUILTINS,
  read: unavailable('標準入力（read）'),
  mapfile: unavailable('標準入力（mapfile）'),
  readarray: unavailable('標準入力（readarray）'),
  eval: unavailable('文字列の評価（eval）'),
  source: unavailable('別ファイルの読み込み（source）'),
  '.': unavailable('別ファイルの読み込み（.）'),
  exec: unavailable('exec'),
  trap: unavailable('trap'),
  wait: unavailable('wait'),
  jobs: unavailable('ジョブ制御（jobs）'),
  fg: unavailable('ジョブ制御（fg）'),
  bg: unavailable('ジョブ制御（bg）'),
  kill: unavailable('kill'),
  disown: unavailable('disown'),
  suspend: unavailable('suspend'),
  cd: unavailable('ディレクトリの移動（cd）'),
  pwd: unavailable('pwd'),
  pushd: unavailable('pushd'),
  popd: unavailable('popd'),
  dirs: unavailable('dirs'),
  umask: unavailable('umask'),
  ulimit: unavailable('ulimit'),
  times: unavailable('times'),
  type: unavailable('type'),
  command: unavailable('command'),
  builtin: unavailable('builtin'),
  caller: unavailable('caller'),
  getopts: unavailable('getopts'),
  hash: unavailable('hash'),
  enable: unavailable('enable'),
  help: unavailable('help'),
  history: unavailable('history'),
  fc: unavailable('fc'),
  bind: unavailable('bind'),
  alias: unavailable('エイリアス（alias）'),
  unalias: unavailable('エイリアス（unalias）'),
  complete: unavailable('complete'),
  compgen: unavailable('compgen'),
  compopt: unavailable('compopt'),
  logout: unavailable('logout'),
  shopt: unavailable('シェルのオプション（shopt）'),
};
