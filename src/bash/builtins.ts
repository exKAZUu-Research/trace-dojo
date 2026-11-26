import { isVariableReference } from './arithmetic';
import { legalNumber } from './characters';
import { cdBuiltin, dirsBuiltin, popdBuiltin, pushdBuiltin, pwdBuiltin } from './directoryBuiltins';
import { getoptsBuiltin } from './getopts';
import {
  aliasBuiltin,
  builtinBuiltin,
  callerBuiltin,
  commandBuiltin,
  logoutBuiltin,
  typeBuiltin,
  unaliasBuiltin,
} from './introspectionBuiltins';
import { waitBuiltin } from './jobBuiltins';
import { setBuiltin, shoptBuiltin } from './optionBuiltins';
import { decodeBytes, encodeText, formatPrintf } from './printf';
import { readRadixDigits, SIMPLE_ESCAPE_BYTES } from './quoting';
import { mapfileBuiltin, readBuiltin } from './readBuiltins';
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from './runtime';
import type { Shell } from './shell';
import { resolveScalarTarget, resolveSubscriptTarget, unsetResolvedElement, writeResolvedTarget } from './targets';
import { testBuiltin } from './testBuiltin';
import { trapBuiltin } from './trapBuiltins';
import { type Builtin, TURTLE_BUILTINS } from './turtle';
import { isIdentifier } from './variables';

/** Skips a leading `--`, which Bash's builtins accept before their operands. */
function operands(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

// code-gauge-allow functionCognitiveComplexity -- Bash's echo option scan stops at the first word that is not wholly options.
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
      appendBytes(bytes, out);
      if (stop) {
        shell.fd1.write(decodeBytes(bytes));
        return 0;
      }
    } else appendBytes(bytes, encodeText(word));
    if (position < words.length - 1) bytes.push(32);
  }
  if (newline) bytes.push(10);
  shell.fd1.write(decodeBytes(bytes));
  return 0;
}

function appendBytes(target: number[], source: readonly number[]): void {
  for (const byte of source) target.push(byte);
}

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

// code-gauge-allow functionCognitiveComplexity -- Handles simple escapes, \0nnn octal, and \x/\u/\U hex escapes for echo -e.
function echoEscape(bytes: number[], index: number, c: string): { out: number[]; last: number } {
  if (Object.hasOwn(SIMPLE_ESCAPE_BYTES, c)) return { out: [SIMPLE_ESCAPE_BYTES[c]], last: index };
  if (c === '0') {
    const { value, count } = readRadixDigits(bytes, index + 1, 3, 8);
    return { out: [value & 0xff], last: index + count };
  }
  if (c === 'x' || c === 'u' || c === 'U') {
    const { value, count } = readRadixDigits(bytes, index + 1, c === 'x' ? 2 : c === 'u' ? 4 : 8, 16);
    if (count === 0) return { out: [92, bytes[index]], last: index };
    const last = index + count;
    if (c === 'x' || value <= 0x7f) return { out: [value & 0xff], last };
    return { out: value <= 0x10_ff_ff ? encodeText(String.fromCodePoint(value)) : [], last };
  }
  return { out: [92, bytes[index]], last: index };
}

function printf(shell: Shell, args: string[]): number {
  const parsed = parsePrintfOptions(shell, args);
  if (typeof parsed === 'number') return parsed;
  const { target, rest: list } = parsed;
  if (list.length === 0) {
    shell.fd2.write('printf: usage: printf [-v var] format [arguments]\n');
    return 2;
  }
  const [format, ...rest] = list;
  const { output, ok } = formatPrintf(format, rest, {
    error: (message) => shell.reportError(`printf: ${message}`),
    spend: (cost) => shell.runtime.spend(cost),
  });
  if (target === undefined) shell.fd1.write(decodeBytes(output));
  else {
    const nul = output.indexOf(0);
    const text = decodeBytes(nul === -1 ? output : output.slice(0, nul));
    if (!storePrintfTarget(shell, target, text)) return 1;
  }
  return ok ? 0 : 1;
}

function storePrintfTarget(shell: Shell, candidate: string, text: string): boolean {
  const split = shell.splitSubscript(candidate);
  const resolved = split
    ? resolveSubscriptTarget(shell, {
        name: split.name,
        subscript: { kind: 'text', text: split.subscript },
        operation: 'write',
      })
    : resolveScalarTarget(shell, candidate, true);
  const outcome = writeResolvedTarget(shell, resolved, text, false, 'printf');
  if (!outcome.ok) return shell.failures.handleStoreFailure('regularBuiltin', outcome, 'printf');
  return true;
}

// code-gauge-allow functionCognitiveComplexity -- Scans repeated and attached -v options until `--` or the format operand.
function parsePrintfOptions(shell: Shell, args: string[]): { target: string | undefined; rest: string[] } | number {
  let target: string | undefined;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      index++;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    if (arg[1] !== 'v') {
      shell.reportError(`printf: -${arg[1]}: invalid option`);
      shell.fd2.write('printf: usage: printf [-v var] format [arguments]\n');
      return 2;
    }
    const candidate = arg.length > 2 ? arg.slice(2) : args[index + 1];
    if (candidate === undefined) {
      shell.reportError('printf: -v: option requires an argument');
      shell.fd2.write('printf: usage: printf [-v var] format [arguments]\n');
      return 2;
    }
    if (!isVariableReference(candidate)) {
      shell.reportError(`printf: \`${candidate}': not a valid identifier`);
      return 2;
    }
    target = candidate;
    index += arg.length > 2 ? 1 : 2;
  }
  return { target, rest: args.slice(index) };
}

