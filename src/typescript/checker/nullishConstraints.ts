import type { Checker } from './checker';
import {
  emptyObjectType,
  filterType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  mapType,
  narrowedUnknownObjectType,
  neverType,
  nullType,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

/**
 * A type without `null` and `undefined`, as TypeScript's `getNonNullableType` gives it: a generic member whose
 * constraint may be either is intersected with the rest of its constraint, or with `{}` when nothing bounds it, as
 * TypeScript's `T & {}` relates.
 */
export function nonNullableType(c: Checker, type: Type, preserveVoid = false): Type {
  const isNullable = (member: Type): boolean =>
    isNullishLike(member, nullType) || isNullishLike(member, undefinedType, !preserveVoid);
  return mapType(type, (member): Type => {
    if (isIntrinsic(member, 'unknown')) return narrowedUnknownObjectType;
    if (isNullable(member)) return neverType;
    if (!isGenericMember(member) && member.kind !== 'intersection') return member;
    const bound = nullishConstraint(c, member);
    if (isAnyLike(bound)) return member;
    const rest = filterType(bound, (part) => !isNullable(part));
    if (isIntrinsic(rest, 'unknown')) return intersectionOf([member, emptyObjectType], c.budget);
    return rest === bound ? member : intersectionOf([member, rest], c.budget);
  });
}

/**
 * The part of a type that `value !== unit` keeps for `unit` `null` or `undefined`, as TypeScript's
 * `removeNullableByIntersection` gives it: a generic member that may be `unit` is intersected with the rest of its
 * constraint, or with `{}` when nothing bounds it, which keeps the other nullish value unless the type has it already.
 */
export function withoutNullishUnit(c: Checker, type: Type, unit: Type): Type {
  const other = isIntrinsic(unit, 'null') ? undefinedType : nullType;
  const hasOther = (type.kind === 'union' ? type.types : [type]).some((member) => isNullishLike(member, other));
  return mapType(type, (member): Type => {
    const rest = isGenericMember(member)
      ? boundWithoutUnit(nullishConstraint(c, member), unit, other, hasOther)
      : undefined;
    return rest ? intersectionOf([member, rest], c.budget) : member;
  });
}

/** What a bound that may be `unit` is without it, and without `other` too when `hasOther`; else `undefined`. */
function boundWithoutUnit(bound: Type, unit: Type, other: Type, hasOther: boolean): Type | undefined {
  if (isAnyLike(bound)) return undefined;
  if (isIntrinsic(bound, 'unknown')) return hasOther ? emptyObjectType : unionOf([emptyObjectType, other]);
  if (!(bound.kind === 'union' ? bound.types : [bound]).some((part) => isNullish(part, unit))) return undefined;
  return filterType(bound, (part) => !isNullish(part, unit) && !(hasOther && isNullish(part, other)));
}

/** What a type may be at most, which decides whether it may be nullish or falsy; `unknown` where nothing bounds it. */
export function nullishConstraint(c: Checker, type: Type, seen?: Set<number>): Type {
  if (!isGenericMember(type) && type.kind !== 'union' && type.kind !== 'intersection') return type;
  seen ??= new Set();
  c.budget.spend();
  if (seen.has(type.id)) return unknownType;
  seen.add(type.id);
  try {
    if (type.kind === 'typeParameter') {
      const constraint = c.constraintOf(type);
      return constraint ? nullishConstraint(c, constraint, seen) : unknownType;
    }
    if (type.kind === 'union') return unionOf(type.types.map((member) => nullishConstraint(c, member, seen)));
    if (type.kind === 'conditional')
      return unionOf([nullishConstraint(c, type.trueType, seen), nullishConstraint(c, type.falseType, seen)]);
    if (type.kind === 'indexedAccess') {
      const constraint = c.baseConstraint(type);
      return constraint.kind === 'indexedAccess' ? unknownType : nullishConstraint(c, constraint, seen);
    }
    if (type.kind === 'intersection')
      return intersectionOf(
        type.types.map((member) => nullishConstraint(c, member, seen)),
        c.budget
      );
    return type;
  } finally {
    seen.delete(type.id);
  }
}

function isGenericMember(type: Type): boolean {
  return type.kind === 'typeParameter' || type.kind === 'indexedAccess' || type.kind === 'conditional';
}

/** Whether a type is `unit`, `null` or `undefined`, or an intersection with it, where `void` counts as `undefined`. */
function isNullishLike(type: Type, unit: Type, includesVoid = true): boolean {
  return type.kind === 'intersection'
    ? type.types.some((part) => isNullish(part, unit, includesVoid))
    : isNullish(type, unit, includesVoid);
}

function isNullish(type: Type, unit: Type, includesVoid = true): boolean {
  if (unit.kind !== 'intrinsic') return false;
  return isIntrinsic(type, unit.name) || (includesVoid && unit.name === 'undefined' && isIntrinsic(type, 'void'));
}
