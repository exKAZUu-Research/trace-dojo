import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import { newError } from './errorValues';
import { utf8Decode, utf8Encode } from './literals';
import { addMethod, currentRuntime, fn, namedType } from './native';
import { GoPanic } from './runtime';
import { nilPointerPanic } from './runtimeErrors';
import { BASIC, type FuncType, pointerTo } from './types';
import { Cell, GoStruct, Pointer, type Value } from './values';

/** The Turtle type, which the program uses through `*Turtle` values that `NewTurtle` returns. */
export const TURTLE_TYPE = namedType('main', 'Turtle', { kind: 'struct', fields: [] });
export const TURTLE_POINTER = pointerTo(TURTLE_TYPE);

/** `NewTurtle()`, `NewTurtle(x, y)`, or `NewTurtle(x, y, color)`, which the compiler checks like a builtin. */
export function newTurtle(args: Value[]): Value {
  const runtime = currentRuntime();
  const x = args.length > 0 ? Number(args[0] as bigint) : 0;
  const y = args.length > 1 ? Number(args[1] as bigint) : 0;
  const color = args.length > 2 ? utf8Decode(args[2] as string) : undefined;
  const created = runtime.world.create(x, y, color);
  if ('error' in created) throw new GoPanic(newError(created.error));
  runtime.allocate(1);
  return new Pointer(new Cell(new GoStruct([], { turtle: created })), 'v');
}

function stateOf(receiver: Value): TurtleState {
  if (!(receiver instanceof Pointer)) return nilPointerPanic();
  const native = (receiver.load() as GoStruct).native;
  if (!native?.turtle) throw new GoPanic(newError(utf8Encode('Turtle は NewTurtle で作ってください。')));
  return native.turtle;
}

/** Go's English method names start with a capital letter, as exported names must. */
function goNames(names: readonly string[]): string[] {
  return names.map((name) => (/^[a-z]/.test(name) ? name[0].toUpperCase() + name.slice(1) : name));
}

function define(names: readonly string[], signature: FuncType, run: (state: TurtleState) => Value): void {
  for (const name of goNames(names)) {
    addMethod(
      TURTLE_TYPE,
      name,
      signature,
      (receiver) => {
        currentRuntime().spend();
        return run(stateOf(receiver));
      },
      true
    );
  }
}

const action = fn([], []);
const question = fn([], [BASIC.bool]);
for (const [names, sign] of [
  [TURTLE_METHOD_NAMES.forward, 1],
  [TURTLE_METHOD_NAMES.backward, -1],
] as const) {
  define(names, action, (state) => {
    const error = currentRuntime().world.move(state, sign);
    if (error) throw new GoPanic(newError(error));
    return;
  });
}
for (const [names, quarters] of [
  [TURTLE_METHOD_NAMES.turnRight, 1],
  [TURTLE_METHOD_NAMES.turnLeft, 3],
] as const) {
  define(names, action, (state) => {
    currentRuntime().world.turn(state, quarters);
    return;
  });
}
define(TURTLE_METHOD_NAMES.canMoveForward, question, (state) => {
  currentRuntime().collectGarbage();
  return currentRuntime().world.canMoveForward(state);
});
define(TURTLE_METHOD_NAMES.isFrontPainted, question, (state) => currentRuntime().world.isFrontPainted(state));
define(TURTLE_METHOD_NAMES.remove, action, (state) => {
  currentRuntime().world.remove(state);
  return;
});
