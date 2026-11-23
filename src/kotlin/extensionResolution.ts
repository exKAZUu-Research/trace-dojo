import type { PackageScope } from './compilerBase';
import type { MemberRef } from './compilerCore';
import type { FunctionSymbol, MemberSymbol, PropertySymbol, TypeParameterSymbol } from './symbols';
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

/**
 * The path a program imports to reach the prelude's extension `name` for a receiver of `type`, outside the default
 * imports: a package, as `kotlin.math` for `Double.roundToInt`, or an object, as `kotlin.time.Duration.Companion` for
 * `Int.seconds`.
 */
export function importableExtension(
  packages: ReadonlyMap<string, PackageScope>,
  defaultImports: readonly string[],
  type: KType,
  name: string
): string | undefined {
  const actual = resolved(type);
  const receiver = actual.nullable ? { ...actual, nullable: false } : actual;
  const declares = (symbols: readonly (MemberSymbol | FunctionSymbol | PropertySymbol)[]): boolean =>
    symbols.some((symbol) => symbol.isLibrary && acceptsReceiver(symbol.extensionReceiver, receiver));
  for (const [packageName, scope] of packages) {
    const topLevel = [...(scope.functions.get(name) ?? []), ...(scope.properties.get(name) ?? [])];
    if (!defaultImports.includes(packageName) && declares(topLevel)) return packageName;
    for (const cls of scope.classes.values()) {
      for (const holder of [cls, cls.companion]) {
        if (holder?.isObject && declares(holder.members.get(name) ?? []))
          return holder === cls ? `${packageName}.${cls.name}` : `${packageName}.${cls.name}.Companion`;
      }
    }
  }
  return undefined;
}

/** Whether an extension declared for `declared` applies to a receiver of `receiver`, whatever its type arguments. */
function acceptsReceiver(declared: KType | undefined, receiver: KType): boolean {
  if (!declared) return false;
  const actual = resolved(declared);
  if (actual.kind !== 'class') return true;
  return isSubtype(receiver, {
    ...actual,
    args: actual.args.map(() => ({ variance: 'star' as const })),
    nullable: true,
  });
}
