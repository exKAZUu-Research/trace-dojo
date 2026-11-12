import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import { pyRepr } from './conversions';
import { method } from './define';
import { argument } from './nativeArgs';
import { currentRuntime } from './runtimeContext';
import { builtinClass, None, pyError, typeError } from './types';
import { PyInstance, type PyValue } from './values';

/** The Turtle class, which programs may also extend. */
export const turtleClass = builtinClass('Turtle', undefined, true);
turtleClass.layout = { base: 'turtle' };
turtleClass.isWrittenInPython = true;

method(
  turtleClass,
  '__init__',
  'takes',
  0,
  3,
  (self, args, kwargs) => {
    const turtle = self as PyInstance;
    const x = argument(args, kwargs, 0, 'x') ?? 0n;
    const y = argument(args, kwargs, 1, 'y') ?? 0n;
    const color = argument(args, kwargs, 2, 'color');
    if ((typeof x !== 'bigint' && typeof x !== 'boolean') || (typeof y !== 'bigint' && typeof y !== 'boolean')) {
      throw typeError(`Invalid position: (${pyRepr(x)}, ${pyRepr(y)})`);
    }
    if (color !== undefined && color !== None && typeof color !== 'string')
      throw typeError(`Invalid color: ${pyRepr(color)}`);
    const created = currentRuntime().world.create(Number(x), Number(y), typeof color === 'string' ? color : undefined);
    if ('error' in created) throw pyError('RuntimeError', created.error);
    turtle.turtle = created;
    return None;
  },
  { keywords: ['x', 'y', 'color'] }
);

function stateOf(self: PyValue, name: string): TurtleState {
  const state = self instanceof PyInstance ? self.turtle : undefined;
  if (!state) throw typeError(`Turtle.${name}() requires a turtle`);
  return state;
}

function defineTurtleMethod(names: readonly string[], run: (state: TurtleState) => PyValue): void {
  for (const name of names) {
    method(turtleClass, name, 'none', 0, 0, (self) => {
      currentRuntime().spend();
      return run(stateOf(self, name));
    });
  }
}

for (const [names, sign] of [
  [TURTLE_METHOD_NAMES.forward, 1],
  [TURTLE_METHOD_NAMES.backward, -1],
] as const) {
  defineTurtleMethod(names, (state) => {
    const error = currentRuntime().world.move(state, sign);
    if (error) throw pyError('RuntimeError', error);
    return None;
  });
}
for (const [names, quarters] of [
  [TURTLE_METHOD_NAMES.turnRight, 1],
  [TURTLE_METHOD_NAMES.turnLeft, 3],
] as const) {
  defineTurtleMethod(names, (state) => {
    currentRuntime().world.turn(state, quarters);
    return None;
  });
}
defineTurtleMethod(TURTLE_METHOD_NAMES.canMoveForward, (state) => {
  // The method itself runs as a native call.
  currentRuntime().collectGarbage(1);
  return currentRuntime().world.canMoveForward(state);
});
defineTurtleMethod(TURTLE_METHOD_NAMES.isFrontPainted, (state) => currentRuntime().world.isFrontPainted(state));
defineTurtleMethod(TURTLE_METHOD_NAMES.remove, (state) => {
  currentRuntime().world.remove(state);
  return None;
});
