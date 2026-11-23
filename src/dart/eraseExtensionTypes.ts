import { type DartType, DYNAMIC, type FunctionType, makeNullable, substitute, TypeParam, typeParamType } from './types';

export function eraseExtensionTypes(type: DartType): DartType {
  switch (type.kind) {
    case 'interface': {
      const args = type.args.map(eraseExtensionTypes);
      if (type.cls.kind !== 'extensionType' || !type.cls.representationType) return { ...type, args };
      const map = new Map(type.cls.typeParams.map((param, index) => [param, args[index] ?? DYNAMIC]));
      const representation = eraseExtensionTypes(substitute(type.cls.representationType, map));
      return type.nullable ? makeNullable(representation) : representation;
    }
    case 'function': {
      return eraseFunctionType(type);
    }
    case 'record': {
      return {
        ...type,
        positional: type.positional.map(eraseExtensionTypes),
        named: type.named.map((named) => ({ ...named, type: eraseExtensionTypes(named.type) })),
      };
    }
    default: {
      return type;
    }
  }
}

export function eraseFunctionType(type: FunctionType): FunctionType {
  const typeParams = type.typeParams.map((parameter) => new TypeParam(parameter.name));
  const bindings = new Map(type.typeParams.map((parameter, index) => [parameter, typeParamType(typeParams[index])]));
  const erase = (nested: DartType): DartType => eraseExtensionTypes(substitute(nested, bindings));
  for (const [index, { bound }] of type.typeParams.entries()) {
    if (bound) typeParams[index].bound = erase(bound);
  }
  return {
    ...type,
    typeParams,
    positional: type.positional.map(erase),
    named: type.named.map((named) => ({ ...named, type: erase(named.type) })),
    returnType: erase(type.returnType),
  };
}
