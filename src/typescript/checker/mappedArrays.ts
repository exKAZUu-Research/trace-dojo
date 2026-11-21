import type { Checker } from './checker';
import {
  literalType,
  type MappedInfo,
  numberType,
  type ObjectType,
  type TupleElement,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

/** A function instantiating the generic mapped type that a `MappedInfo` instantiates, with another type for its source. */
export type WithMappedSource = (source: Type) => Type;

/**
 * A homomorphic mapped type over an array or a tuple, which maps its elements as TypeScript's
 * `instantiateMappedTupleType` and `instantiateMappedArrayType` do.
 */
export function mappedArrayOrTuple(
  c: Checker,
  info: MappedInfo,
  source: ObjectType,
  withSource: WithMappedSource | undefined
): Type {
  if (source.objectKind !== 'tuple') {
    return c.arrayType(
      mappedElement(c, info, numberType, true),
      applyModifier(info.readonlyModifier, c.isReadonlyArrayType(source))
    );
  }
  const elements = source.tuple?.elements ?? [];
  const fixedLength = elements.findIndex((element) => element.rest);
  return c.tupleType(
    elements.map((element, index) =>
      fixedLength === -1 || index < fixedLength
        ? {
            ...element,
            type: mappedElement(c, info, literalType(String(index)), element.optional),
            optional: applyModifier(info.optionalModifier, element.optional),
          }
        : { ...element, type: mappedVariableElement(c, info, element, withSource) }
    ),
    applyModifier(info.readonlyModifier, source.tuple?.readonly ?? false)
  );
}

/**
 * The mapped type of a tuple element at or after the first rest element, which maps the array of that element, or the
 * spread type itself for a variadic element.
 */
function mappedVariableElement(
  c: Checker,
  info: MappedInfo,
  element: TupleElement,
  withSource: WithMappedSource | undefined
): Type {
  if (element.rest && !c.isArrayOrTuple(element.type)) return withSource?.(element.type) ?? element.type;
  const array = c.arrayType(element.rest ? c.elementTypeOf(element.type as ObjectType) : element.type);
  const mapped = withSource?.(array);
  const mappedType =
    mapped === undefined
      ? mappedElement(c, info, numberType, true)
      : mapped.kind === 'object' && c.isArrayOrTuple(mapped)
        ? c.elementTypeOf(mapped)
        : unknownType;
  return element.rest ? c.arrayType(mappedType) : mappedType;
}

/** The template of a mapped type over an array or a tuple for `key`, as TypeScript's `instantiateMappedTypeTemplate`. */
function mappedElement(c: Checker, info: MappedInfo, key: Type, isOptional: boolean): Type {
  const type = c.instantiate(info.template, new Map([[info.typeParameter.id, key]]));
  if (info.optionalModifier === '+') return unionOf([type, undefinedType]);
  return info.optionalModifier === '-' && isOptional ? c.relations.removeUndefined(type) : type;
}

/** A modified property's flag: `+` sets it, `-` clears it, and no modifier keeps the source's. */
export function applyModifier(modifier: '+' | '-' | undefined, inherited: boolean): boolean {
  return modifier === '+' || (modifier !== '-' && inherited);
}
