import type { Checker, Mapper } from './checker';
import { anyType, isAnyLike, isIntrinsic, newTypeId, type Type, type TypeParameter } from './types';

/**
 * Whether a conditional type with this check or extends type waits for its type arguments, as TypeScript's
 * `isGenericType` decides: a type variable, an indexed access, a conditional type, a generic mapped type, or a union or
 * intersection holding one does; a type that holds type parameters only as type arguments or elements, as `T[][]`
 * does, does not.
 */
export function isGenericObjectOrIndexType(type: Type, except: readonly TypeParameter[] = []): boolean {
  switch (type.kind) {
    case 'typeParameter': {
      return !except.some((parameter) => parameter.id === type.id);
    }
    case 'indexedAccess':
    case 'conditional':
    case 'keyof': {
      return true;
    }
    case 'templateLiteral':
    case 'stringMapping': {
      return typeParametersIn(type, except).length > 0;
    }
    case 'union':
    case 'intersection': {
      return type.types.some((member) => isGenericObjectOrIndexType(member, except));
    }
    case 'object': {
      return type.objectKind === 'mapped';
    }
    default: {
      return false;
    }
  }
}

/**
 * The branch a conditional type whose check type is not generic takes, as TypeScript decides it: the false one when no
 * type arguments could make the check type extend the extends type, the true one when every type argument would, and
 * neither, so that the type is deferred, otherwise.
 */
export function conditionalBranch(
  c: Checker,
  checkType: Type,
  extendsType: Type
): 'true' | 'false' | 'both' | undefined {
  // Every type extends `any` and `unknown`, `any` included; it extends any other type ambiguously.
  if (isAnyLike(extendsType) || isIntrinsic(extendsType, 'unknown')) return 'true';
  if (isAnyLike(checkType)) return 'both';
  const parameters = [...typeParametersIn(checkType), ...typeParametersIn(extendsType)];
  if (parameters.length === 0) return c.relations.isAssignable(checkType, extendsType) ? 'true' : 'false';
  const isAssignableWith = (map: (parameter: TypeParameter) => Type): boolean => {
    const mapper: Mapper = new Map(parameters.map((parameter) => [parameter.id, map(parameter)]));
    return c.relations.isAssignable(c.instantiate(checkType, mapper), c.instantiate(extendsType, mapper));
  };
  if (!isAssignableWith(() => anyType)) return 'false';
  // A type parameter without its constraint, so that `T[] extends string[]` with `T extends string` is deferred.
  if (isAssignableWith((parameter) => ({ ...parameter, id: newTypeId(), constraint: undefined }))) return 'true';
  return undefined;
}

/** The type parameters, other than those in `except`, that occur in a type's members, type arguments, and elements. */
export function typeParametersIn(type: Type, except: readonly TypeParameter[] = []): TypeParameter[] {
  const found = new Map<number, TypeParameter>();
  const seen = new Set<Type>();
  const visit = (current: Type): void => {
    if (seen.has(current)) return;
    seen.add(current);
    for (const child of childTypes(current)) visit(child);
    if (current.kind === 'typeParameter' && !except.some((parameter) => parameter.id === current.id))
      found.set(current.id, current);
  };
  visit(type);
  return [...found.values()];
}

/** The types a type holds as members, type arguments, and elements. */
export function childTypes(type: Type): readonly Type[] {
  switch (type.kind) {
    case 'union': {
      // Reading the members of a deferred union instantiates them, as ever deeper ones for `type G<T> = T | G<T[]>[]`.
      return type.aliasMapper ? [...type.aliasMapper.values()] : type.types;
    }
    case 'intersection':
    case 'templateLiteral': {
      return type.types;
    }
    case 'object': {
      if (type.objectKind === 'reference') return type.typeArguments ?? [];
      return (type.tuple?.elements ?? []).map((element) => element.type);
    }
    case 'indexedAccess': {
      return [type.objectType, type.indexType];
    }
    case 'keyof':
    case 'stringMapping': {
      return [type.type];
    }
    default: {
      return [];
    }
  }
}
