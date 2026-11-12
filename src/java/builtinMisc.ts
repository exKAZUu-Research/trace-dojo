import { javaEquals, javaHash } from './builtinCollections';
import { stringify } from './builtins';
import { addConstructor, addInterface, addMethod, defineInterface, newString, type Registry } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import {
  arrayInterfaces,
  BOOLEAN,
  type ClassInfo,
  DOUBLE,
  FLOAT,
  INT,
  type JavaType,
  LONG,
  type TypeVariable,
  VOID,
} from './types';
import type { JavaArray, JavaObject, JavaString, Value } from './values';
import { toInt32, toInt64 } from './values';

export function defineMisc(registry: Registry, objectClass: ClassInfo, stringType: JavaType): void {
  defineObjects(registry, objectClass, stringType);
  defineRandom(registry, objectClass);
  arrayInterfaces.add(defineInterface(registry, 'Cloneable', 'java.lang'));
  defineSystemQueries(registry.classes.get('System') as ClassInfo, stringType);
  // Programs pause between turtle moves, which a trace shows step by step, so sleeping returns at once.
  const thread = registry.define('Thread', objectClass);
  const sleep = addMethod(thread, 'sleep', [LONG], VOID, true, () => {});
  sleep.thrownTypes = [registry.classes.get('InterruptedException') as ClassInfo];
}

/**
 * `Serializable`, which only marks classes, implemented by the builtin classes whose JDK counterparts implement it
 * directly; their subclasses, such as every exception and wrapper, inherit it.
 */
export function defineSerializable(registry: Registry): void {
  const cls = defineInterface(registry, 'Serializable', 'java.io');
  arrayInterfaces.add(cls);
  for (const name of SERIALIZABLE_CLASSES)
    addInterface(registry.classes.get(name) as ClassInfo, { kind: 'class', cls });
}

const SERIALIZABLE_CLASSES = [
  'String',
  'Class',
  'Enum',
  'Throwable',
  'Number',
  'Character',
  'Boolean',
  'StringBuilder',
  'StringBuffer',
  'ArrayList',
  'Stack',
  'LinkedList',
  'ArrayDeque',
  'PriorityQueue',
  'HashSet',
  'LinkedHashSet',
  'TreeSet',
  'EnumSet',
  'HashMap',
  'LinkedHashMap',
  'TreeMap',
  'EnumMap',
  'Random',
  'Locale',
  'File',
];

function defineObjects(registry: Registry, objectClass: ClassInfo, stringType: JavaType): void {
  const cls = registry.define('Objects', objectClass, 'java.util');
  const objectType = objectClass.type;
  addMethod(cls, 'equals', [objectType, objectType], BOOLEAN, true, (frame, _, [a, b]) => javaEquals(frame, a, b));
  addMethod(cls, 'hashCode', [objectType], INT, true, (frame, _, [value]) => javaHash(frame, value));
  const hash = addMethod(cls, 'hash', [{ kind: 'array', element: objectType }], INT, true, (frame, _, [values]) => {
    // Objects.hash computes Arrays.hashCode of its arguments.
    let result = 1;
    for (const value of (values as JavaArray).values) result = toInt32(Math.imul(result, 31) + javaHash(frame, value));
    return result;
  });
  hash.isVarargs = true;
  addMethod(cls, 'isNull', [objectType], BOOLEAN, true, (_, __, [value]) => value === undefined);
  addMethod(cls, 'nonNull', [objectType], BOOLEAN, true, (_, __, [value]) => value !== undefined);
  addMethod(cls, 'toString', [objectType], stringType, true, (frame, _, [value]) =>
    newString(frame, stringify(frame, value, objectType))
  );
  addMethod(cls, 'toString', [objectType, stringType], stringType, true, (frame, _, [value, fallback]) =>
    value === undefined ? fallback : newString(frame, stringify(frame, value, objectType))
  );
  for (const parameterTypes of [[], [stringType]]) {
    const variable: TypeVariable = { name: 'T', bounds: [objectType] };
    const t: JavaType = { kind: 'typeVar', variable };
    const method = addMethod(cls, 'requireNonNull', [t, ...parameterTypes], t, true, (frame, _, [value, message]) => {
      if (value === undefined) throwBuiltin(frame, 'NullPointerException', (message as JavaString | undefined)?.value);
      return value;
    });
    method.typeParameters = [variable];
  }
  const fallbackVariable: TypeVariable = { name: 'T', bounds: [objectType] };
  const fallbackType: JavaType = { kind: 'typeVar', variable: fallbackVariable };
  addMethod(
    cls,
    'requireNonNullElse',
    [fallbackType, fallbackType],
    fallbackType,
    true,
    (frame, _, [value, fallback]) => {
      if (value !== undefined) return value;
      if (fallback === undefined) throwBuiltin(frame, 'NullPointerException', 'defaultObj');
      return fallback;
    }
  ).typeParameters = [fallbackVariable];
}

