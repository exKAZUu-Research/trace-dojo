import type { ClassSymbol, TypeParameterSymbol } from './symbols';
import {
  type ClassType,
  type FunctionType,
  hasOpenVariables,
  type InferenceVariable,
  isNothing,
  isNullable,
  type KType,
  mentionsVariable,
  nonNull,
  NOTHING,
  nullable,
  resolved,
  substitute,
  type Substitution,
  type TypeArgument,
  withNullability,
} from './types';

/** The classes the type relations treat specially. */
export interface CoreClasses {
  any: ClassSymbol;
  /** `kotlin.Function`, the supertype of every function type. */
  function: ClassSymbol;
}

let core: CoreClasses | undefined;

export function setCoreClasses(classes: CoreClasses): void {
  core = classes;
}

function coreClasses(): CoreClasses {
  if (!core) throw new Error('The core classes are not loaded');
  return core;
}

export function anyType(isNullableAny = false): ClassType {
  return { kind: 'class', cls: coreClasses().any, args: [], nullable: isNullableAny };
}

/** The substitution of a class's type parameters by the arguments of a type of it. */
export function substitutionOf(type: ClassType): Map<TypeParameterSymbol, KType> {
  const map = new Map<TypeParameterSymbol, KType>();
  for (const [index, param] of type.cls.typeParameters.entries()) {
    const argument = type.args[index];
    if (!argument) continue;
    map.set(param, argument.variance === 'star' ? upperBoundOf(param) : argument.type);
  }
  return map;
}

export function upperBoundOf(param: TypeParameterSymbol): KType {
  return param.bounds[0] ?? anyType(true);
}

/** The supertype of `type` whose class is `target`, with the type arguments the hierarchy gives it. */
export function asSuper(type: ClassType, target: ClassSymbol): ClassType | undefined {
  if (type.cls === target) return type;
  const substitution = substitutionOf(type);
  for (const supertype of type.cls.supertypes) {
    const found = asSuper(substitute(supertype, substitution) as ClassType, target);
    if (found) return withNullability(found, type.nullable);
  }
  return undefined;
}

/** The class types a type is a subtype of through its bounds, for a type parameter or a fixed variable. */
function classBoundsOf(type: KType): KType[] {
  if (type.kind === 'param') {
    const bounds = type.param.bounds.length > 0 ? type.param.bounds : [anyType(true)];
    return type.nullable ? bounds.map(nullable) : bounds;
  }
  return [type];
}

/**
 * Whether `sub` is a subtype of `sup`. Inference variables that are not fixed take the other side as a bound, which
 * makes the check succeed; {@link checkVariableBounds} later rejects bounds no type satisfies.
 */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per pair of kinds of types.
// code-gauge-allow functionNcss 33 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
export function isSubtype(subType: KType, superType: KType): boolean {
  const sub = resolved(subType);
  const sup = resolved(superType);
  if (sub.kind === 'variable' || sup.kind === 'variable') return constrainSubtype(sub, sup);
  if (isNullable(sub) && !isNullable(sup)) return false;
  if (sub.kind === 'nothing') return true;
  if (sup.kind === 'nothing') return false;
  if (sup.kind === 'class' && sup.cls === coreClasses().any) return true;
  if (sub.kind === 'param') {
    if (sup.kind === 'param' && sup.param === sub.param) return true;
    return classBoundsOf(withNullability(sub, false)).some((bound) => isSubtype(bound, withNullability(sup, true)));
  }
  if (sup.kind === 'param') return false;
  if (sub.kind === 'function') {
    if (sup.kind === 'class') return sup.cls === coreClasses().function;
    return isFunctionSubtype(sub, sup);
  }
  if (sup.kind === 'function') return false;
  const supertype = asSuper(withNullability(sub, false), sup.cls);
  if (!supertype) return false;
  return sup.args.every((argument, index) =>
    isArgumentSubtype(supertype.args[index], argument, sup.cls.typeParameters[index]?.variance ?? 'inv')
  );
}

