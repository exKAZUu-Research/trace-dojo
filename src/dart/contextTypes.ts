import type { ClassInfo } from './classes';
import { closeInferenceHoles, containsInferenceHole, INFERENCE_HOLE, isInferenceHole } from './typeInference';
import { coreTypes, type DartType, DYNAMIC, interfaceType, resolveBound, upperBound } from './types';

export function isDoubleContext(context: DartType): boolean {
  const base = context.kind === 'interface' ? context : undefined;
  return base?.cls === coreTypes.double;
}

/** The element type a context gives a collection literal, as `List<int>` gives `int` to `[...]`. */
export function elementTypeOfContext(context: DartType | undefined, cls: ClassInfo): DartType | undefined {
  if (!context) return undefined;
  const base = resolveBound(context);
  if (base.kind !== 'interface') return undefined;
  const target = cls === coreTypes.list && base.cls === coreTypes.iterable ? coreTypes.iterable : cls;
  if (base.cls === coreTypes.iterable || base.cls === coreTypes.object) {
    return base.cls === coreTypes.iterable ? base.args[0] : undefined;
  }
  if (base.cls !== target && !target.isSubclassOf(base.cls)) return undefined;
  return base.args[0];
}

export function mapTypesOfContext(context: DartType | undefined): [DartType, DartType] | undefined {
  if (!context) return undefined;
  const base = resolveBound(context);
  if (base.kind !== 'interface' || base.cls !== coreTypes.map) return undefined;
  return [base.args[0] ?? DYNAMIC, base.args[1] ?? DYNAMIC];
}

export function inferElementType(types: DartType[]): DartType {
  if (types.length === 0) return DYNAMIC;
  let result = types[0];
  for (const type of types.slice(1)) result = upperBound(result, type);
  return result;
}

/**
 * A collection literal's type argument from its context and its elements' types. A context still waiting for a call's
 * type arguments yields to the elements, and with no elements to its greatest closure (`f<T>(List<List<T>> a)` takes
 * `[]` as List<List<Object?>>), except a bare unknown, which leaves the elements' dynamic.
 */
export function literalTypeArgument(context: DartType | undefined, elementTypes: DartType[]): DartType {
  if (context && !containsInferenceHole(context)) return context;
  if (context && !isInferenceHole(context) && elementTypes.length === 0) return closeInferenceHoles(context);
  return inferElementType(elementTypes);
}

/** A set or map type whose type arguments are left to the elements. */
export function unresolvedCollectionType(kind: 'set' | 'map'): DartType {
  return kind === 'set'
    ? interfaceType(coreTypes.set, [INFERENCE_HOLE])
    : interfaceType(coreTypes.map, [INFERENCE_HOLE, INFERENCE_HOLE]);
}
