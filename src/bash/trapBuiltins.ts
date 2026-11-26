import type { Statement } from './ast';
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
  let operands = args;
  let prints = false;
  if (operands[0] === '-p') {
    prints = true;
    operands = operands.slice(1);
  } else if (operands[0] === '-l') rejectUnsupportedFeature('シグナルの一覧（trap -l）');
  if (operands[0] === '--') operands = operands.slice(1);
  if (prints || operands.length === 0) return printTraps(shell, operands);
  const [first, ...rest] = operands;
  const resets = first === '-' || (rest.length === 0 && conditionOf(first) !== undefined);
  const specs = resets && first !== '-' ? operands : rest;
  let status = 0;
  for (const spec of specs) {
    const condition = conditionOf(spec);
    if (condition === 'invalid') {
      shell.reportError(`trap: ${spec}: invalid signal specification`);
      status = 1;
      continue;
    }
    if (condition === undefined) rejectUnsupportedFeature(`シグナル（trap ${spec}）`);
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
  const conditions: TrapCondition[] = [];
  for (const spec of specs) {
    const condition = conditionOf(spec);
    if (condition === 'invalid') {
      shell.reportError(`trap: ${spec}: invalid signal specification`);
      return 1;
    }
    if (condition === undefined) rejectUnsupportedFeature(`シグナル（trap ${spec}）`);
    conditions.push(condition);
  }
  for (const condition of conditions.length > 0 ? conditions : (['EXIT', 'ERR'] as const)) {
    const trap = shell.traps.get(condition);
    if (trap) shell.fd1.write(`trap -- ${singleQuote(trap.text)} ${condition}\n`);
  }
  return 0;
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
