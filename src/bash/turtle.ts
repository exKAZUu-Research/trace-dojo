import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import type { Shell } from './shell';
import { resolveScalarTarget, resolveSubscriptTarget, writeResolvedTarget } from './targets';
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
  const coordinate = (text: string): number => {
    if (!/^[-+]?\d+$/.test(text.trim())) fail(shell, name, `${text}: integer expected`);
    return Number(text.trim());
  };
  const created = shell.runtime.world.create(coordinate(xText), coordinate(yText), color);
  if ('error' in created) fail(shell, name, created.error);
  const handle = shell.runtime.addTurtle(created);
  const target = split
    ? resolveSubscriptTarget(shell, {
        name: split.name,
        subscript: { kind: 'text', text: split.subscript },
        operation: 'write',
      })
    : resolveScalarTarget(shell, variable, true);
  const outcome = writeResolvedTarget(shell, target, handle, false);
  if (!outcome.ok) {
    shell.failures.handleStoreFailure('regularBuiltin', outcome, name);
    return 1;
  }
  return 0;
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

export const TURTLE_BUILTINS: Record<string, Builtin> = { turtle_new: turtleNew };

for (const [names, sign] of [
  [TURTLE_METHOD_NAMES.forward, 1],
  [TURTLE_METHOD_NAMES.backward, -1],
] as const) {
  for (const name of names) {
    TURTLE_BUILTINS[name] = (shell, args) => {
      const error = shell.runtime.world.move(turtleArgument(shell, args, name), sign);
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
    return 0;
  };
}
