import type { ClassInfo } from './classes';
import { closeInferenceHoles, containsInferenceHole, INFERENCE_HOLE, isInferenceHole } from './typeInference';
import { coreTypes, type DartType, DYNAMIC, interfaceType, isSubtype, resolveBound, upperBound } from './types';

/**
 * The type Dart's rule for int arithmetic passes from the context K of an int's `+`, `-`, `*`, `%`, `remainder` or
 * `clamp` to its operands: int when int is a subtype of K and num is not, as for int and int?; double likewise;
 * otherwise none, so that the operands take the operation's own parameter type.
 */
export function intArithmeticContext(context: DartType | undefined): DartType | undefined {
  if (!context) return undefined;
  const num = interfaceType(coreTypes.num);
  if (isSubtype(num, context)) return undefined;
  for (const cls of [coreTypes.int, coreTypes.double]) {
    const type = interfaceType(cls);
    if (isSubtype(type, context)) return type;
  }
  return undefined;
}

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

/**
 * The type of an expression that gives one of its branches' values (a conditional, `??`, or a switch expression):
 * their upper bound, or the context when that bound does not fit the context but every branch does, as the SDK infers
 * `FutureOr<int> y = b ? 1 : f();`, whose bound is Object.
 */
export function branchesType(bound: DartType, branches: DartType[], context: DartType | undefined): DartType {
  if (!context || containsInferenceHole(context) || isSubtype(bound, context)) return bound;
  return branches.every((branch) => isSubtype(branch, context)) ? context : bound;
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
