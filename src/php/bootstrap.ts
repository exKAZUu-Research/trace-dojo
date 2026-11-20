// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { TURTLE_METHOD_NAMES, type TurtleState } from '../interpreter/turtleWorld';
import { closureFromValue, closureTarget, invokeCallbackTarget } from './callables';
import { type ArgValue, copyClosureData, invoke } from './calls';
import { findClass } from './classes';
import { debugType } from './conversions';
import { throwError, warn } from './errors';
import { collectGarbage } from './garbage';
import { defineClass, installNatives, type NativeMethod } from './native';
import { rt } from './runtime';
import { type ClosureData, PhpArray, type PhpClass, PhpObject, type Value } from './values';

/** Installs the builtin functions, constants, and classes into a new run. */
export function bootstrap(): void {
  installNatives();
}

defineClass({
  name: 'UnitEnum',
  kind: 'interface',
  methods: [{ signature: 'cases(): array', isStatic: true, impl: () => new PhpArray() }],
});
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
  methods: [{ signature: 'getIterator(): Traversable', impl: () => null, isAbstract: true }],
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

// code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function closureBinding(
  closure: PhpObject,
  newThis: Value,
  newScope: Value | undefined
): Pick<ClosureData, 'thisObj' | 'scope' | 'calledClass'> | undefined {
  const data = closure.internal as ClosureData;
  let scope = requestedClosureScope(newScope, data.scope);
  if (scope === false) return undefined;
  if (newThis !== null && !(newThis instanceof PhpObject)) return undefined;
  if (
    newThis instanceof PhpObject &&
    data.isStatic &&
    (data.method || (data.fn.kind === 'user' && data.fn.decl.isClosure))
  ) {
    warn('Cannot bind an instance to a static closure, this will be an error in PHP 9');
    return undefined;
  }
  const anonymous = data.fn.kind === 'user' && data.fn.decl.isClosure;
  const methodScope = !anonymous ? data.scope : undefined;
  const unbind = newThis === null ? closureUnbindWarning(data, Boolean(methodScope)) : undefined;
  if (unbind) {
    warn(unbind);
    return undefined;
  }
  if (methodScope && newThis instanceof PhpObject && !newThis.cls.isSubclassOf(methodScope)) {
    warn(
      `Cannot bind method ${methodScope.name}::${data.method?.name ?? data.fn.name}() to object of class ${newThis.cls.name}, this will be an error in PHP 9`
    );
    return undefined;
  }
  if (scope && !scope.decl && scope !== data.scope) {
    warn(`Cannot bind closure to scope of internal class ${scope.name}, this will be an error in PHP 9`);
    return undefined;
  }
  if (!anonymous && scope !== data.scope) {
    warn(
      `Cannot rebind scope of closure created from ${methodScope ? 'method' : 'function'}, this will be an error in PHP 9`
    );
    return undefined;
  }
  if (!scope && newThis instanceof PhpObject && data.fn.kind === 'user') scope = closure.cls;
  return {
    thisObj: newThis instanceof PhpObject && (data.fn.kind === 'user' || data.method) ? newThis : undefined,
    scope,
    calledClass: newThis instanceof PhpObject ? newThis.cls : scope,
  };
}

function closureUnbindWarning(data: ClosureData, method: boolean): string | undefined {
  if (method && !data.isStatic) return 'Cannot unbind $this of method, this will be an error in PHP 9';
  if (data.thisObj && data.fn.kind === 'user' && data.fn.decl.isClosure && data.fn.decl.usesThis)
    return 'Cannot unbind $this of closure using $this, this will be an error in PHP 9';
}

function requestedClosureScope(value: Value | undefined, current: PhpClass | undefined): PhpClass | undefined | false {
  if (value === undefined || value === 'static') return current;
  if (value === null) return undefined;
  if (value instanceof PhpObject) return value.cls;
  const name = value as string;
  const scope = findClass(name);
  if (scope) return scope;
  warn(`Class "${name}" not found`);
  return false;
}

function bindClosure(closure: PhpObject, newThis: Value, newScope: Value | undefined): Value {
  const binding = closureBinding(closure, newThis, newScope);
  if (!binding) return null;
  const bound = rt().newObject(closure.cls);
  bound.internal = { ...copyClosureData(closure.internal as ClosureData), ...binding } satisfies ClosureData;
  return bound;
}

defineClass({
  name: 'Closure',
  isFinal: true,
  compare: compareClosures,
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
      acceptsNamed: true,
      impl: ({ thisObj, args, named }) => {
        const [newThis, ...rest] = args;
        const binding = closureBinding(thisObj, newThis, newThis);
        if (!binding) return null;
        const target = closureTarget(thisObj);
        const forwarded: ArgValue[] = rest.map((v) => ({ v }));
        for (const [name, v] of named ?? []) forwarded.push({ name, v });
        return invokeCallbackTarget(
          { ...target, thisObj: binding.thisObj, scope: binding.scope, staticClass: binding.calledClass },
          forwarded,
          undefined
        );
      },
    },
    {
      signature: 'fromCallable(mixed $callback): Closure',
      isStatic: true,
      impl: ({ args }) => closureFromValue(args[0]),
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

function compareClosures(a: PhpObject, b: PhpObject): number {
  const left = a.internal as ClosureData;
  const right = b.internal as ClosureData;
  return left.isCallable &&
    right.isCallable &&
    left.thisObj === right.thisObj &&
    left.calledClass === right.calledClass &&
    left.scope === right.scope &&
    left.fn.kind === right.fn.kind &&
    (left.method?.name ?? left.fn.name) === (right.method?.name ?? right.fn.name)
    ? 0
    : 1;
}

function turtleOf(object: PhpObject): TurtleState {
  const state = object.turtle;
  if (!state) throwError('Error', 'Turtle method called on an object that is not a turtle');
  return state;
}
// code-gauge-allow functionNcss 34 -- The Turtle registrations share receiver state and movement helpers.
function defineTurtleMethods(): NativeMethod[] {
  const methods: NativeMethod[] = [
    {
      signature: '__construct(int $x = 0, int $y = 0, ?string $color = null)',
      impl: ({ thisObj, args }) => {
        const [x = 0n, y = 0n, color] = args as [bigint?, bigint?, (string | null)?];
        if (color === null && args.length >= 3) throwError('RuntimeException', 'Invalid color: null');
        const created = rt().world.create(Number(x), Number(y), color ?? undefined);
        if ('error' in created) throwError('RuntimeException', created.error);
        rt().attachTurtle(thisObj, created);
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
  add([...TURTLE_METHOD_NAMES.isFrontPainted, 'isFrontPainted'], 'bool', (state) => rt().world.isFrontPainted(state));
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
