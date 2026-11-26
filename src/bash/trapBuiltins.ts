import type { Statement } from './ast';
import { parseBuiltinOptions } from './builtinOptions';
import { rejectUnsupportedFeature } from './capabilities';
import { parseTrapAction } from './parse';
import { singleQuote } from './quoting';
import type { Shell } from './shell';
import type { Builtin } from './turtle';

/** The conditions a trap can wait for here: the shell's exit, and a failed command. */
export type TrapCondition = 'EXIT' | 'ERR';

/** A trap's action: its text, which `trap -p` shows, and its commands, which an ignored condition has none of. */
export interface Trap {
  readonly text: string;
  readonly statements: Statement[];
  /** The row of the `trap` command, where the action's commands are numbered from. */
  readonly row: number;
}

/** The names `kill -l` lists on a typical system, which name signals this environment cannot send or catch. */
const SIGNAL_NAMES = new Set([
  'HUP',
  'INT',
  'QUIT',
  'ILL',
  'TRAP',
  'ABRT',
  'EMT',
  'FPE',
  'KILL',
  'BUS',
  'SEGV',
  'SYS',
  'PIPE',
  'ALRM',
  'TERM',
  'URG',
  'STOP',
  'TSTP',
  'CONT',
  'CHLD',
  'TTIN',
  'TTOU',
  'IO',
  'XCPU',
  'XFSZ',
  'VTALRM',
  'PROF',
  'WINCH',
  'INFO',
  'USR1',
  'USR2',
]);

/**
 * `trap`, which sets the commands run when the shell exits (`EXIT`) or a command fails (`ERR`), resets them with
 * `-`, ignores them with an empty action, and prints them with `-p` or no operand. Signals cannot reach a program
 * here, and `DEBUG` and `RETURN` traps are not provided, so naming them stops the program.
 */
// code-gauge-allow functionCognitiveComplexity -- Handles printing, resetting, ignoring, and setting traps, which Bash's `trap` tells apart by its operands.
export const trapBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'trap', args, 'lpP', 'trap [-Plp] [[action] signal_spec ...]');
  if (typeof parsed === 'number') return parsed;
  const { options, operands } = parsed;
  if (options.has('l')) rejectUnsupportedFeature('シグナルの一覧（trap -l）');
  if (options.has('P')) return printTrapActions(shell, operands);
  if (options.has('p') || operands.length === 0) return printTraps(shell, operands);
  // A subshell that changes a trap shows its own traps from then on.
  shell.shownTraps = undefined;
  const [first, ...rest] = operands;
  // As Bash's `trap` reads its operands: a leading signal number, or a lone signal name, resets; otherwise the first
  // operand is the action, which needs a signal after it, and `-` as the action resets too.
  const isSignal = conditionOf(first) !== 'invalid';
  const resetsAll = (/^\d+$/.test(first) && isSignal) || (first !== '-' && rest.length === 0 && isSignal);
  if (!resetsAll && rest.length === 0) {
    shell.fd2.write('trap: usage: trap [-Plp] [[action] signal_spec ...]\n');
    return 2;
  }
  const resets = resetsAll || first === '-';
  const specs = resetsAll ? operands : rest;
  let status = 0;
  for (const spec of specs) {
    const condition = conditionOf(spec);
    if (condition === 'invalid') {
      shell.reportError(`trap: ${spec}: invalid signal specification`);
      status = 1;
      continue;
    }
    if (condition === undefined) rejectUnsupportedCondition(spec);
    if (resets) shell.traps.delete(condition);
    else
      shell.traps.set(condition, {
        text: first,
        statements: parseTrapAction(first, shell.currentRow),
        row: shell.currentRow,
      });
  }
  return status;
};

function printTraps(shell: Shell, specs: readonly string[]): number {
  const conditions = conditionsOf(shell, specs);
  if (conditions === undefined) return 1;
  const traps = shell.shownTraps ?? shell.traps;
  for (const condition of conditions.length > 0 ? conditions : (['EXIT', 'ERR'] as const)) {
    const trap = traps.get(condition);
    if (trap) shell.fd1.write(`trap -- ${singleQuote(trap.text)} ${condition}\n`);
  }
  return 0;
}

/** `trap -P`, which prints the actions alone of the conditions it names. */
function printTrapActions(shell: Shell, specs: readonly string[]): number {
  if (specs.length === 0) {
    shell.reportError('trap: -P requires at least one signal name');
    return 2;
  }
  const conditions = conditionsOf(shell, specs);
  if (conditions === undefined) return 1;
  const traps = shell.shownTraps ?? shell.traps;
  for (const condition of conditions) {
    const trap = traps.get(condition);
    if (trap) shell.fd1.write(`${trap.text}\n`);
  }
  return 0;
}

/** The conditions that operands name, or `undefined` after reporting one Bash does not know. */
function conditionsOf(shell: Shell, specs: readonly string[]): TrapCondition[] | undefined {
  const conditions: TrapCondition[] = [];
  for (const spec of specs) {
    const condition = conditionOf(spec);
    if (condition === 'invalid') {
      shell.reportError(`trap: ${spec}: invalid signal specification`);
      return undefined;
    }
    if (condition === undefined) rejectUnsupportedCondition(spec);
    conditions.push(condition);
  }
  return conditions;
}

/** Rejects a signal, or the `DEBUG` or `RETURN` condition, which this environment does not provide. */
function rejectUnsupportedCondition(spec: string): never {
  const name = spec.toUpperCase().replace(/^SIG/, '');
  const isCommandCondition = name === 'DEBUG' || name === 'RETURN';
  return rejectUnsupportedFeature(`${isCommandCondition ? 'trap の条件' : 'シグナル'}（trap ${spec}）`);
}

/**
 * The condition a trap operand names, `undefined` for a signal, `DEBUG`, or `RETURN`, which this environment does
 * not provide, or `invalid` for a name Bash does not know.
 */
function conditionOf(spec: string): TrapCondition | 'invalid' | undefined {
  const name = spec.toUpperCase().replace(/^SIG/, '');
  if (name === 'EXIT' || spec === '0') return 'EXIT';
  if (name === 'ERR') return 'ERR';
  if (name === 'DEBUG' || name === 'RETURN' || SIGNAL_NAMES.has(name)) return undefined;
  if (/^\d+$/.test(spec) && Number(spec) < 65) return undefined;
  return 'invalid';
}
