import type { ClassInfo } from './classes';
import { closeInferenceHoles, containsInferenceHole, INFERENCE_HOLE, isInferenceHole } from './typeInference';
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  futureOrValue,
  interfaceType,
  isSubtype,
  norm,
  resolveBound,
  upperBound,
} from './types';

/**
 * A construct whose child Dart infers under a context it derives from the construct's own context K: an await's
 * operand, an async function's returned expression (whose K is the value type), a numeric operator's right operand
 * (by the left operand's class), an int's `clamp` or `remainder` argument, an integer literal (read as double or
 * int), and a list's, set's or map's element.
 */
export type ContextConstruct =
  | { kind: 'awaitOperand' }
  | { kind: 'asyncReturn' }
  | { kind: 'numericOperand'; operator: string; left: 'int' | 'double' | 'num' }
  | { kind: 'intArithmetic' }
  | { kind: 'intLiteral' }
  | { kind: 'element'; cls: ClassInfo }
  | { kind: 'mapKey' }
  | { kind: 'mapValue' };

const DOUBLE_CONTEXT_OPERATORS = new Set(['+', '-', '*', '%']);
const INT_OPERAND_OPERATORS = new Set(['&', '|', '^', '<<', '>>', '>>>']);

/**
 * The context Dart's rules give a construct's child from the construct's context, the one place they are decided
 * for every construct that derives one; each rule reads the context's normal form.
 */
export function childContext(construct: ContextConstruct, context: DartType | undefined): DartType | undefined {
  const normal = context && norm(context);
  switch (construct.kind) {
    case 'awaitOperand': {
      // Every context but dynamic, the top types included, is wrapped, as the SDK infers `await f()` under it.
      return normal && normal.kind !== 'dynamic' ? interfaceType(coreTypes.futureOr, [normal]) : undefined;
    }
    case 'asyncReturn': {
      // FutureOr of the value type, Object? and dynamic included (`Future<Object?> f() async => wrap(x)` infers
      // wrap's T as Object?); a void value type gives none.
      return normal && normal.kind !== 'void' ? interfaceType(coreTypes.futureOr, [normal]) : undefined;
    }
    case 'numericOperand': {
      return numericOperandContext(construct, normal);
    }
    case 'intArithmetic': {
      return intArithmeticContext(normal);
    }
    case 'intLiteral': {
      return normal && isDoubleLiteralContext(normal) ? interfaceType(coreTypes.double) : interfaceType(coreTypes.int);
    }
    case 'element': {
      return elementTypeOfContext(context, construct.cls);
    }
    case 'mapKey': {
      return mapTypesOfContext(context)?.[0];
    }
    case 'mapValue': {
      return mapTypesOfContext(context)?.[1];
    }
  }
}

/**
 * A numeric operator's right operand's context: a bitwise or shift operator's parameter is int; the others' num
 * (`var b = x + await f` infers f's type argument as num), unless the rule for int arithmetic passes on the whole
 * expression's context.
 */
function numericOperandContext(
  construct: Extract<ContextConstruct, { kind: 'numericOperand' }>,
  context: DartType | undefined
): DartType {
  if (INT_OPERAND_OPERATORS.has(construct.operator)) return interfaceType(coreTypes.int);
  const special =
    construct.left !== 'double' && DOUBLE_CONTEXT_OPERATORS.has(construct.operator)
      ? intArithmeticContext(context)
      : undefined;
  return special ?? interfaceType(coreTypes.num);
}

/**
 * The type Dart's rule for int arithmetic passes from the context K of an int's `+`, `-`, `*`, `%`, `remainder` or
 * `clamp` to its operands: int when int is a subtype of K and num is not, as for int and int?; double likewise;
 * otherwise none, so that the operands take the operation's own parameter type.
 */
function intArithmeticContext(context: DartType | undefined): DartType | undefined {
  if (!context) return undefined;
  const num = interfaceType(coreTypes.num);
  if (isSubtype(num, context)) return undefined;
  for (const cls of [coreTypes.int, coreTypes.double]) {
    const type = interfaceType(cls);
    if (isSubtype(type, context)) return type;
  }
  return undefined;
}

/**
 * Whether an integer literal in the context is a double, as Dart's rule says: double is assignable to the context
 * and int is not, as for double, double?, and FutureOr<double>.
 */
function isDoubleLiteralContext(context: DartType): boolean {
  if (context.kind === 'dynamic' || isInferenceHole(context)) return false;
  return isSubtype(interfaceType(coreTypes.double), context) && !isSubtype(interfaceType(coreTypes.int), context);
}

export function isDoubleContext(context: DartType): boolean {
  const base = context.kind === 'interface' ? context : undefined;
  return base?.cls === coreTypes.double;
}

/**
 * The type a collection literal's context stands for: the context, or for `FutureOr<T>` (as an async function's
 * return gives) the `T`, which Dart infers the literal from.
 */
function collectionContext(context: DartType): DartType {
  const base = resolveBound(context);
  const value = futureOrValue(base);
  return value ? collectionContext(value) : base;
}

/** The element type a context gives a collection literal, as `List<int>` gives `int` to `[...]`. */
function elementTypeOfContext(context: DartType | undefined, cls: ClassInfo): DartType | undefined {
  if (!context) return undefined;
  const base = collectionContext(context);
  if (base.kind !== 'interface') return undefined;
  const target = cls === coreTypes.list && base.cls === coreTypes.iterable ? coreTypes.iterable : cls;
  if (base.cls === coreTypes.iterable || base.cls === coreTypes.object) {
    return base.cls === coreTypes.iterable ? base.args[0] : undefined;
  }
  if (base.cls !== target && !target.isSubclassOf(base.cls)) return undefined;
  return base.args[0];
}

function mapTypesOfContext(context: DartType | undefined): [DartType, DartType] | undefined {
  if (!context) return undefined;
  const base = collectionContext(context);
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
