import { functionalMethodOf } from './builtinFunctions';
import type { Builtins } from './builtins';
import { boxedTypeOf } from './builtinWrappers';
import { conditionalType } from './operators';
import {
  asSuper,
  bindingsOf,
  type ClassInfo,
  type ClassType,
  erasure,
  isPrimitive,
  isWidening,
  type JavaType,
  type MethodInfo,
  substitute,
  type TypeVariable,
  upperBound,
  wildcardBound,
} from './types';

/** The primitive type that unboxing a value of `type` gives, if `type` is a wrapper class such as `Integer`. */
export function unboxedTypeOf(type: JavaType): JavaType | undefined {
  const bound = upperBound(type);
  return bound.kind === 'class' ? bound.cls.unboxedType : undefined;
}

/** The wrapper type that boxing gives a primitive value when the result then widens to `to`. */
export function boxingTarget(builtins: Builtins, from: JavaType, to: JavaType): ClassType | undefined {
  if (!isPrimitive(from)) return;
  const boxed = boxedTypeOf(builtins.wrappers, from);
  return boxed && isWidening(boxed, to, builtins.objectClass) ? boxed : undefined;
}

/** Whether method invocation converts `from` to `to`, by widening alone or, when `allowsBoxing`, with boxing. */
export function isInvocationConvertible(
  builtins: Builtins,
  from: JavaType,
  to: JavaType,
  allowsBoxing: boolean
): boolean {
  if (from.kind === 'pending') {
    const bound = upperBound(to);
    const method = bound.kind === 'class' ? functionalMethodOf(bound.cls, builtins.objectClass) : undefined;
    return method !== undefined && (from.arity === undefined || method.parameterTypes.length === from.arity);
  }
  if (isWidening(from, to, builtins.objectClass)) return true;
  // A parameter whose type inference left undecided takes any object.
  if (to.kind === 'wildcard' && to.isHole) return !isPrimitive(from) || allowsBoxing;
  if (!allowsBoxing) return false;
  if (boxingTarget(builtins, from, to)) return true;
  const unboxed = unboxedTypeOf(from);
  return unboxed !== undefined && isPrimitive(to) && isWidening(unboxed, to, builtins.objectClass);
}

/** The bindings of `owner`'s type parameters as a member access through a receiver of `receiverType` sees them. */
export function memberBindings(receiverType: JavaType | undefined, owner: ClassInfo): Map<TypeVariable, JavaType> {
  if (!receiverType || owner.typeParameters.length === 0) return new Map();
  const bound = upperBound(receiverType);
  const supertype = bound.kind === 'class' ? asSuper(bound, owner) : undefined;
  return supertype ? bindingsOf(supertype) : new Map();
}

/** The type of a member as seen through a receiver, where reading a wildcard gives its upper bound. */
export function memberType(type: JavaType, bindings: ReadonlyMap<TypeVariable, JavaType>): JavaType {
  const substituted = substitute(type, bindings);
  return wildcardBound(substituted);
}

/** A view of `method` with the type arguments of `bindings` substituted into its signature. */
export function methodView(method: MethodInfo, bindings: ReadonlyMap<TypeVariable, JavaType>): MethodInfo {
  if (bindings.size === 0) return method;
  return {
    ...method,
    // A parameter of type `? super T` accepts a T, as capture conversion allows.
    parameterTypes: method.parameterTypes.map((type) => {
      const substituted = substitute(type, bindings);
      return substituted.kind === 'wildcard' && substituted.isSuper && substituted.bound
        ? substituted.bound
        : substituted;
    }),
    returnType: memberType(method.returnType, bindings),
    declared: method.declared ?? method,
  };
}

/**
 * Instantiates a generic method for arguments of `argTypes`, inferring each type parameter from the arguments; a type
 * parameter that no argument decides makes the types mentioning it raw, as an unchecked conversion would. Returns
 * `undefined` when an inferred type falls outside its bounds.
 *
 * @param targetType The type the call's value is assigned to, which decides the type parameters the arguments do not.
 * @param presets Type arguments already inferred, as from the values lambda arguments return.
 */
