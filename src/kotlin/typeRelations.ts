import type { ClassSymbol, TypeParameterSymbol } from './symbols';
import {
  type ClassType,
  type FunctionType,
  type InferenceVariable,
  isNothing,
  isNullable,
  type KType,
  nonNull,
  NOTHING,
  nullable,
  resolved,
  substitute,
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
export function isSubtype(subType: KType, superType: KType): boolean {
  const sub = resolved(subType);
  const sup = resolved(superType);
  if (sup.kind === 'variable') {
    // A variable may stand for a nullable type, so any type can be its lower bound.
    addBound(sup.variable, 'lower', sup.nullable ? nonNull(sub) : sub);
    return true;
  }
  if (sub.kind === 'variable') {
    addBound(sub.variable, 'upper', sub.nullable ? sup : sup);
    return !sub.nullable || isNullable(sup);
  }
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

function nonNullCommonSupertype(types: KType[]): KType {
  const [first] = types;
  if (types.every((type) => isSubtype(type, first))) return first;
  for (const candidate of supertypesInOrder(first)) {
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

/** Whether every bound of a fixed variable holds. */
export function checkVariableBounds(variable: InferenceVariable): boolean {
  const { fixed } = variable;
  if (!fixed) return true;
  return (
    variable.lower.every((bound) => isSubtype(bound, fixed)) && variable.upper.every((bound) => isSubtype(fixed, bound))
  );
}
