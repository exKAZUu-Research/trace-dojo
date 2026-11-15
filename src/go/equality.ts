import { runtimeErrorPanic, unhashableKeyPanic } from './runtimeErrors';
import { identical, isComparable, type Type, typeIdentityKey, typeString, underlying } from './types';
import { type Complex, type GoArray, type GoStruct, Iface, type Pointer, type Value } from './values';

type Equal = (a: Value, b: Value) => boolean;

const equalCache = new WeakMap<Type, Equal>();

/** How `==` compares two values of a comparable type. */
export function equalityOf(type: Type): Equal {
  const cached = equalCache.get(type);
  if (cached) return cached;
  // A recursive type reaches itself through a pointer, which compares by identity, so the placeholder never runs.
  equalCache.set(type, (a, b) => (equalCache.get(type) as Equal)(a, b));
  const equal = buildEquality(type);
  equalCache.set(type, equal);
  return equal;
}

function buildEquality(type: Type): Equal {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      if (under.basic === 'complex64' || under.basic === 'complex128' || under.basic === 'untypedComplex') {
        return (a, b) => (a as Complex).re === (b as Complex).re && (a as Complex).im === (b as Complex).im;
      }
      return (a, b) => a === b;
    }
    case 'pointer': {
      return (a, b) => (a === undefined || b === undefined ? a === b : (a as Pointer).equals(b as Pointer));
    }
    case 'struct': {
      const fields = under.fields.map((field) => equalityOf(field.type));
      return (a, b) =>
        fields.every((equal, index) => equal((a as GoStruct).fields[index], (b as GoStruct).fields[index]));
    }
    case 'array': {
      const element = equalityOf(under.element);
      return (a, b) => (a as GoArray).elements.every((item, index) => element(item, (b as GoArray).elements[index]));
    }
    case 'interface': {
      return interfaceEqual;
    }
    case 'typeParam': {
      return (a, b) => a === b;
    }
    default: {
      // Slices, maps, and functions compare only with nil.
      return (a, b) => a === b;
    }
  }
}

function interfaceEqual(a: Value, b: Value): boolean {
  if (a === undefined || b === undefined) return a === b;
  const x = a as Iface;
  const y = b as Iface;
  if (!identical(x.type, y.type)) return false;
  if (!isComparable(x.type)) runtimeErrorPanic(`comparing uncomparable type ${typeString(x.type)}`);
  return equalityOf(x.type)(x.value, y.value);
}

type KeyOf = (value: Value) => unknown;

const keyCache = new WeakMap<Type, KeyOf>();
const identities = new WeakMap<object, number>();
let nextIdentity = 0;

function identityOf(object: object): number {
  let identity = identities.get(object);
  if (identity === undefined) {
    identity = nextIdentity++;
    identities.set(object, identity);
  }
  return identity;
}

/** The form of a map key that JavaScript's Map compares as Go compares the key. */
export function mapKeyOf(type: Type): KeyOf {
  const cached = keyCache.get(type);
  if (cached) return cached;
  keyCache.set(type, (value) => (keyCache.get(type) as KeyOf)(value));
  const keyOf = buildKey(type);
  keyCache.set(type, keyOf);
  return keyOf;
}

/**
 * Panics as Go's map lookup and delete do on a nil or empty map, which check the key without hashing it: with
 * `maps.unhashableTypeError` for the first dynamic value of an unhashable type the key holds (Go's mapKeyError).
 */
export function checkKeyHashable(type: Type, value: Value): void {
  const under = underlying(type);
  if (under.kind === 'interface') {
    if (!(value instanceof Iface)) return;
    if (!isComparable(value.type)) unhashableKeyPanic(typeString(value.type));
    checkKeyHashable(value.type, value.value);
  } else if (under.kind === 'array') {
    for (const element of (value as GoArray).elements) checkKeyHashable(under.element, element);
  } else if (under.kind === 'struct') {
    for (const [index, field] of under.fields.entries()) {
      if (field.name !== '_') checkKeyHashable(field.type, (value as GoStruct).fields[index]);
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 28 -- Visits every comparable Go value shape to build one canonical map key.
// code-gauge-allow functionNcss 35 -- Visits every comparable Go value shape to build one canonical map key.
function buildKey(type: Type): KeyOf {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      if (under.basic === 'complex64' || under.basic === 'complex128') {
        return (value) => {
          const { re, im } = value as Complex;
          return Number.isNaN(re) || Number.isNaN(im) ? Symbol('NaN') : `${re},${im}`;
        };
      }
      if (under.basic === 'float32' || under.basic === 'float64') {
        // Each NaN is a distinct key in Go, and 0 and -0 are the same key, as in Map.
        return (value) => (Number.isNaN(value) ? Symbol('NaN') : value);
      }
      return (value) => value;
    }
    case 'chan': {
      return (value) => (value === undefined ? 'nil' : `chan:${identityOf(value as object)}`);
    }
    case 'pointer': {
      return (value) => {
        if (value === undefined) return 'nil';
        const [base, key] = (value as Pointer).address();
        return `${identityOf(base)}:${String(key)}`;
      };
    }
    case 'struct': {
      const fields = under.fields.map((field) => mapKeyOf(field.type));
      return (value) =>
        JSON.stringify(fields.map((keyOf, index) => stringKey(keyOf((value as GoStruct).fields[index]))));
    }
    case 'array': {
      const element = mapKeyOf(under.element);
      return (value) => JSON.stringify((value as GoArray).elements.map((item) => stringKey(element(item))));
    }
    case 'interface': {
      return (value) => {
        if (value === undefined) return 'nil';
        const iface = value as Iface;
        if (!isComparable(iface.type)) runtimeErrorPanic(`hash of unhashable type ${typeString(iface.type)}`);
        return `${typeIdentityKey(iface.type)}|${stringKey(mapKeyOf(iface.type)(iface.value))}`;
      };
    }
    default: {
      return (value) => value;
    }
  }
}

function stringKey(key: unknown): string {
  if (typeof key === 'bigint') return `i${key}`;
  if (typeof key === 'number') return `f${key}`;
  if (typeof key === 'symbol') return `s${identityOf({})}`;
  return `${typeof key}:${String(key)}`;
}
