// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import { invoke } from './calls';
import { requireClass } from './classes';
import { debugType } from './conversions';
import { throwError } from './errors';
import { collectGarbage } from './garbage';
import { callTargetOf, closureFromCallable, closureTarget } from './interp';
import { defineClass, installNatives, type NativeMethod } from './native';
import { rt } from './runtime';
import { type ClosureData, PhpObject, type Value } from './values';

/** Installs the builtin functions, constants, and classes into a new run. */
export function bootstrap(): void {
  installNatives();
}

defineClass({ name: 'stdClass' });
defineClass({ name: 'Traversable', kind: 'interface' });
defineClass({
  name: 'Iterator',
  kind: 'interface',
  interfaces: ['Traversable'],
  methods: ['current(): mixed', 'next(): void', 'key(): mixed', 'valid(): bool', 'rewind(): void'].map((signature) => ({
    signature,
    impl: () => null,
    isAbstract: true,
  })),
});
defineClass({
  name: 'SeekableIterator',
  kind: 'interface',
  interfaces: ['Iterator', 'Traversable'],
  methods: [{ signature: 'seek(int $offset): void', impl: () => null, isAbstract: true }],
});
defineClass({
  name: 'Serializable',
  kind: 'interface',
  methods: ['serialize()', 'unserialize(string $data)'].map((signature) => ({
    signature,
    impl: () => null,
    isAbstract: true,
  })),
});
defineClass({
  name: 'IteratorAggregate',
  kind: 'interface',
  interfaces: ['Traversable'],
  methods: [{ signature: 'getIterator(): Iterator', impl: () => null, isAbstract: true }],
});
defineClass({
  name: 'ArrayAccess',
  kind: 'interface',
  methods: [
    'offsetExists(mixed $offset): bool',
    'offsetGet(mixed $offset): mixed',
    'offsetSet(mixed $offset, mixed $value): void',
    'offsetUnset(mixed $offset): void',
  ].map((signature) => ({ signature, impl: () => null, isAbstract: true })),
});
defineClass({
  name: 'Countable',
  kind: 'interface',
  methods: [{ signature: 'count(): int', impl: () => null, isAbstract: true }],
});
defineClass({
  name: 'Stringable',
  kind: 'interface',
  methods: [{ signature: '__toString(): string', impl: () => null, isAbstract: true }],
});
defineClass({
  name: 'JsonSerializable',
  kind: 'interface',
  methods: [{ signature: 'jsonSerialize(): mixed', impl: () => null, isAbstract: true }],
});

function bindClosure(closure: PhpObject, newThis: Value, newScope: Value | undefined): Value {
  const data = closure.internal as ClosureData;
  let scope = data.scope;
  if (newScope !== undefined && newScope !== 'static') {
    if (newScope instanceof PhpObject) scope = newScope.cls;
    else if (newScope === null) scope = undefined;
    else scope = requireClass(String(newScope));
  }
  if (newThis !== null && !(newThis instanceof PhpObject)) return null;
  if (newThis instanceof PhpObject && data.isStatic && data.fn.kind === 'user' && data.fn.decl.isClosure) {
    throwError('Error', 'Cannot bind an instance to a static closure');
  }
  const runtime = rt();
  const bound = runtime.newObject(closure.cls);
  bound.internal = {
    ...data,
    bound: new Map(data.bound),
    thisObj: newThis instanceof PhpObject ? newThis : undefined,
    scope,
    calledClass: newThis instanceof PhpObject ? newThis.cls : scope,
  } satisfies ClosureData;
  return bound;
}

defineClass({
  name: 'Closure',
  isFinal: true,
  methods: [
    {
      signature: 'bind(Closure $closure, ?object $newThis, object|string|null $newScope = "static"): ?Closure',
      isStatic: true,
      impl: ({ args }) => bindClosure(args[0] as PhpObject, args[1], args[2]),
    },
    {
      signature: 'bindTo(?object $newThis, object|string|null $newScope = "static"): ?Closure',
      impl: ({ thisObj, args }) => bindClosure(thisObj, args[0], args[1]),
    },
    {
      signature: 'call(object $newThis, mixed ...$args): mixed',
      impl: ({ thisObj, args }) => {
        const [newThis, ...rest] = args;
        const object = newThis as PhpObject;
        const target = closureTarget(thisObj);
        return invoke(
          { ...target, thisObj: object, scope: object.cls, staticClass: object.cls },
          rest.map((v) => ({ v })),
          undefined
        );
      },
    },
    {
      signature: 'fromCallable(callable $callback): Closure',
      isStatic: true,
      impl: ({ args }) => {
        const callable = args[0];
        if (callable instanceof PhpObject && callable.cls.name === 'Closure') return callable;
        return closureFromCallable(callTargetOf(callable, false));
      },
    },
    {
      signature: '__invoke(mixed ...$args): mixed',
      impl: ({ thisObj, args }) =>
        invoke(
          closureTarget(thisObj),
          args.map((v) => ({ v })),
          undefined
        ),
    },
  ],
});

function turtleOf(object: PhpObject): TurtleState {
  const state = object.turtle;
  if (!state) throwError('Error', 'Turtle method called on an object that is not a turtle');
  return state;
}

function defineTurtleMethods(): NativeMethod[] {
  const methods: NativeMethod[] = [
    {
      signature: '__construct(int $x = 0, int $y = 0, ?string $color = null)',
      impl: ({ thisObj, args }) => {
        const [x = 0n, y = 0n, color] = args as [bigint?, bigint?, (string | null)?];
        if (color === null && args.length >= 3) throwError('RuntimeException', 'Invalid color: null');
        const created = rt().world.create(Number(x), Number(y), color ?? undefined);
        if ('error' in created) throwError('RuntimeException', created.error);
        thisObj.turtle = created;
        return null;
      },
    },
  ];
  const add = (names: readonly string[], returnType: string, run: (state: TurtleState) => Value): void => {
    for (const name of names) {
      methods.push({
        signature: `${name}(): ${returnType}`,
        impl: ({ thisObj }) => {
          rt().spend();
          return run(turtleOf(thisObj));
        },
      });
    }
  };
  for (const [names, sign] of [
    [TURTLE_METHOD_NAMES.forward, 1],
    [TURTLE_METHOD_NAMES.backward, -1],
  ] as const) {
    add(names, 'void', (state) => {
      const error = rt().world.move(state, sign);
      if (error) throwError('RuntimeException', error);
      return null;
    });
  }
  for (const [names, quarters] of [
    [TURTLE_METHOD_NAMES.turnRight, 1],
    [TURTLE_METHOD_NAMES.turnLeft, 3],
  ] as const) {
    add(names, 'void', (state) => {
      rt().world.turn(state, quarters);
      return null;
    });
  }
  add(TURTLE_METHOD_NAMES.canMoveForward, 'bool', (state) => {
    collectGarbage(rt());
    return rt().world.canMoveForward(state);
  });
  add(TURTLE_METHOD_NAMES.isFrontPainted, 'bool', (state) => rt().world.isFrontPainted(state));
  add(TURTLE_METHOD_NAMES.remove, 'void', (state) => {
    rt().world.remove(state);
    return null;
  });
  return methods;
}

defineClass({ name: 'Turtle', methods: defineTurtleMethods() });

export function typeName(value: Value): string {
  return debugType(value);
}
