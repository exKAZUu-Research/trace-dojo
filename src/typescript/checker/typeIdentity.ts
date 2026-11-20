import { minimumArguments } from './callArity';
import type { Checker } from './checker';
import { keyedIndexes } from './indexInfos';
import {
  type ConditionalType,
  errorType,
  type MappedInfo,
  type ObjectType,
  type Property,
  propertyAccessType,
  type Signature,
  type Type,
  undefinedType,
  unknownType,
} from './types';

export function structurallyIdentical(c: Checker, source: Type, target: Type): boolean {
  if (source === target || source === errorType || target === errorType) return true;
  const identical = (a: Type, b: Type): boolean => c.relations.identical(a, b);
  switch (source.kind) {
    case 'intrinsic': {
      return target.kind === 'intrinsic' && source.name === target.name;
    }
    case 'literal': {
      return target.kind === 'literal' && source.value === target.value;
    }
    case 'union':
    case 'intersection': {
      return (
        target.kind === source.kind &&
        source.types.length === target.types.length &&
        source.types.every((type) => target.types.some((member) => identical(type, member)))
      );
    }
    case 'object': {
      return target.kind === 'object' && objectsIdentical(c, source, target);
    }
    case 'keyof': {
      return target.kind === 'keyof' && identical(source.type, target.type);
    }
    case 'indexedAccess': {
      return (
        target.kind === 'indexedAccess' &&
        identical(source.objectType, target.objectType) &&
        identical(source.indexType, target.indexType)
      );
    }
    case 'conditional': {
      return target.kind === 'conditional' && conditionalsIdentical(c, source, target);
    }
    case 'templateLiteral': {
      return (
        target.kind === 'templateLiteral' &&
        source.texts.length === target.texts.length &&
        source.texts.every((text, index) => text === target.texts[index]) &&
        source.types.every((type, index) => identical(type, target.types[index]))
      );
    }
    case 'stringMapping': {
      return (
        target.kind === 'stringMapping' && source.mapping === target.mapping && identical(source.type, target.type)
      );
    }
    case 'typeParameter': {
      return false;
    }
  }
}

function conditionalsIdentical(c: Checker, source: ConditionalType, target: ConditionalType): boolean {
  const parameters = source.inferTypeParameters;
  const sourceDeclarations = (source.root ?? source).inferTypeParameters;
  const targetDeclarations = (target.root ?? target).inferTypeParameters;
  if (
    parameters.length !== target.inferTypeParameters.length ||
    sourceDeclarations.some((parameter, index) => parameter.id !== targetDeclarations[index]?.id)
  )
    return false;
  const mapper = new Map(parameters.map((parameter, index) => [parameter.id, target.inferTypeParameters[index]]));
  const identical = (a: Type, b: Type): boolean => c.relations.identical(c.instantiate(a, mapper), b);
  return (
    identical(source.checkType, target.checkType) &&
    identical(source.extendsType, target.extendsType) &&
    identical(source.trueType, target.trueType) &&
    identical(source.falseType, target.falseType)
  );
}

function objectsIdentical(c: Checker, source: ObjectType, target: ObjectType): boolean {
  if ((source.mapped || target.mapped) && (c.relations.isGeneric(source) || c.relations.isGeneric(target)))
    return !!source.mapped && !!target.mapped && mappedTypesIdentical(c, source.mapped, target.mapped);
  const left = source.resolve();
  const right = target.resolve();
  if (left.properties.size !== right.properties.size) return false;
  for (const [key, property] of left.properties) {
    const other = right.properties.get(key);
    if (!other || !propertiesIdentical(c, property, other)) return false;
  }
  const leftIndexes = keyedIndexes(left);
  const rightIndexes = keyedIndexes(right);
  return (
    leftIndexes.length === rightIndexes.length &&
    leftIndexes.every((index) =>
      rightIndexes.some(
        (other) =>
          index.readonly === other.readonly &&
          c.relations.identical(index.keyType, other.keyType) &&
          c.relations.identical(index.type, other.type)
      )
    ) &&
    signatureListsIdentical(c, left.callSignatures, right.callSignatures) &&
    signatureListsIdentical(c, left.constructSignatures, right.constructSignatures)
  );
}

function mappedTypesIdentical(c: Checker, left: MappedInfo, right: MappedInfo): boolean {
  if (left.optionalModifier !== right.optionalModifier || left.readonlyModifier !== right.readonlyModifier)
    return false;
  const mapper = new Map([[left.typeParameter.id, right.typeParameter]]);
  return (
    c.relations.identical(c.instantiate(left.constraint, mapper), right.constraint) &&
    c.relations.identical(c.instantiate(left.template, mapper), right.template) &&
    c.relations.identical(
      left.nameType ? c.instantiate(left.nameType, mapper) : undefinedType,
      right.nameType ?? undefinedType
    )
  );
}

function propertiesIdentical(c: Checker, a: Property, b: Property): boolean {
  return (
    a.optional === b.optional &&
    a.readonly === b.readonly &&
    a.visibility === b.visibility &&
    (a.visibility === 'public' || a.declaration?.id === b.declaration?.id) &&
    c.relations.identical(propertyAccessType(a), propertyAccessType(b))
  );
}

function signatureListsIdentical(c: Checker, a: Signature[], b: Signature[]): boolean {
  return a.length === b.length && a.every((signature, index) => signaturesIdentical(c, signature, b[index]));
}

function signaturesIdentical(c: Checker, source: Signature, target: Signature): boolean {
  if (source === target) return true;
  if (
    source.parameters.length !== target.parameters.length ||
    source.typeParameters.length !== target.typeParameters.length ||
    minimumArguments(source) !== minimumArguments(target)
  )
    return false;
  const mapper = new Map(source.typeParameters.map((parameter, index) => [parameter.id, target.typeParameters[index]]));
  const identical = (a: Type, b: Type): boolean => c.relations.identical(c.instantiate(a, mapper), b);
  if (
    !source.typeParameters.every((parameter, index) => {
      const other = target.typeParameters[index];
      return (
        identical(parameter.constraint?.() ?? unknownType, other.constraint?.() ?? unknownType) &&
        identical(parameter.default?.() ?? unknownType, other.default?.() ?? unknownType)
      );
    })
  )
    return false;
  if (source.thisType && target.thisType && !identical(source.thisType, target.thisType)) return false;
  const { predicate: from } = source;
  const { predicate: to } = target;
  return (
    source.parameters.every((parameter, index) => {
      const other = target.parameters[index];
      return parameter.rest === other.rest && identical(parameter.type, other.type);
    }) &&
    (from || to
      ? !!from && !!to && from.index === to.index && identical(from.type, to.type)
      : identical(source.returnType(), target.returnType()))
  );
}
