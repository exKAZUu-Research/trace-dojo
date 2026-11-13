import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import { inspect } from './conversions';
import { def } from './define';
import { rubyError, typeError } from './errors';
import type { Gen } from './interp';
import { NIL, RObject, RString, type Value } from './objects';
import { rt } from './runtime';

def(
  'Turtle',
  'initialize',
  [0, 3],
  function* (self: RObject, args): Gen {
    const [x = 0n, y = 0n, color = NIL] = args;
    if (typeof x !== 'bigint' || typeof y !== 'bigint') {
      throw typeError(`Invalid position: (${yield* inspect(x)}, ${yield* inspect(y)})`);
    }
    if (color !== NIL && !(color instanceof RString)) throw typeError(`Invalid color: ${yield* inspect(color)}`);
    const created = rt().world.create(Number(x), Number(y), color instanceof RString ? color.s : undefined);
    if ('error' in created) throw rubyError(rt().c.RuntimeError, created.error);
    self.turtle = created;
    return NIL;
  },
  { visibility: 'private' }
);

function stateOf(self: Value, name: string): TurtleState {
  const state = self instanceof RObject ? self.turtle : undefined;
  if (!state) throw typeError(`Turtle#${name} requires a turtle`);
  return state;
}

function defineTurtleMethod(names: readonly string[], run: (state: TurtleState) => Value): void {
  for (const name of names) {
    def('Turtle', name, 0, (self) => {
      rt().spend();
      return run(stateOf(self, name));
    });
  }
}

for (const [names, sign] of [
  [TURTLE_METHOD_NAMES.forward, 1],
  [TURTLE_METHOD_NAMES.backward, -1],
] as const) {
  defineTurtleMethod(names, (state) => {
    const error = rt().world.move(state, sign);
    if (error) throw rubyError(rt().c.RuntimeError, error);
    return NIL;
  });
}
for (const [names, quarters] of [
  [TURTLE_METHOD_NAMES.turnRight, 1],
  [TURTLE_METHOD_NAMES.turnLeft, 3],
] as const) {
  defineTurtleMethod(names, (state) => {
    rt().world.turn(state, quarters);
    return NIL;
  });
}
defineTurtleMethod(TURTLE_METHOD_NAMES.canMoveForward, (state) => {
  rt().collectGarbage();
  return rt().world.canMoveForward(state);
});
defineTurtleMethod(TURTLE_METHOD_NAMES.isFrontPainted, (state) => rt().world.isFrontPainted(state));
defineTurtleMethod(TURTLE_METHOD_NAMES.remove, (state) => {
  rt().world.remove(state);
  return NIL;
});
