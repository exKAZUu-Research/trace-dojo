import type { Place, Reference } from './evaluatorBase';
import { PendingException } from './numeric';
import { sameType, type Type } from './types';
import { CsStruct, type Value } from './values';

/** What a `TypedReference` made by `__makeref` holds; a default one holds nothing. */
export interface TypedReferenceTarget {
  reference: Reference;
  /** The variable's declared type, which `__refvalue` must name exactly. */
  type: Type;
}

export function newTypedReference(type: Type, target: TypedReferenceTarget): CsStruct {
  const value = new CsStruct(type as CsStruct['type'], []);
  value.native = target;
  return value;
}

export function typedReferenceTarget(value: Value): TypedReferenceTarget | undefined {
  return (value as CsStruct).native as TypedReferenceTarget | undefined;
}

/** The variable that `__refvalue(r, T)` names, which .NET refuses when r refers to a variable of another type. */
export function refValuePlace(value: Value, type: Type): Place {
  const target = typedReferenceTarget(value);
  if (!target || !sameType(target.type, type))
    throw new PendingException('System.InvalidCastException', 'Specified cast is not valid.');
  return target.reference;
}
