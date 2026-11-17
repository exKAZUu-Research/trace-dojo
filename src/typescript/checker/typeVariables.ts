import type { Type } from './types';

const results = new WeakMap<Type, boolean>();

interface Search {
  visited: Set<Type>;
  /** Whether the search met the union of an alias whose members are still being resolved. */
  incomplete: boolean;
}

/**
 * Whether instantiating a type may change it, as TypeScript's `couldContainTypeVariables` decides: a type parameter
 * may occur in it. Object types whose members are resolved lazily count as such, so a recursive type such as
 * `type Json = number | Json[]`, whose union and array refer to each other, is visited once.
 */
export function couldContainTypeVariables(type: Type): boolean {
  const cached = results.get(type);
  if (cached !== undefined) return cached;
  const search: Search = { visited: new Set(), incomplete: false };
  const result = visit(type, search);
  // The members of an alias being resolved are not known yet.
  if (search.incomplete) return result;
  // A false result holds for every type the search reached.
  if (result) results.set(type, true);
  else for (const visited of search.visited) results.set(visited, false);
  return result;
}

function visit(type: Type, search: Search): boolean {
  const cached = results.get(type);
  if (cached !== undefined) return cached;
  if (search.visited.has(type)) return false;
  search.visited.add(type);
  const some = (types: readonly Type[]): boolean => types.some((member) => visit(member, search));
  switch (type.kind) {
    case 'intrinsic':
    case 'literal': {
      return false;
    }
    case 'union':
    case 'intersection': {
      // A deferred union is not read, since reading its members instantiates them.
      if (type.kind === 'union' && type.deferred) return true;
      if (type.types.length === 0) search.incomplete = true;
      return type.types.length === 0 || some(type.types);
    }
    case 'object': {
      if (type.objectKind === 'reference') return some(type.typeArguments ?? []);
      if (type.objectKind === 'tuple') return some((type.tuple?.elements ?? []).map((element) => element.type));
      if (type.objectKind === 'interface') return (type.typeParameters?.length ?? 0) > 0;
      return !type.nonGeneric;
    }
    case 'indexedAccess': {
      return some([type.objectType, type.indexType]);
    }
    case 'keyof':
    case 'stringMapping': {
      return visit(type.type, search);
    }
    case 'templateLiteral': {
      return some(type.types);
    }
    default: {
      return true;
    }
  }
}
