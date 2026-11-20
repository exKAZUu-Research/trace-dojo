import type { Checker } from './checker';
import {
  errorType,
  isAnyLike,
  isIntrinsic,
  literalType,
  neverType,
  newTypeId,
  numberType,
  type ObjectType,
  simpleProperty,
  type Structure,
  type TupleElement,
  type Type,
  undefinedType,
  unionOf,
} from './types';

export function tupleType(c: Checker, elements: TupleElement[], readonly: boolean): Type {
  if (elements.some((element) => element.rest && isIntrinsic(element.type, 'never'))) return neverType;
  const spreads = elements.flatMap((element, index) =>
    element.rest && element.type.kind === 'union' && element.type.types.length > 0
      ? [{ index, types: element.type.types }]
      : []
  );
  if (spreads.length === 0) return buildTuple(c, elements, readonly);
  const size = spreads.reduce((count, spread) => count * spread.types.length, 1);
  if (size >= 100_000) {
    c.reportTypeComplexity();
    return errorType;
  }
  c.budget.spend(size * elements.length);
  const current = [...elements];
  const variants: Type[] = [];
  const collect = (index: number): void => {
    const spread = spreads[index];
    if (!spread) {
      variants.push(buildTuple(c, current, readonly));
      return;
    }
    for (const type of spread.types) {
      current[spread.index] = { ...elements[spread.index], type };
      collect(index + 1);
    }
  };
  collect(0);
  return unionOf(variants, true);
}

function buildTuple(c: Checker, elements: TupleElement[], readonly: boolean): ObjectType {
  const flat = flattenTupleElements(c, elements);
  // A tuple of only an array's rest is that array, as TypeScript normalizes `[...values: number[]]`.
  const [only] = flat;
  if (
    flat.length === 1 &&
    only.rest &&
    (isAnyLike(only.type) || c.isArrayType(only.type) || c.isReadonlyArrayType(only.type))
  )
    return c.arrayType(c.restElementType(only.type), readonly);
  let structure: Structure | undefined;
  const tuple: ObjectType = {
    kind: 'object',
    id: newTypeId(),
    objectKind: 'tuple',
    tuple: { elements: flat, readonly },
    resolve: () => {
      if (structure) return structure;
      const base = c.arrayType(c.elementTypeOf(tuple), readonly).resolve();
      const properties = new Map(base.properties);
      for (const [index, member] of flat.entries()) {
        if (member.rest) break;
        properties.set(
          String(index),
          simpleProperty(String(index), member.type, { optional: member.optional, readonly })
        );
      }
      properties.set('length', simpleProperty('length', tupleLengthType(flat), { readonly }));
      structure = { ...base, properties };
      return structure;
    },
  };
  return tuple;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Normalizes fixed, optional and variadic elements relative to the concrete rest.
function flattenTupleElements(c: Checker, elements: TupleElement[]): TupleElement[] {
  const flat = elements.flatMap((element) =>
    element.rest && element.type.kind === 'object' && element.type.objectKind === 'tuple'
      ? (element.type.tuple?.elements ?? [])
      : [element]
  );
  const isArrayRest = (element: TupleElement): boolean =>
    element.rest && (isAnyLike(element.type) || c.isArrayType(element.type) || c.isReadonlyArrayType(element.type));
  const firstRest = flat.findIndex(isArrayRest);
  const lastOptionalOrRest = flat.findLastIndex((element) => element.optional || isArrayRest(element));
  const lastRequired = flat.findLastIndex((element) => !element.optional && !element.rest);
  const requiredBeforeSuffix = flat.map((element, index) =>
    element.optional && index < lastRequired
      ? { ...element, optional: false, type: unionOf([element.type, undefinedType]) }
      : element
  );
  if (firstRest === -1 || lastOptionalOrRest <= firstRest) return requiredBeforeSuffix;
  const combined = requiredBeforeSuffix
    .slice(firstRest, lastOptionalOrRest + 1)
    .map((element) =>
      element.rest
        ? c.restElementType(element.type)
        : element.optional
          ? unionOf([element.type, undefinedType])
          : element.type
    );
  requiredBeforeSuffix.splice(firstRest, combined.length, {
    ...requiredBeforeSuffix[firstRest],
    type: c.arrayType(unionOf(combined)),
  });
  return requiredBeforeSuffix;
}

/** The lengths a tuple may have: any with a rest element, else each from its required elements' count to all. */
function tupleLengthType(elements: TupleElement[]): Type {
  if (elements.some((element) => element.rest)) return numberType;
  const required = elements.filter((element) => !element.optional).length;
  return unionOf(Array.from({ length: elements.length - required + 1 }, (_, offset) => literalType(required + offset)));
}
