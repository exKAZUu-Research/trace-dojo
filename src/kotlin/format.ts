import { formatDouble, formatFloat } from '../java/values';
import { callFunction, runtimeClassOf } from './dispatch';
import { toInt32 } from './operators';
import type { Frame } from './runtime';
import type { FunctionSymbol } from './symbols';
import { Boxed, KObject, type PrimitiveKind, UNIT, type Value } from './values';

/** The members of `Any` that natives call on values of the program's classes. */
export interface AnyMembers {
  toString: FunctionSymbol;
  equals: FunctionSymbol;
  hashCode: FunctionSymbol;
}

let anyMembers: AnyMembers | undefined;

export function setAnyMembers(members: AnyMembers): void {
  anyMembers = members;
}

function members(): AnyMembers {
  if (!anyMembers) throw new Error('The members of Any are not loaded');
  return anyMembers;
}

/** A Kotlin `Char`, which is one UTF-16 code unit, as a string. */
export function charToString(code: number): string {
  // oxlint-disable-next-line unicorn/prefer-code-point -- Kotlin chars are UTF-16 code units, which may be half a surrogate pair.
  return String.fromCharCode(code);
}

/** Formats a primitive value as `toString` does. */
// code-gauge-allow duplicateLines 16 -- converts a primitive to text, which differs from trace.ts's conversion to a trace value in every case.
export function formatPrimitive(kind: PrimitiveKind, value: number | bigint): string {
  switch (kind) {
    case 'Double': {
      return formatDouble(value as number);
    }
    case 'Float': {
      return formatFloat(value as number);
    }
    case 'Char': {
      return charToString(value as number);
    }
    case 'UInt': {
      return String((value as number) >>> 0);
    }
    default: {
      return String(value);
    }
  }
}

/** Converts a value to a string as `toString()` and string templates do, calling the program's `toString`. */
export function stringOf(frame: Frame, value: Value): string {
  if (value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Boxed) return formatPrimitive(value.kind, value.value);
  if (value === UNIT) return 'kotlin.Unit';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return callFunction(members().toString, frame, value, [], undefined) as string;
}

/** `==` of two references, which calls `equals`. */
export function valueEquals(frame: Frame, a: Value, b: Value): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a instanceof Boxed) return b instanceof Boxed && a.kind === b.kind && boxedEquals(a, b);
  if (!(a instanceof KObject)) return a === b;
  return callFunction(members().equals, frame, a, [b], undefined) as boolean;
}

/** `Double.equals` and `Float.equals`, which compare bits: NaN equals NaN and 0.0 differs from -0.0. */
function boxedEquals(a: Boxed, b: Boxed): boolean {
  if (a.kind === 'Double' || a.kind === 'Float') return Object.is(a.value, b.value);
  return a.value === b.value;
}

/** `hashCode()` of a value, as the JVM computes it for the standard library's types. */
export function hashOf(frame: Frame, value: Value): number {
  if (value === undefined) return 0;
  if (typeof value === 'string') return stringHash(value, frame);
  if (typeof value === 'boolean') return value ? 1231 : 1237;
  if (value instanceof Boxed) return boxedHash(value);
  if (value === UNIT) return identityHash(value);
  if (value instanceof KObject) return callFunction(members().hashCode, frame, value, [], undefined) as number;
  return 0;
}

export function stringHash(text: string, frame?: Frame): number {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    if (index % 64 === 0) frame?.runtime.spend();
    // oxlint-disable-next-line unicorn/prefer-code-point -- Java hashes UTF-16 code units.
    hash = toInt32(Math.imul(31, hash) + text.charCodeAt(index));
  }
  return hash;
}

const hashView = new DataView(new ArrayBuffer(8));

function boxedHash(value: Boxed): number {
  switch (value.kind) {
    case 'Long':
    case 'ULong': {
      const bits = BigInt.asUintN(64, value.value as bigint);
      return Number(BigInt.asIntN(32, bits ^ (bits >> 32n)));
    }
    case 'Double': {
      const number = value.value as number;
      hashView.setFloat64(0, Number.isNaN(number) ? Number.NaN : number);
      return toInt32(hashView.getInt32(0) ^ hashView.getInt32(4));
    }
    case 'Float': {
      hashView.setFloat32(0, value.value as number);
      return hashView.getInt32(0);
    }
    default: {
      return toInt32(value.value as number);
    }
  }
}

/** An identity hash code, which the JVM picks arbitrarily and this interpreter derives from the object's identity. */
export function identityHash(value: Value): number {
  if (value instanceof KObject) return Math.imul(value.identity, 0x9e_37_79_b9) >>> 1;
  return 0x1b_6d_35_86;
}

/** `Any.toString()` for an object without its own: the class's binary name and the identity hash in hexadecimal. */
export function defaultToString(value: Value): string {
  return `${runtimeClassOf(value).qualifiedName}@${identityHash(value).toString(16)}`;
}
