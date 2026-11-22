import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { panic } from '../arith';
import { bytesToText } from '../builtins';
import { type NativeCall, runtime, type SemaApi, type TExpr } from '../semaBase';
import { BOOL, CONST_U8_SLICE, fnType, type StructType, type Type, typeName, VOID } from '../types';
import { NativeHandle, Pointer, type Slice, type Value } from '../values';
import { expectArgs, fnMember, type Member, nativeStruct } from './native';

/** `Turtle`, which programs use without importing it, as Java's `Turtle` class. */
export const TURTLE: StructType = nativeStruct('Turtle', {}, [], {
  kind: 'turtle',
  args: [],
  storageSlots: 1,
  byteSize: 8,
});

const members: Record<string, () => Member> = {
  init: fnMember('Turtle.init', (sema, call) => compileInit(sema, call)),
};

for (const [names, sign] of [
  [TURTLE_METHOD_NAMES.forward, 1],
  [TURTLE_METHOD_NAMES.backward, -1],
] as const) {
  for (const name of names) {
    members[name] = method(name, VOID, (state, frame) => {
      const error = frame.runtime.world.move(state, sign);
      if (error) panic(error);
      return;
    });
  }
}
for (const [names, quarters] of [
  [TURTLE_METHOD_NAMES.turnRight, 1],
  [TURTLE_METHOD_NAMES.turnLeft, 3],
] as const) {
  for (const name of names) {
    members[name] = method(name, VOID, (state, frame) => {
      frame.runtime.world.turn(state, quarters);
      return;
    });
  }
}
for (const name of TURTLE_METHOD_NAMES.canMoveForward) {
  members[name] = method(name, BOOL, (state, frame) => {
    frame.runtime.collectGarbage();
    return frame.runtime.world.canMoveForward(state);
  });
}
for (const name of TURTLE_METHOD_NAMES.isFrontPainted) {
  members[name] = method(name, BOOL, (state, frame) => frame.runtime.world.isFrontPainted(state));
}
for (const name of TURTLE_METHOD_NAMES.remove) {
  members[name] = method(name, VOID, (state, frame) => {
    frame.runtime.world.remove(state);
    return;
  });
}

for (const [name, resolve] of Object.entries(members)) {
  let resolved: Member | undefined;
  TURTLE.namespace.decls.set(name, {
    kind: 'native',
    name,
    resolve: () => {
      resolved ??= resolve();
      return resolved;
    },
  });
}

/**
 * `Turtle.init()`, `Turtle.init(x, y)`, or `Turtle.init(x, y, color)`, which the compiler checks like a builtin since
 * Zig has no overloading and the curriculum uses all three forms of Java's constructor; the coordinates may be of any
 * integer type.
 */
function compileInit(sema: SemaApi, call: NativeCall): TExpr {
  const count = call.args.length;
  if (count !== 0 && count !== 2 && count !== 3) {
    sema.error(call.span, 'Turtle.init の引数は、なし・(x, y)・(x, y, 色) のどれかにしてください。');
  }
  const coordinates = call.args.slice(0, 2).map((arg) => {
    const compiled = sema.compile(arg);
    if (compiled.type.kind !== 'int' && compiled.type.kind !== 'comptime_int') {
      sema.error(arg, `Turtle.init の座標は整数にしてください（${typeName(compiled.type)} 型です）。`);
    }
    return compiled.eval;
  });
  const color =
    count === 3
      ? sema.coerce(sema.compile(call.args[2], CONST_U8_SLICE), CONST_U8_SLICE, call.args[2]).eval
      : undefined;
  return runtime(
    TURTLE,
    (frame) => {
      frame.runtime.spend();
      const [x, y] = coordinates.map((evaluate) => Number(evaluate(frame) as bigint));
      const created = frame.runtime.world.create(
        x ?? 0,
        y ?? 0,
        color ? bytesToText(color(frame) as Slice) : undefined
      );
      if ('error' in created) panic(created.error);
      frame.runtime.allocate(1);
      return new NativeHandle('turtle', { turtle: created });
    },
    call.span
  );
}

// code-gauge-allow duplicateLines -- Method registration repeats scaffolding while receiver and runtime state representations differ.
function method(
  name: string,
  returnType: Type,
  run: (state: TurtleState, frame: Parameters<TExpr['eval']>[0]) => Value
): () => Member {
  return fnMember(
    `Turtle.${name}`,
    (sema, call) => {
      expectArgs(sema, call, 0, name);
      const receiver = call.receiver;
      if (!receiver) return sema.error(call.span, `${name} は、亀（Turtle の値）に対して呼び出してください。`);
      const evaluate = receiver.eval;
      return runtime(
        returnType,
        (frame) => {
          frame.runtime.spend();
          return run(turtleState(evaluate(frame)), frame);
        },
        call.span
      );
    },
    () => ({ type: fnType([TURTLE], returnType), receiver: true })
  );
}

function turtleState(value: Value): TurtleState {
  const target = value instanceof Pointer ? value.load() : value;
  const state = (target as NativeHandle | undefined)?.state?.turtle;
  if (!state) return panic('Turtle は Turtle.init で作ってください。');
  return state;
}