function letBuiltin(shell: Shell, args: string[]): number {
  const expressions = operands(args);
  if (expressions.length === 0) {
    shell.reportError('let: expression expected');
    return 1;
  }
  let value: bigint | undefined = 0n;
  for (const arg of expressions) {
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

function parseUnsetOptions(shell: Shell, args: string[]): { mode: UnsetMode; names: string[] } | undefined {
  let mode: UnsetMode = 'any';
  let index = 0;
  for (; index < args.length && /^-[vfn]+$/.test(args[index]); index++) mode = args[index].at(-1) as UnsetMode;
  const invalid = /^-(?!-$)[vfn]*([^vfn])/.exec(args[index] ?? '');
  if (invalid) {
    shell.reportError(`unset: -${invalid[1]}: invalid option`);
    shell.fd2.write('unset: usage: unset [-f] [-v] [-n] [name ...]\n');
    return undefined;
  }
  return { mode, names: operands(args.slice(index)) };
}

function unsetName(shell: Shell, name: string, mode: UnsetMode): boolean {
  if (mode === 'f') {
    shell.store.deleteFunction(name);
    return true;
  }
  if (mode === 'n') {
    return isIdentifier(name) && shell.store.ownView(name)?.attributes.has('n')
      ? shell.unsetVariable(name, false)
      : true;
  }
  const split = shell.splitSubscript(name);
  if (split && isIdentifier(split.name) && split.subscript !== '') {
    return unsetSubscriptedOperand(shell, split.name, split.subscript);
  }
  if (!isIdentifier(name)) return unsetNonIdentifierOperand(shell, name, mode);
  if (!shell.store.ownView(name) && mode === 'any' && shell.store.hasFunction(name)) {
    return shell.store.deleteFunction(name);
  }
  return shell.unsetVariable(name, true);
}

function unsetSubscriptedOperand(shell: Shell, name: string, subscript: string): boolean {
  const target = resolveSubscriptTarget(shell, {
    name,
    subscript: { kind: 'text', text: subscript },
    operation: 'unset',
  });
  const failure = unsetResolvedElement(shell, target);
  return failure ? shell.failures.handleStoreFailure('regularBuiltin', failure, 'unset') : true;
}

function unsetNonIdentifierOperand(shell: Shell, name: string, mode: UnsetMode): boolean {
  if (mode === 'v') {
    shell.reportError(`unset: \`${name}': not a valid identifier`);
    return false;
  }
  shell.store.deleteFunction(name);
  return true;
}

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
  if (count < 0n) {
    shell.reportError(`shift: ${countText}: shift count out of range`);
    return 1;
  }
  return shell.store.shiftPositionalArgs(Number(count)) ? 0 : 1;
}

function returnBuiltin(shell: Shell, args: string[]): number {
  if (!shell.isInFunction) {
    shell.reportError("return: can only `return' from a function or sourced script");
    return 2;
  }
  const [statusText, ...extra] = operands(args);
  if (statusText === undefined) throw new ReturnSignal(shell.store.lastStatus);
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
  if (statusText === undefined) throw new ExitSignal(shell.store.lastStatus);
  const status = legalNumber(statusText);
  if (status === undefined) {
    shell.reportError(`exit: ${statusText}: numeric argument required`);
    return 2;
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
        shell.reportError(`${kind}: ${countText}: numeric argument required`);
        throw new ExitSignal(2);
      }
      rejectExtraOperands(shell, kind, extra);
      if (parsed < 1n) {
        shell.reportError(`${kind}: ${countText}: loop count out of range`);
        throw new BreakSignal(shell.loopCount, 1);
      }
      count = parsed;
    }
    const levels = Number(count > BigInt(shell.loopCount) ? BigInt(shell.loopCount) : count);
    throw kind === 'break' ? new BreakSignal(levels) : new ContinueSignal(levels);
  };
}

export const REGULAR_BUILTINS: Record<string, Builtin> = {
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
  set: setBuiltin,
  shopt: shoptBuiltin,
  read: readBuiltin,
  mapfile: mapfileBuiltin,
  readarray: mapfileBuiltin,
  cd: cdBuiltin,
  pwd: pwdBuiltin,
  pushd: pushdBuiltin,
  popd: popdBuiltin,
  dirs: dirsBuiltin,
  wait: waitBuiltin,
  trap: trapBuiltin,
  getopts: getoptsBuiltin,
  command: commandBuiltin,
  builtin: builtinBuiltin,
  type: typeBuiltin,
  caller: callerBuiltin,
  alias: aliasBuiltin,
  unalias: unaliasBuiltin,
  logout: logoutBuiltin,
  ...TURTLE_BUILTINS,
};
