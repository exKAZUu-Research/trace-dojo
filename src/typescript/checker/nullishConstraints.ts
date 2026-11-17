import type { Checker } from './checker';
import { intersectionOf, isAnyLike, isIntrinsic, mapType, type Type, unionOf, unknownType } from './types';

/**
 * A type without `null` and `undefined`, as TypeScript's `getNonNullableType` gives it: a generic member whose
 * constraint may be either is intersected with the rest of its constraint, as TypeScript's `T & {}` relates.
 */
export function nonNullableType(c: Checker, type: Type): Type {
  return mapType(type, (member): Type => {
    if (member.kind !== 'typeParameter' && member.kind !== 'indexedAccess' && member.kind !== 'conditional')
      return c.relations.removeNullish(member);
    const bound = nullishConstraint(c, member);
    if (isAnyLike(bound) || (!c.relations.isNullable(bound) && !isIntrinsic(bound, 'unknown'))) return member;
    return intersectionOf([member, c.relations.removeNullish(bound)], c.budget);
  });
}

/** What a type may be at most, which decides whether it may be nullish or falsy; `unknown` where nothing bounds it. */
export function nullishConstraint(c: Checker, type: Type, seen = new Set<number>()): Type {
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
