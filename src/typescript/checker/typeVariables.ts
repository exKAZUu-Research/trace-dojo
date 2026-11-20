import { childTypes } from './genericTypes';
import type { ObjectType, Type } from './types';

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
  const own = ownTypeVariables(type, search);
  return own ?? childTypes(type).some((child) => visit(child, search));
}

/** Whether a type may hold a type parameter regardless of the types it holds, if that decides it. */
function ownTypeVariables(type: Type, search: Search): boolean | undefined {
  switch (type.kind) {
    case 'typeParameter':
    case 'conditional': {
      return true;
    }
    case 'union':
    case 'intersection': {
      if (type.kind === 'union' && type.aliasMapper) return undefined;
      if (type.types.length > 0) return undefined;
      search.incomplete = true;
      return true;
    }
    case 'object': {
      return ownObjectTypeVariables(type, search);
    }
    default: {
      return undefined;
    }
  }
}

function ownObjectTypeVariables(type: ObjectType, search: Search): boolean | undefined {
  if (type.aliasMapper) return undefined;
  switch (type.objectKind) {
    case 'interface': {
      return (type.typeParameters?.length ?? 0) > 0 || outerTypeVariables(type, search);
    }
    case 'anonymous': {
      return !type.nonGeneric;
    }
    case 'reference': {
      if (type.resolveReference) return outerTypeVariables(type, search);
      return (type.target !== undefined && outerTypeVariables(type.target, search)) || undefined;
    }
    case 'mapped': {
      return true;
    }
    default: {
      return undefined;
    }
  }
}

/** Whether a class or interface declared inside generic declarations has type parameters of theirs left unmapped. */
function outerTypeVariables(type: ObjectType, search: Search): boolean {
  if (!type.outerTypeParameters) return false;
  return !type.mapper || [...type.mapper.values()].some((argument) => visit(argument, search));
}
