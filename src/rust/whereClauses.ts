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
      if (!onOtherType) {
        compileError(
          predicate.span,
          '型や impl の where 節で、型引数でない型に付ける境界は、この採点環境では使えません。'
        );
      }
      onOtherType(
        type,
        predicate.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, type))
      );
      continue;
    }
    if (predicate.bounds.some((bound) => bound.kind === 'maybeSized')) type.param.maybeUnsized = true;
    const bounds = predicate.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, type));
    if (elsewhere?.(type.param, bounds)) continue;
    type.param.bounds.push(...bounds);
  }
}
