import type { TypeAliasItem } from './ast';
import { compileError, declareTypeParams, lowerType, type Module, type TypeScope } from './items';
import type { Type, TypeParam } from './types';

/**
 * A type alias's parameters and the type it stands for, lowered once when first asked for, which reports an alias
 * that uses itself (E0391).
 */
export function typeAlias(item: TypeAliasItem, module: Module): { params: TypeParam[]; resolve: () => Type } {
  let resolved: Type | undefined;
  let resolving = false;
  const params = declareTypeParams(item.generics);
  const scope: TypeScope = { module, params: new Map(params.map((param) => [param.name, param])), selfType: undefined };
  const resolve = (): Type => {
    if (resolved) return resolved;
    if (resolving) compileError(item.span, `型の別名 ${item.name} が、自分自身を使っています（E0391）。`);
    resolving = true;
    try {
      resolved = lowerType(item.type, scope);
    } finally {
      resolving = false;
    }
    return resolved;
  };
  return { params, resolve };
}
