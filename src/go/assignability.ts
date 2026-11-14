import { type Constant, exactInteger, floatToRational, rationalToFloat, toRational } from './constants';
import {
  identical,
  integerBits,
  isBasic,
  isComplex,
  isFloat,
  isInteger,
  isInterface,
  isNumeric,
  isString,
  type MissingMethod,
  missingMethod,
  type Type,
  typeIdentityKey,
  underlying,
} from './types';
import { Complex, type Value } from './values';

export type Representation = { constant: Constant } | { error: 'overflows' | 'truncated' | 'mismatch' };

/** Converts a constant to a basic type, as an untyped constant converts implicitly or a typed one is checked. */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of basic type.
export function represent(constant: Constant, type: Type): Representation {
  const under = underlying(type);
  if (under.kind !== 'basic') return { error: 'mismatch' };
  const kind = under.basic;
  if (kind === 'bool' || kind === 'untypedBool') return constant.kind === 'bool' ? { constant } : { error: 'mismatch' };
  if (kind === 'string' || kind === 'untypedString') {
    return constant.kind === 'string' ? { constant } : { error: 'mismatch' };
  }
  if (constant.kind === 'bool' || constant.kind === 'string') return { error: 'mismatch' };
  if (isInteger(type)) {
    const value = exactInteger(constant);
    if (value === undefined) return { error: 'truncated' };
    if (kind === 'untypedInt' || kind === 'untypedRune') return { constant: { kind: 'int', value } };
    const { bits, signed } = integerBits(kind);
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
    if (value < min || value > max) return { error: 'overflows' };
    return { constant: { kind: 'int', value } };
  }
  if (isFloat(type)) {
    if (constant.kind === 'complex' && constant.im.num !== 0n) return { error: 'truncated' };
    const value = toRational(constant);
    if (kind === 'untypedFloat') return { constant: { kind: 'float', value } };
    const rounded = rationalToFloat(value, kind === 'float32');
    if (!Number.isFinite(rounded)) return { error: 'overflows' };
    return { constant: { kind: 'float', value: floatToRational(rounded) } };
  }
  if (isComplex(type)) {
    if (kind === 'untypedComplex') {
      return constant.kind === 'complex'
        ? { constant }
        : { constant: { kind: 'complex', re: toRational(constant), im: { num: 0n, den: 1n } } };
    }
    const re = toRational(constant);
    const im = constant.kind === 'complex' ? constant.im : { num: 0n, den: 1n };
    const single = kind === 'complex64';
    const roundedRe = rationalToFloat(re, single);
    const roundedIm = rationalToFloat(im, single);
    if (!Number.isFinite(roundedRe) || !Number.isFinite(roundedIm)) {
      return { error: 'overflows' };
    }
    return { constant: { kind: 'complex', re: floatToRational(roundedRe), im: floatToRational(roundedIm) } };
  }
  return { error: 'mismatch' };
}

/** The runtime value of a constant of the given type. */
export function constantValue(constant: Constant, type: Type): Value {
  switch (constant.kind) {
    case 'bool':
    case 'string': {
      return constant.value;
    }
    case 'int': {
      if (isFloat(type)) return floatOf(rationalToFloat({ num: constant.value, den: 1n }), type);
      if (isComplex(type)) return new Complex(complexPart(rationalToFloat({ num: constant.value, den: 1n }), type), 0);
      return constant.value;
    }
    case 'float': {
      if (isInteger(type)) return exactInteger(constant) ?? 0n;
      if (isComplex(type)) return new Complex(complexPart(rationalToFloat(constant.value), type), 0);
      return floatOf(rationalToFloat(constant.value), type);
    }
    case 'complex': {
      if (isComplex(type)) {
        return new Complex(
          complexPart(rationalToFloat(constant.re), type),
          complexPart(rationalToFloat(constant.im), type)
        );
      }
      if (isInteger(type)) return exactInteger(constant) ?? 0n;
      return floatOf(rationalToFloat(constant.re), type);
    }
  }
}

function floatOf(value: number, type: Type): number {
  return isBasic(type, 'float32') ? Math.fround(value) : value;
}

function complexPart(value: number, type: Type): number {
  return isBasic(type, 'complex64') ? Math.fround(value) : value;
}