export function instantiateMethod(
  builtins: Builtins,
  method: MethodInfo,
  argTypes: readonly JavaType[],
  targetType?: JavaType,
  presets?: ReadonlyMap<TypeVariable, JavaType>
): MethodInfo | undefined {
  const variables = method.typeParameters ?? [];
  if (variables.length === 0) return method;
  const bindings = new Map<TypeVariable, JavaType>(presets);
  for (const [index, parameterType] of method.parameterTypes.entries()) {
    const argType = argTypes[index] as JavaType | undefined;
    if (argType) infer(builtins, parameterType, argType, variables, bindings);
  }
  if (targetType && !isPrimitive(targetType)) inferFromTarget(builtins, method, targetType, bindings);
  // An inferred type outside its variable's bounds makes the method inapplicable.
  for (const [variable, type] of bindings) {
    const fits = variable.bounds.every((bound) => isWidening(type, substitute(bound, bindings), builtins.objectClass));
    if (!fits) return;
  }
  const unresolved = variables.filter((variable) => !bindings.has(variable));
  // A result keeps its undecided type arguments as holes, which the code using it may still decide.
  const instantiate = (type: JavaType): JavaType => rawify(substitute(type, bindings), unresolved, false, true);
  return {
    ...method,
    parameterTypes: method.parameterTypes.map((type) => rawify(substitute(type, bindings), unresolved, true)),
    returnType: instantiate(method.returnType),
    typeParameters: [],
    declared: method.declared ?? method,
  };
}

/**
 * Infers from the type the result is assigned to what the arguments leave open, as in `List<String> l = List.of();`.
 * Within a type argument, which admits no widening, the target's type also wins over the narrower one the arguments
 * give, as in `List<Shape> l = List.of(new Square());`.
 */
function inferFromTarget(
  builtins: Builtins,
  method: MethodInfo,
  targetType: JavaType,
  bindings: Map<TypeVariable, JavaType>
): void {
  const fromTarget = new Map<TypeVariable, JavaType>();
  infer(builtins, method.returnType, targetType, method.typeParameters ?? [], fromTarget);
  for (const [variable, type] of fromTarget) {
    const existing = bindings.get(variable);
    const widensToTarget =
      existing !== undefined &&
      type.kind !== 'wildcard' &&
      occursInTypeArgument(method.returnType, variable) &&
      isWidening(existing, type, builtins.objectClass);
    if (!existing || widensToTarget) bindings.set(variable, type);
  }
}

/** Whether `variable` occurs inside a type argument of `type`, such as `T` in `List<T>`. */
function occursInTypeArgument(type: JavaType, variable: TypeVariable): boolean {
  if (type.kind === 'array') return occursInTypeArgument(type.element, variable);
  if (type.kind !== 'class') return false;
  return (type.args ?? []).some((arg) => mentions(arg, variable));
}

function mentions(type: JavaType, variable: TypeVariable): boolean {
  switch (type.kind) {
    case 'typeVar': {
      return type.variable === variable;
    }
    case 'wildcard': {
      return type.bound !== undefined && mentions(type.bound, variable);
    }
    case 'array': {
      return mentions(type.element, variable);
    }
    case 'class': {
      return (type.args ?? []).some((arg) => mentions(arg, variable));
    }
    default: {
      return false;
    }
  }
}

