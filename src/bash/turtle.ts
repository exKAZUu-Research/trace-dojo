import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import type { Shell } from './shell';
import { isIdentifier } from './variables';

/** Stops the program at a turtle's error, as Java's uncaught exception does, after Bash's error line. */
export class TurtleError extends Error {
  constructor(readonly report: string) {
    super(report);
    this.name = 'TurtleError';
  }
}

export type Builtin = (shell: Shell, args: string[], name: string) => number;

function fail(shell: Shell, name: string, message: string): never {
  const report = `main.sh: line ${shell.currentRow + 1}: ${name}: ${message}`;
  shell.state.fd2.write(`${report}\n`);
  throw new TurtleError(report);
}

function turtleArgument(shell: Shell, args: string[], name: string): TurtleState {
  if (args.length !== 1) fail(shell, name, `亀を1つ渡してください（例: ${name} "$t"）。`);
  const turtle = shell.runtime.turtleOf(args[0]);
  if (!turtle) fail(shell, name, `亀（turtle_new で作ったもの）ではないもの（${args[0]}）を渡しました。`);
  return turtle;
}

const NEW_USAGE =
  'turtle_new には、変数の名前だけか、変数の名前と x と y、または変数の名前と x と y と色（R など）を書いてください。';

/** `turtle_new name [x y [color]]`, which stores the new turtle's handle in the variable, as `printf -v` stores. */
function turtleNew(shell: Shell, args: string[], name: string): number {
  if (args.length !== 1 && args.length !== 3 && args.length !== 4) fail(shell, name, NEW_USAGE);
  const [variable, xText = '0', yText = '0', color] = args;
  const target = shell.splitSubscript(variable);
  if (!isIdentifier(target ? target.name : variable)) fail(shell, name, `\`${variable}': not a valid identifier`);
  const coordinate = (text: string): number => {
    if (!/^[-+]?\d+$/.test(text.trim())) fail(shell, name, `${text}: integer expected`);
    return Number(text.trim());
  };
  const created = shell.runtime.world.create(coordinate(xText), coordinate(yText), color);
  if ('error' in created) fail(shell, name, created.error);
  const handle = shell.runtime.addTurtle(created);
  const stored = target
    ? shell.assignElement(target.name, target.subscript, handle, false)
    : shell.assignScalar(variable, handle);
  return stored ? 0 : 1;
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
  TURTLE_BUILTINS[name] = (shell, args) => {
    const turtle = turtleArgument(shell, args, name);
    shell.runtime.collectGarbage();
    return shell.runtime.world.canMoveForward(turtle) ? 0 : 1;
  };
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