/** A canonical key for a constant of a concrete type, for duplicate-case and duplicate-key checks. */
export function constantIdentityKey(constant: Constant, type: Type): string {
  const value = constantValue(constant, type);
  const prefix = typeIdentityKey(type);
  if (typeof value === 'bigint') return `${prefix}:i:${value}`;
  if (typeof value === 'number') return `${prefix}:f:${value === 0 ? 0 : value}`;
  if (value instanceof Complex) return `${prefix}:c:${value.re === 0 ? 0 : value.re},${value.im === 0 ? 0 : value.im}`;
  if (typeof value === 'boolean') return `${prefix}:b:${value}`;
  return `${prefix}:s:${value as string}`;
}

/** Why a value of type `from` is not assignable to `to`, or undefined when it is. */
export type AssignFailure = { kind: 'mismatch' } | { kind: 'missingMethod'; missing: MissingMethod };

/**
 * Whether a value of a typed type is assignable to another type, as the specification defines. Untyped constants
 * and nil are handled by the caller.
 */
export function assignFailure(from: Type, to: Type): AssignFailure | undefined {
  if (identical(from, to)) return undefined;
  const fromUnder = underlying(from);
  const toUnder = underlying(to);
  if (from.kind === 'basic' && from.basic === 'untypedNil') {
    return ['pointer', 'slice', 'map', 'func', 'interface'].includes(toUnder.kind) && to.kind !== 'typeParam'
      ? undefined
      : { kind: 'mismatch' };
  }
  if (from.kind === 'basic' && from.basic === 'untypedBool' && isBasic(to, 'bool') && to.kind !== 'typeParam')
    return undefined;
  if (isInterface(to)) {
    if (toUnder.kind !== 'interface') return { kind: 'mismatch' };
    if (toUnder.typeSet) return { kind: 'mismatch' };
    const missing = missingMethod(from, toUnder);
    return missing ? { kind: 'missingMethod', missing } : undefined;
  }
  // Identical underlying types, where at least one of the two is not a named type.
  const fromNamed = from.kind === 'named' || from.kind === 'basic' || from.kind === 'typeParam';
  const toNamed = to.kind === 'named' || to.kind === 'basic' || to.kind === 'typeParam';
  if (
    (!fromNamed || !toNamed) &&
    from.kind !== 'typeParam' &&
    to.kind !== 'typeParam' &&
    identical(fromUnder, toUnder)
  ) {
    return undefined;
  }
  return { kind: 'mismatch' };
}

/** Whether an explicit conversion `T(x)` from one non-constant type to another is allowed. */
// code-gauge-allow functionCognitiveComplexity 20 -- The conversion rules of the specification, one per line.
export function convertible(from: Type, to: Type): boolean {
  if (!assignFailure(from, to)) return true;
  const fromUnder = underlying(from);
  const toUnder = underlying(to);
  if (from.kind === 'typeParam' || to.kind === 'typeParam') {
    return typeParamConvertible(from, to);
  }
  if (identical(fromUnder, toUnder)) return true;
  if (
    fromUnder.kind === 'pointer' &&
    toUnder.kind === 'pointer' &&
    identical(underlying(fromUnder.element), underlying(toUnder.element))
  ) {
    return true;
  }
  if (isNumeric(from) && isNumeric(to)) return isComplex(from) === isComplex(to);
  if (isString(to) && (isInteger(from) || isByteOrRuneSlice(from))) return true;
  if (isString(from) && isByteOrRuneSlice(to)) return true;
  if (fromUnder.kind === 'slice' && toUnder.kind === 'array' && identical(fromUnder.element, toUnder.element))
    return true;
  if (
    fromUnder.kind === 'slice' &&
    toUnder.kind === 'pointer' &&
    underlying(toUnder.element).kind === 'array' &&
    identical(fromUnder.element, (underlying(toUnder.element) as { element: Type }).element)
  ) {
    return true;
  }
  return false;
}

/** The types a type parameter allows, or the type itself. */
function termsOf(type: Type): Type[] {
  return type.kind === 'typeParam' ? (type.constraint.typeSet?.terms?.map((term) => term.type) ?? []) : [type];
}

function typeParamConvertible(from: Type, to: Type): boolean {
  const fromTerms = termsOf(from);
  const toTerms = termsOf(to);
  if (fromTerms.length === 0 || toTerms.length === 0) return false;
  return fromTerms.every((source) => toTerms.every((target) => convertible(source, target)));
}

export function isByteOrRuneSlice(type: Type): boolean {
  const under = underlying(type);
  return under.kind === 'slice' && (isBasic(under.element, 'uint8') || isBasic(under.element, 'int32'));
}
