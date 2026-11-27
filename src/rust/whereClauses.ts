import type { Generics } from './ast';
import { compileError, lowerBoundIfTrait, lowerType, type TypeScope } from './items';
import type { TraitRef, Type, TypeParam } from './types';

export function lowerTypeParamBounds(params: TypeParam[], generics: Generics, scope: TypeScope): void {
  for (const [index, param] of generics.params.entries()) {
    const target = params[index];
    target.bounds = param.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, { kind: 'param', param: target }));
  }
}

/**
 * Adds the bounds of a `where` clause to the type parameters they constrain, unless `elsewhere` takes them (a
 * method's bounds on its impl's parameters).
 */
export function addWherePredicates(
  generics: Generics,
  scope: TypeScope,
  elsewhere?: (param: TypeParam, bounds: TraitRef[]) => boolean,
  onOtherType?: (type: Type, bounds: TraitRef[]) => void
): void {
  for (const predicate of generics.where) {
    const type = lowerType(predicate.type, scope);
    if (type.kind !== 'param') {
      // A function's bound on another type (`Vec<T>: Debug`) is checked at each call and assumed in its body.
      if (!onOtherType) compileError(predicate.span, 'where には、型引数の境界だけを書いてください。');
      onOtherType(
        type,
        predicate.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, type))
      );
      continue;
    }
    const bounds = predicate.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, type));
    if (elsewhere?.(type.param, bounds)) continue;
    type.param.bounds.push(...bounds);
  }
}