function constrainSubtype(sub: KType, sup: KType): boolean {
  if (sup.kind === 'variable') {
    if (sub.kind === 'variable') {
      if (sub.variable === sup.variable) return true;
      addBound(sub.variable, 'upper', sup);
    }
    addBound(sup.variable, 'lower', sup.nullable ? nonNull(sub) : sub);
    return true;
  }
  if (sub.kind !== 'variable') throw new Error('A subtype constraint needs an inference variable');
  addBound(sub.variable, 'upper', sup);
  return !sub.nullable || isNullable(sup);
}

function isFunctionSubtype(sub: FunctionType, sup: FunctionType): boolean {
  const subParams = sub.receiver ? [sub.receiver, ...sub.params] : sub.params;
  const supParams = sup.receiver ? [sup.receiver, ...sup.params] : sup.params;
  if (subParams.length !== supParams.length) return false;
  return (
    supParams.every((param, index) => isSubtype(param, subParams[index] as KType)) &&
    isSubtype(sub.returnType, sup.returnType)
  );
}

function isArgumentSubtype(sub: TypeArgument | undefined, sup: TypeArgument, declared: 'inv' | 'in' | 'out'): boolean {
  if (sup.variance === 'star') return true;
  if (!sub) return false;
  const variance = sup.variance === 'inv' ? declared : sup.variance;
  if (sub.variance === 'star') return variance === 'out' && isSubtype(anyType(true), sup.type);
  switch (variance) {
    case 'out': {
      return sub.variance !== 'in' && isSubtype(sub.type, sup.type);
    }
    case 'in': {
      return sub.variance !== 'out' && isSubtype(sup.type, sub.type);
    }
    default: {
      return sub.variance === 'inv' && isSameType(sub.type, sup.type);
    }
  }
}

/** Whether two types are the same, which invariant type arguments require. */
export function isSameType(a: KType, b: KType): boolean {
  const left = resolved(a);
  const right = resolved(b);
  if (left.kind === 'variable' || right.kind === 'variable') return isSubtype(left, right) && isSubtype(right, left);
  return isSubtype(left, right) && isSubtype(right, left);
}

function addBound(variable: InferenceVariable, side: 'lower' | 'upper', type: KType): void {
  if (variable.fixed) return;
  const bounds = side === 'lower' ? variable.lower : variable.upper;
  if (bounds.some((existing) => existing === type)) return;
  bounds.push(type);
}

/**
 * The least upper bound of types, as Kotlin computes the type of an `if` or `when` and of a type variable's lower
 * bounds: the first supertype of the first type that the others are subtypes of.
 */
export function commonSupertype(types: KType[]): KType {
  const candidates = types.map(resolved).filter((type) => !isNothing(type));
  if (candidates.length === 0) return types.some((type) => type.nullable) ? nullable(NOTHING) : NOTHING;
  const isAnyNullable = types.some((type) => isNullable(resolved(type)));
  const nonNullTypes = candidates.filter((type) => !(type.kind === 'nothing')).map((type) => nonNull(type));
  if (nonNullTypes.length === 0) return nullable(NOTHING);
  const result = nonNullCommonSupertype(nonNullTypes);
  return isAnyNullable ? nullable(result) : result;
}

/**
 * Whether the types have two or more most specific common supertypes, which kotlinc infers as their intersection, as
 * `Number & Comparable<*>` for `1` and `2.0`.
 */
export function hasIntersectionSupertype(types: KType[]): boolean {
  const classes = types
    .map(resolved)
    .filter((type) => type.kind !== 'nothing')
    .map((type) => nonNull(type));
  if (classes.length < 2 || classes.some((type) => type.kind !== 'class')) return false;
  const [first] = classes as ClassType[];
  if (classes.every((type) => isSubtype(type, first))) return false;
  const common = supertypesInOrder(first).filter(
    (candidate): candidate is ClassType =>
      candidate.kind === 'class' &&
      candidate.cls !== coreClasses().any &&
      classes.every((type) => type.kind === 'class' && asSuper(type, candidate.cls) !== undefined)
  );
  const mostSpecific = common.filter(
    (candidate) => !common.some((other) => other !== candidate && asSuper(other, candidate.cls) !== undefined)
  );
  const serializable = classes.every((type) => type.kind === 'class' && isJvmSerializable(type.cls)) ? 1 : 0;
  return mostSpecific.length + serializable >= 2;
}

