import type { Checker } from './checker';
import { anonymousObject, emptyStructure, type MappedInfo, type Property, type TupleInfo, type Type } from './types';

export function reverseMappedType(
  c: Checker,
  source: Type,
  mapping: MappedInfo,
  inferValue: (input: Type) => Type
): Type | undefined {
  if (source.kind === 'object') {
    if (source.tuple) return reverseTuple(c, source.tuple, mapping, inferValue);
    if (c.isArrayType(source) || c.isReadonlyArrayType(source))
      return c.arrayType(inferValue(c.elementTypeOf(source)), c.isReadonlyArrayType(source));
  }
  const structure = c.structureOf(source);
  if (structure.properties.size === 0 && !structure.stringIndex) return undefined;
  return anonymousObject(() => ({
    ...emptyStructure(),
    properties: new Map(
      [...structure.properties].map(([name, property]) => {
        c.budget.spend();
        return [name, reverseProperty(property, mapping, inferValue)];
      })
    ),
    stringIndex: structure.stringIndex && {
      type: inferValue(structure.stringIndex.type),
      readonly: structure.stringIndex.readonly && mapping.readonlyModifier !== '+',
    },
  }));
}

function reverseTuple(c: Checker, tuple: TupleInfo, mapping: MappedInfo, inferValue: (input: Type) => Type): Type {
  return c.tupleType(
    tuple.elements.map((element) => {
      c.budget.spend();
      const type = inferValue(element.rest ? c.restElementType(element.type) : element.type);
      return {
        ...element,
        type: element.rest ? c.arrayType(type) : type,
        optional: element.optional && mapping.optionalModifier !== '+',
      };
    }),
    tuple.readonly
  );
}

function reverseProperty(property: Property, mapping: MappedInfo, inferValue: (input: Type) => Type): Property {
  let inferred: Type | undefined;
  return {
    ...property,
    optional: property.optional && mapping.optionalModifier !== '+',
    readonly: property.readonly && mapping.readonlyModifier !== '+',
    isMethod: false,
    writeType: undefined,
    type: () => (inferred ??= inferValue(property.type())),
  };
}
