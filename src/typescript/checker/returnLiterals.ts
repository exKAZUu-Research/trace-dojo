import type { Checker } from './checker';
import { type LiteralType, regularOf, type Type } from './types';

/**
 * The type a function returns for the literal its body alone returns: TypeScript widens it unless the contextual
 * return type takes literals of its kind.
 */
export function returnedLiteralType(c: Checker, literal: LiteralType, contextual: Type | undefined): Type {
  const keeps = isLiteralOfContextualType(c, literal, contextual);
  return regularOf(keeps ? literal : c.widenLiteral(literal));
}

/** TypeScript's `isLiteralOfContextualType`: whether a contextual type takes the literals of a literal's kind. */
function isLiteralOfContextualType(c: Checker, candidate: LiteralType, contextual: Type | undefined): boolean {
  if (!contextual) return false;
  if (contextual.kind === 'union' || contextual.kind === 'intersection')
    return contextual.types.some((member) => isLiteralOfContextualType(c, candidate, member));
  const kind = typeof candidate.value;
  if (contextual.kind === 'typeParameter' || contextual.kind === 'indexedAccess' || contextual.kind === 'conditional') {
    // A type variable constrained to a primitive takes the literals of that primitive.
    const constraint = c.baseConstraint(contextual);
    if (constraint === contextual) return false;
    return (
      (kind !== 'boolean' && mayBePrimitive(constraint, kind)) || isLiteralOfContextualType(c, candidate, constraint)
    );
  }
  if (contextual.kind === 'literal') return typeof contextual.value === kind;
  return (
    kind === 'string' &&
    (contextual.kind === 'keyof' || contextual.kind === 'templateLiteral' || contextual.kind === 'stringMapping')
  );
}

/** TypeScript's `maybeTypeOfKind` for the primitive of a literal kind, as `string` in `string | number`. */
function mayBePrimitive(type: Type, kind: string): boolean {
  if (type.kind === 'union' || type.kind === 'intersection')
    return type.types.some((member) => mayBePrimitive(member, kind));
  return type.kind === 'intrinsic' && type.name === kind;
}
