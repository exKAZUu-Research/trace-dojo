import type { MemberRef } from './compilerCore';
import type { PropertySymbol, TypeParameterSymbol } from './symbols';
import { anyType, commonSupertype, isSubtype } from './typeRelations';
import { type KType, resolved, substitute } from './types';

export interface ReceiverSpecificity {
  type: KType;
  isGeneric: boolean;
}

export function extensionPropertySpecificity({ symbol, substitution }: MemberRef<PropertySymbol>): ReceiverSpecificity {
  return {
    type: substitute(symbol.extensionReceiver as KType, substitution),
    isGeneric: symbol.typeParameters.length > 0,
  };
}

export function mostSpecificReceivers<T>(
  candidates: T[],
  specificity: (candidate: T) => ReceiverSpecificity | undefined
): T[] {
  const ranked = candidates.map((candidate) => ({ candidate, receiver: specificity(candidate) }));
  return ranked
    .filter(
      ({ receiver }) => !receiver || !ranked.some((other) => other.receiver && isMoreSpecific(other.receiver, receiver))
    )
    .map(({ candidate }) => candidate);
}

function isMoreSpecific(left: ReceiverSpecificity, right: ReceiverSpecificity): boolean {
  if (!isSubtype(left.type, right.type)) return false;
  return !isSubtype(right.type, left.type) || (!left.isGeneric && right.isGeneric);
}

export function matchExtensionReceiver(
  typeParameters: TypeParameterSymbol[],
  declared: KType,
  receiverType: KType
): Map<TypeParameterSymbol, KType> | undefined {
  const variables = typeParameters.map((param) => ({
    param,
    lower: [] as KType[],
    upper: [] as KType[],
    fixed: undefined as KType | undefined,
  }));
  const substitution = new Map<TypeParameterSymbol, KType>();
  for (const variable of variables) substitution.set(variable.param, { kind: 'variable', variable, nullable: false });
  if (!isSubtype(receiverType, substitute(declared, substitution))) return undefined;
  for (const variable of variables) {
    const lower = variable.lower.map(resolved);
    variable.fixed = lower.length > 0 ? commonSupertype(lower) : (variable.upper[0] ?? anyType(true));
    substitution.set(variable.param, variable.fixed);
  }
  // A receiver must meet the bounds of the type parameter it gives, as `C : Collection<*>` of a collection's ifEmpty.
  for (const variable of variables) {
    const fixed = variable.fixed as KType;
    if (
      variable.lower.length > 0 &&
      variable.param.bounds.some((bound) => !isSubtype(fixed, substitute(bound, substitution)))
    )
      return undefined;
  }
  return substitution;
}
