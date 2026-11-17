import type { Type, TypeParameter } from './types';

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

function childTypes(type: Type): readonly Type[] {
  switch (type.kind) {
    case 'union':
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