const MULTIPLIER = 0x5_de_ec_e6_6dn;
const MASK = (1n << 48n) - 1n;

/** The state of a `java.util.Random`, whose linear congruential generator Java specifies exactly. */
const seeds = new WeakMap<JavaObject, bigint>();

function scramble(seed: bigint): bigint {
  return (seed ^ MULTIPLIER) & MASK;
}

/** Advances the generator and returns its next `bits` bits as a signed int, as `Random.next` does. */
function next(random: JavaObject, bits: number): number {
  const seed = ((seeds.get(random) as bigint) * MULTIPLIER + 0xbn) & MASK;
  seeds.set(random, seed);
  return Number(BigInt.asIntN(32, seed >> BigInt(48 - bits)));
}

function nextInt(frame: Frame, random: JavaObject, bound: number): number {
  if (bound <= 0) throwBuiltin(frame, 'IllegalArgumentException', 'bound must be positive');
  // A power of two takes the high bits; other bounds reject the values that would bias the result.
  if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(next(random, 31))) >> 31n);
  for (;;) {
    const bits = next(random, 31);
    const value = bits % bound;
    if (bits - value + (bound - 1) <= 2_147_483_647) return value;
    frame.runtime.spend();
  }
}

/** `nextInt(origin, bound)`, which Java 17 and later compute as `RandomSupport.boundedNextInt` does. */
function boundedNextInt(frame: Frame, random: JavaObject, origin: number, bound: number): number {
  let result = next(random, 32);
  const range = toInt32(bound - origin);
  const mask = toInt32(range - 1);
  if ((range & mask) === 0) return toInt32((result & mask) + origin);
  if (range > 0) {
    for (
      let unsigned = result >>> 1;
      toInt32(unsigned + mask - (result = unsigned % range)) < 0;
      unsigned = next(random, 32) >>> 1
    ) {
      frame.runtime.spend();
    }
    return toInt32(result + origin);
  }
  while (result < origin || result >= bound) result = next(random, 32);
  return result;
}

function nextDouble(random: JavaObject): number {
  return (Number(BigInt(next(random, 26)) << 27n) + next(random, 27)) * 2 ** -53;
}

function randomOf(receiver: Value): JavaObject {
  return receiver as JavaObject;
}

function defineRandom(registry: Registry, objectClass: ClassInfo): void {
  const cls = registry.define('Random', objectClass, 'java.util');
  addConstructor(cls, [], (_, receiver) => {
    // An unseeded generator differs on every run, as Java's does.
    seeds.set(randomOf(receiver), scramble(BigInt(Math.floor(Math.random() * 2 ** 48))));
  });
  addConstructor(cls, [LONG], (_, receiver, [seed]) => {
    seeds.set(randomOf(receiver), scramble(BigInt.asUintN(64, seed as bigint)));
  });
  addMethod(cls, 'setSeed', [LONG], VOID, false, (_, receiver, [seed]) => {
    seeds.set(randomOf(receiver), scramble(BigInt.asUintN(64, seed as bigint)));
  });
  addMethod(cls, 'nextInt', [], INT, false, (_, receiver) => next(randomOf(receiver), 32));
  addMethod(cls, 'nextInt', [INT], INT, false, (frame, receiver, [bound]) =>
    nextInt(frame, randomOf(receiver), bound as number)
  );
  addMethod(cls, 'nextInt', [INT, INT], INT, false, (frame, receiver, [origin, bound]) => {
    const [low, high] = [origin as number, bound as number];
    if (low >= high) throwBuiltin(frame, 'IllegalArgumentException', 'bound must be greater than origin');
    return boundedNextInt(frame, randomOf(receiver), low, high);
  });
  addMethod(cls, 'nextLong', [], LONG, false, (_, receiver) =>
    toInt64((BigInt(next(randomOf(receiver), 32)) << 32n) + BigInt(next(randomOf(receiver), 32)))
  );
  addMethod(cls, 'nextBoolean', [], BOOLEAN, false, (_, receiver) => next(randomOf(receiver), 1) !== 0);
  addMethod(cls, 'nextDouble', [], DOUBLE, false, (_, receiver) => nextDouble(randomOf(receiver)));
  addMethod(cls, 'nextFloat', [], FLOAT, false, (_, receiver) => Math.fround(next(randomOf(receiver), 24) / 2 ** 24));
  const mathClass = registry.classes.get('Math') as ClassInfo;
  addMethod(mathClass, 'random', [], DOUBLE, true, () => Math.random());
}

/** `System`'s clocks, which learners read to time their code, and its line separator. */
function defineSystemQueries(systemClass: ClassInfo, stringType: JavaType): void {
  addMethod(systemClass, 'currentTimeMillis', [], LONG, true, () => BigInt(Date.now()));
  addMethod(systemClass, 'nanoTime', [], LONG, true, () => BigInt(Math.round(performance.now() * 1_000_000)));
  addMethod(systemClass, 'lineSeparator', [], stringType, true, (frame) => newString(frame, '\n'));
}