const JVM_SERIALIZABLE = new Set([
  'kotlin.Boolean',
  'kotlin.Byte',
  'kotlin.Char',
  'kotlin.Double',
  'kotlin.Float',
  'kotlin.Int',
  'kotlin.Long',
  'kotlin.Number',
  'kotlin.Short',
  'kotlin.String',
  'kotlin.text.StringBuilder',
]);

/**
 * Whether a class is java.io.Serializable on the JVM, which the prelude does not declare: the boxed primitives,
 * String, StringBuilder, Number, and enums.
 */
function isJvmSerializable(cls: ClassSymbol): boolean {
  return cls.kind === 'enum' || JVM_SERIALIZABLE.has(cls.kotlinName);
}

function nonNullCommonSupertype(types: KType[]): KType {
  const [first] = types;
  if (types.every((type) => isSubtype(type, first))) return first;
  // The first type itself merges its arguments first, as `Pair<Int, String>` and `Pair<Int, Nothing?>` make a
  // `Pair<Int, String?>`.
  for (const candidate of [first, ...supertypesInOrder(first)]) {
    if (types.every((type) => isSubtype(type, candidate))) return candidate;
    // Type arguments that differ between the types become their common supertype, as for `List<Int>` and `List<String>`.
    if (candidate.kind === 'class' && candidate.args.length > 0) {
      const merged = mergeArguments(candidate, types);
      if (merged && types.every((type) => isSubtype(type, merged))) return merged;
    }
  }
  return anyType();
}

function mergeArguments(candidate: ClassType, types: KType[]): ClassType | undefined {
  const supers = types.map((type) => (type.kind === 'class' ? asSuper(type, candidate.cls) : undefined));
  if (supers.some((type) => !type)) return undefined;
  const args = candidate.cls.typeParameters.map((param, index): TypeArgument => {
    const argumentTypes = supers.map((type) => {
      const argument = (type as ClassType).args[index];
      return argument && argument.variance !== 'star' ? argument.type : anyType(true);
    });
    if (param.variance === 'out' || param.variance === 'inv') {
      const merged = commonSupertype(argumentTypes);
      return {
        variance: param.variance === 'inv' && !argumentTypes.every((type) => isSameType(type, merged)) ? 'out' : 'inv',
        type: merged,
      };
    }
    return { variance: 'star' };
  });
  return { kind: 'class', cls: candidate.cls, args, nullable: false };
}

/** The supertypes of a type, nearest first, as breadth-first search finds them. */
function supertypesInOrder(type: KType): KType[] {
  if (type.kind === 'param') return classBoundsOf(type).flatMap((bound) => [bound, ...supertypesInOrder(bound)]);
  if (type.kind === 'function')
    return [{ kind: 'class', cls: coreClasses().function, args: [{ variance: 'star' }], nullable: false }];
  if (type.kind !== 'class') return [];
  const result: KType[] = [];
  const queue: ClassType[] = [type];
  while (queue.length > 0) {
    const current = queue.shift() as ClassType;
    const substitution = substitutionOf(current);
    for (const supertype of current.cls.supertypes) {
      const next = substitute(supertype, substitution) as ClassType;
      // Any comes last, after the interfaces that a class without a superclass implements.
      if (next.cls === coreClasses().any) continue;
      if (!result.some((existing) => existing.kind === 'class' && existing.cls === next.cls)) {
        result.push(next);
        queue.push(next);
      }
    }
  }
  result.push(anyType());
  return result;
}

/**
 * Fixes an inference variable to the type its bounds give it: the common supertype of its lower bounds, or else its
 * first upper bound. Returns `undefined` when nothing constrains it.
 */
export function fixVariable(variable: InferenceVariable): KType | undefined {
  if (variable.fixed) return variable.fixed;
  // A lower bound that is another open variable stands for what that variable's own lower bounds give it.
  const lower = variable.lower
    .map(resolved)
    .flatMap((type) => (type.kind === 'variable' && !type.variable.fixed ? type.variable.lower.map(resolved) : [type]))
    .filter((type) => type.kind !== 'variable');
  const upper = variable.upper.map(resolved).filter((type) => type.kind !== 'variable');
  let fixed: KType | undefined;
  if (lower.length > 0) fixed = commonSupertype(lower);
  else if (upper.length > 0) fixed = upper[0];
  if (fixed) variable.fixed = fixed;
  return fixed;
}

