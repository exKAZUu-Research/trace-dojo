import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { byteArray } from '../bytes';
import type { Frame } from '../runtime';
import { BOOL, ClassInfo, INT, type Type, VOID } from '../types';
import { CObject } from '../values';
import type { Ptr } from '../values';
import { addMethod, CONST_CHAR_PTR, constRef, native, nativeConstructor, readCString, throwLibrary } from './support';

/**
 * `Turtle`, which a program uses without including anything: `Turtle t;`, `Turtle t(x, y);`, or
 * `Turtle t(x, y, "R");`, with the methods of every language's Turtle. A turtle cannot be copied, as it stands for one
 * turtle on the board; it leaves the board when its object's lifetime ends.
 */
export function turtleClass(runtimeError: () => ClassInfo, stringType: () => Type): ClassInfo {
  const cls = new ClassInfo('Turtle', 'class');
  cls.isTurtle = true;
  cls.isNoncopyable = true;
  cls.isAssignmentDeleted = true;
  cls.isComplete = true;
  cls.library = { kind: 'Turtle', args: [], size: 8, align: 8 };
  const create = (frame: Frame, x: unknown, y: unknown, color: string | undefined): CObject => {
    const created = frame.runtime.world.create(Number(x ?? 0), Number(y ?? 0), color);
    if ('error' in created) return throwLibrary(frame, runtimeError(), created.error);
    const object = new CObject(cls, []);
    object.turtle = created;
    return object;
  };
  cls.constructors = [
    nativeConstructor(cls, [], (_args, { frame }) => create(frame, 0, 0, undefined)),
    nativeConstructor(cls, [INT, INT], ([x, y], { frame }) => create(frame, x, y, undefined)),
    nativeConstructor(cls, [INT, INT, CONST_CHAR_PTR], ([x, y, color], { frame }) =>
      create(frame, x, y, readCString(color as Ptr))
    ),
    nativeConstructor(cls, [INT, INT, constRef(stringType())], ([x, y, color], { frame }) =>
      create(frame, x, y, latin1ToText((color as Ptr).read() as unknown as { bytes: string }))
    ),
  ];
  for (const [names, sign] of [
    [TURTLE_METHOD_NAMES.forward, 1],
    [TURTLE_METHOD_NAMES.backward, -1],
  ] as const) {
    for (const name of names) {
      addMethod(
        cls,
        native(name, [], VOID, (_args, { self, frame }) => {
          const error = frame.runtime.world.move(stateOf(self), sign);
          if (error) throwLibrary(frame, runtimeError(), error);
          return;
        })
      );
    }
  }
  for (const [names, quarters] of [
    [TURTLE_METHOD_NAMES.turnRight, 1],
    [TURTLE_METHOD_NAMES.turnLeft, 3],
  ] as const) {
    for (const name of names) {
      addMethod(
        cls,
        native(name, [], VOID, (_args, { self, frame }) => frame.runtime.world.turn(stateOf(self), quarters))
      );
    }
  }
  for (const name of TURTLE_METHOD_NAMES.canMoveForward) {
    addMethod(
      cls,
      native(
        name,
        [],
        BOOL,
        (_args, { self, frame }) => {
          frame.runtime.collectGarbage();
          return frame.runtime.world.canMoveForward(stateOf(self)) ? 1 : 0;
        },
        { isConst: true }
      )
    );
  }
  for (const name of TURTLE_METHOD_NAMES.isFrontPainted) {
    addMethod(
      cls,
      native(name, [], BOOL, (_args, { self, frame }) => (frame.runtime.world.isFrontPainted(stateOf(self)) ? 1 : 0), {
        isConst: true,
      })
    );
  }
  for (const name of TURTLE_METHOD_NAMES.remove) {
    addMethod(
      cls,
      native(name, [], VOID, (_args, { self, frame }) => frame.runtime.world.remove(stateOf(self)))
    );
  }
  cls.operations = {
    copy: () => {
      throw new Error('Turtle cannot be copied');
    },
    assign: () => {
      throw new Error('Turtle cannot be assigned');
    },
    destroy: (frame, object) => {
      const turtle = (object as CObject).turtle;
      if (turtle?.isAlive) frame.runtime.world.remove(turtle);
    },
  };
  return cls;
}

const stateOf = (self: unknown): TurtleState => (self as CObject).turtle as TurtleState;

/** Decodes the bytes of a `std::string` as UTF-8 text. */
function latin1ToText(value: { bytes: string }): string {
  return new TextDecoder().decode(byteArray(value.bytes));
}