/** Infers the types of `variables` that make an argument of `argType` fit a parameter of `parameterType`. */
// code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of type, as inference walks parameter and argument types together.
// code-gauge-allow functionNcss 31 -- One case per kind of type, as inference walks parameter and argument types together.
export function infer(
  builtins: Builtins,
  parameterType: JavaType,
  argType: JavaType,
  variables: readonly TypeVariable[],
  bindings: Map<TypeVariable, JavaType>
): void {
  if (argType.kind === 'pending') {
    inferFromReceiverHint(builtins, parameterType, argType.receiverHint, variables, bindings);
    return;
  }
  if (argType.kind === 'null') return;
  if (parameterType.kind === 'typeVar' && variables.includes(parameterType.variable)) {
    const inferred = isPrimitive(argType) ? boxedTypeOf(builtins.wrappers, argType) : argType;
    if (!inferred) return;
    const existing = bindings.get(parameterType.variable);
    if (!existing || isWidening(existing, inferred, builtins.objectClass)) {
      bindings.set(parameterType.variable, inferred);
    } else if (!isWidening(inferred, existing, builtins.objectClass)) {
      // Arguments of unrelated types make the variable their least upper bound.
      bindings.set(
        parameterType.variable,
        conditionalType(builtins.objectClass, existing, inferred) ?? builtins.objectClass.type
      );
    }
    return;
  }
  if (parameterType.kind === 'array' && argType.kind === 'array') {
    infer(builtins, parameterType.element, argType.element, variables, bindings);
    return;
  }
  const parameterBound = parameterType.kind === 'wildcard' ? parameterType.bound : parameterType;
  if (parameterBound?.kind !== 'class' || !parameterBound.args) return;
  const argBound = upperBound(isPrimitive(argType) ? (boxedTypeOf(builtins.wrappers, argType) ?? argType) : argType);
  const supertype = argBound.kind === 'class' ? asSuper(argBound, parameterBound.cls) : undefined;
  if (!supertype?.args) return;
  for (const [index, parameterArg] of parameterBound.args.entries()) {
    const arg = supertype.args[index];
    // A type variable standing alone takes a wildcard as it is, which its use then contains.
    const isBareVariable = parameterArg.kind === 'typeVar';
    infer(
      builtins,
      parameterArg,
      arg.kind === 'wildcard' && !isBareVariable ? upperBound(arg) : arg,
      variables,
      bindings
    );
  }
}

/** Infers from `Type::method`, whose function takes a `Type` first, as the functional interface's first parameter. */
function inferFromReceiverHint(
  builtins: Builtins,
  parameterType: JavaType,
  hint: JavaType | undefined,
  variables: readonly TypeVariable[],
  bindings: Map<TypeVariable, JavaType>
): void {
  if (!hint || parameterType.kind !== 'class' || !parameterType.args) return;
  const method = functionalMethodOf(parameterType.cls, builtins.objectClass);
  const first = method?.parameterTypes[0];
  if (first?.kind !== 'typeVar') return;
  const index = parameterType.cls.typeParameters.indexOf(first.variable);
  const arg = parameterType.args[index] as JavaType | undefined;
  if (!arg) return;
  infer(builtins, arg.kind === 'wildcard' && arg.bound ? arg.bound : arg, hint, variables, bindings);
}

/**
 * Replaces type variables left `unresolved`: inside a wildcard's bound by their erasure, as a type argument by making
 * its class type raw, and standing alone by their erasure.
 */
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of type, as the replacement walks the type.
export function rawify(
  type: JavaType,
  unresolved: readonly TypeVariable[],
  asWildcards = false,
  asHoles = false
): JavaType {
  if (unresolved.length === 0) return type;
  switch (type.kind) {
    case 'typeVar': {
      return unresolved.includes(type.variable) ? erasure(type) : type;
    }
    case 'array': {
      return { kind: 'array', element: rawify(type.element, unresolved) };
    }
    case 'wildcard': {
      return type.bound ? { ...type, bound: rawify(type.bound, unresolved) } : type;
    }
    case 'class': {
      if (!type.args) return type;
      // A parameter keeps its other type arguments, which a lambda argument's parameters take.
      if (asWildcards || asHoles) {
        return {
          ...type,
          args: type.args.map((arg): JavaType =>
            arg.kind === 'typeVar' && unresolved.includes(arg.variable)
              ? { kind: 'wildcard', bound: undefined, isSuper: false, isHole: asHoles }
              : rawify(arg, unresolved, asWildcards, asHoles)
          ),
        };
      }
      const args = type.args.map((arg) => (arg.kind === 'wildcard' ? rawify(arg, unresolved) : arg));
      const mentions = args.some((arg) => arg.kind !== 'wildcard' && rawify(arg, unresolved) !== arg);
      return mentions ? type.cls.type : { ...type, args };
    }
    default: {
      return type;
    }
  }
}