/**
 * Fixes the variables whose bounds mention `target` and checks those bounds, which gives `target` its lower bounds, as
 * `C : Iterable<T>` of `onEach` gives `T` the element type of the receiver before the lambda's body is compiled.
 */
export function constrainThroughBounds(
  target: InferenceVariable,
  variables: InferenceVariable[],
  substitution: Substitution
): void {
  for (const other of variables) {
    if (other === target || other.fixed) continue;
    const bounds = other.param.bounds.map((bound) => substitute(bound, substitution));
    if (!bounds.some((bound) => mentionsVariable(bound, (candidate) => candidate === target))) continue;
    const fixed = fixVariable(other);
    if (fixed) for (const bound of bounds) isSubtype(fixed, bound);
  }
}

/** The type that all lower bounds of an open variable agree on, which an integer literal passed for it may take. */
export function soleLowerBound(type: KType): KType | undefined {
  if (type.kind !== 'variable' || type.variable.fixed) return undefined;
  const [first, ...rest] = type.variable.lower.map(resolved);
  if (!first || first.kind !== 'class' || rest.some((other) => !isSameType(other, first))) return undefined;
  return first;
}

/** Whether every bound of a fixed variable holds. */
export function checkVariableBounds(variable: InferenceVariable): boolean {
  const { fixed } = variable;
  if (!fixed) return true;
  return (
    variable.lower.every((bound) => isSubtype(bound, fixed)) && variable.upper.every((bound) => isSubtype(fixed, bound))
  );
}

/**
 * A type, or for a variable still being inferred the type its upper bounds require, as `V` of `getOrPut` has from the
 * map's type, so that the lambda `{ mutableListOf() }` infers its element type.
 */
export function determinedType(type: KType | undefined): KType | undefined {
  if (type?.kind !== 'variable') return type;
  const [upper, ...others] = type.variable.upper;
  if (!upper || hasOpenVariables(upper) || others.some((other) => !isSameType(other, upper))) return undefined;
  return upper;
}

export function lambdaResultHint(type: KType | undefined): KType | undefined {
  if (type?.kind === 'variable' && type.variable.lower.length > 0) return type;
  return determinedType(type) ?? type;
}

export function commonGenericHint(result: KType, known: KType): KType | undefined {
  if (result.kind !== 'class' || known.kind !== 'class') return undefined;
  for (const type of [result, ...supertypesInOrder(result)]) {
    if (type.kind !== 'class' || !hasOpenVariables(type)) continue;
    const projection = asSuper(known, type.cls);
    if (projection) return projection;
  }
}

/**
 * The expected type of a later branch of an `if`, `when`, or `?:` whose value is a call without arguments, such as
 * `emptyList()`: an earlier branch's generic type, which gives the call its type arguments, where it fits the expected
 * type of the whole. A call with arguments infers its own, so that `listOf("a")` still meets `listOf(1)` as a List<Any>.
 */
export function branchHint(earlier: KType, expected: KType | undefined, isBareCall: boolean): KType | undefined {
  const actual = resolved(earlier);
  const isHint = isBareCall && actual.kind === 'class' && actual.args.length > 0 && !hasOpenVariables(actual);
  if (!isHint || (expected && (hasOpenVariables(expected) || !isSubtype(actual, expected)))) return expected;
  // The earlier branch's type may still hold fixed variables, which the later call should see as their types.
  return withDeterminedVariables(actual);
}

/** A type with each variable that its upper bounds already determine replaced by the type they require. */
export function withDeterminedVariables(type: KType): KType {
  switch (type.kind) {
    case 'variable': {
      if (type.variable.fixed) return withDeterminedVariables(resolved(type));
      const determined = determinedType(type);
      return determined ? withNullability(determined, type.nullable || isNullable(determined)) : type;
    }
    case 'class': {
      return {
        ...type,
        args: type.args.map((argument) =>
          argument.variance === 'star' ? argument : { ...argument, type: withDeterminedVariables(argument.type) }
        ),
      };
    }
    case 'function': {
      return {
        ...type,
        receiver: type.receiver && withDeterminedVariables(type.receiver),
        params: type.params.map(withDeterminedVariables),
        returnType: withDeterminedVariables(type.returnType),
      };
    }
    default: {
      return type;
    }
  }
}
