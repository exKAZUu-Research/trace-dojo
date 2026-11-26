import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import { rejectUnsupportedVariableMutation } from './capabilities';
import type { Shell } from './shell';
import { type ResolvedTarget, resolveScalarTarget, resolveSubscriptTarget, writeResolvedTarget } from './targets';
import { isIdentifier } from './variables';

/** Stops the program at a turtle's error, as Java's uncaught exception does, after Bash's error line. */
export class TurtleError extends Error {
  constructor(readonly report: string) {
    super(report);
    this.name = 'TurtleError';
  }
}

export type Builtin = (shell: Shell, args: string[], name: string) => number;

const NEW_USAGE =
  'turtle_new には、変数の名前だけか、変数の名前と x と y、または変数の名前と x と y と色（R など）を書いてください。';

/** `turtle_new name [x y [color]]`, storing the new turtle's handle through the shared target resolver. */
function turtleNew(shell: Shell, args: string[], name: string): number {
  if (args.length !== 1 && args.length !== 3 && args.length !== 4) fail(shell, name, NEW_USAGE);
  const [variable, xText = '0', yText = '0', color] = args;
  const split = shell.splitSubscript(variable);
  if (!isIdentifier(split ? split.name : variable)) fail(shell, name, `\`${variable}': not a valid identifier`);
  const x = parseCoordinate(shell, name, xText);
  const y = parseCoordinate(shell, name, yText);
  const target = resolveTurtleTarget(shell, variable, split);
  if (target.kind === 'invalid' || target.kind === 'wholeArray') {
    const failed = writeResolvedTarget(shell, target, '', false, name);
    if (!failed.ok) shell.failures.handleStoreFailure('regularBuiltin', failed, name);
    return 1;
  }
  const previousColor = shell.runtime.world.board[y]?.[x];
  const created = shell.runtime.world.create(x, y, color);
  if ('error' in created) fail(shell, name, created.error);
  const handle = shell.runtime.reserveTurtleHandle();
  return commitCreatedTurtle(shell, name, target, handle, {
    turtle: created,
    x,
    y,
    previousColor: previousColor as string,
  });
}

function parseCoordinate(shell: Shell, name: string, text: string): number {
  if (!/^[-+]?\d+$/.test(text.trim())) fail(shell, name, `${text}: integer expected`);
  return Number(text.trim());
}

function resolveTurtleTarget(
  shell: Shell,
  variable: string,
  split: { name: string; subscript: string } | undefined
): ResolvedTarget {
  const target = split
    ? resolveSubscriptTarget(shell, {
        name: split.name,
        subscript: { kind: 'text', text: split.subscript },
        operation: 'write',
      })
    : resolveScalarTarget(shell, variable, true);
  if (target.kind === 'randomSeed') rejectUnsupportedVariableMutation('RANDOM', false);
  return target;
}

function commitCreatedTurtle(
  shell: Shell,
  name: string,
  target: ResolvedTarget,
  handle: string,
  rollback: { turtle: TurtleState; x: number; y: number; previousColor: string }
): number {
  let outcome;
  try {
    outcome = writeResolvedTarget(shell, target, handle, false, name);
  } catch (error) {
    rollbackTurtle(shell, rollback);
    throw error;
  }
  if (!outcome.ok) {
    rollbackTurtle(shell, rollback);
    shell.failures.handleStoreFailure('regularBuiltin', outcome, name);
    return 1;
  }
  shell.runtime.commitTurtle(handle, rollback.turtle);
  return 0;
}

function rollbackTurtle(
  shell: Shell,
  rollback: { turtle: TurtleState; x: number; y: number; previousColor: string }
): void {
  shell.runtime.world.remove(rollback.turtle);
  shell.runtime.world.board[rollback.y][rollback.x] = rollback.previousColor;
}

function turtleArgument(shell: Shell, args: string[], name: string): TurtleState {
  if (args.length !== 1) fail(shell, name, `亀を1つ渡してください（例: ${name} "$t"）。`);
  const turtle = shell.runtime.turtleOf(args[0]);
  if (!turtle) fail(shell, name, `亀（turtle_new で作ったもの）ではないもの（${args[0]}）を渡しました。`);
  return turtle;
}

function fail(shell: Shell, name: string, message: string): never {
  const report = `main.sh: line ${shell.currentRow + 1}: ${name}: ${message}`;
  shell.fd2.write(`${report}\n`);
  throw new TurtleError(report);
}

export const TURTLE_PREDICATE_NAMES = new Set<string>([
  ...TURTLE_METHOD_NAMES.canMoveForward,
  ...TURTLE_METHOD_NAMES.isFrontPainted,
]);

export const TURTLE_BUILTINS: Record<string, Builtin> = { turtle_new: turtleNew };

for (const [names, sign] of [
  [TURTLE_METHOD_NAMES.forward, 1],
  [TURTLE_METHOD_NAMES.backward, -1],
] as const) {
  for (const name of names) {
    TURTLE_BUILTINS[name] = (shell, args) => {
      const error = shell.runtime.world.move(turtleArgument(shell, args, name), sign);
      shell.runtime.bumpTurtleEpoch();
      if (error) fail(shell, name, error);
      return 0;
    };
  }
}
for (const [names, quarters] of [
  [TURTLE_METHOD_NAMES.turnRight, 1],
  [TURTLE_METHOD_NAMES.turnLeft, 3],
] as const) {
  for (const name of names) {
    TURTLE_BUILTINS[name] = (shell, args) => {
      shell.runtime.world.turn(turtleArgument(shell, args, name), quarters);
      return 0;
    };
  }
}
for (const name of TURTLE_METHOD_NAMES.canMoveForward) {
  TURTLE_BUILTINS[name] = (shell, args) =>
    shell.runtime.world.canMoveForward(turtleArgument(shell, args, name)) ? 0 : 1;
}
for (const name of TURTLE_METHOD_NAMES.isFrontPainted) {
  TURTLE_BUILTINS[name] = (shell, args) =>
    shell.runtime.world.isFrontPainted(turtleArgument(shell, args, name)) ? 0 : 1;
}
for (const name of TURTLE_METHOD_NAMES.remove) {
  TURTLE_BUILTINS[name] = (shell, args) => {
    shell.runtime.world.remove(turtleArgument(shell, args, name));
    shell.runtime.bumpTurtleEpoch();
    return 0;
  };
}
