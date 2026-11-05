import type { Builtins } from './builtins';
import { boxedTypeOf } from './builtinWrappers';
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
  if (isWidening(from, to, builtins.objectClass)) return true;
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
  return substituted.kind === 'wildcard' ? upperBound(substituted) : substituted;
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
 */
export function instantiateMethod(
  builtins: Builtins,
  method: MethodInfo,
  argTypes: readonly JavaType[]
): MethodInfo | undefined {
  const variables = method.typeParameters ?? [];
  if (variables.length === 0) return method;
  const bindings = new Map<TypeVariable, JavaType>();
  for (const [index, parameterType] of method.parameterTypes.entries()) {
    const argType = argTypes[index] as JavaType | undefined;
    if (argType) infer(builtins, parameterType, argType, variables, bindings);
  }
  // An inferred type outside its variable's bounds makes the method inapplicable.
  for (const [variable, type] of bindings) {
    const fits = variable.bounds.every((bound) => isWidening(type, substitute(bound, bindings), builtins.objectClass));
    if (!fits) return;
  }
  const unresolved = variables.filter((variable) => !bindings.has(variable));
  const instantiate = (type: JavaType): JavaType => rawify(substitute(type, bindings), unresolved);
  return {
    ...method,
    parameterTypes: method.parameterTypes.map(instantiate),
    returnType: instantiate(method.returnType),
    typeParameters: [],
    declared: method.declared ?? method,
  };
}

/** Infers the types of `variables` that make an argument of `argType` fit a parameter of `parameterType`. */
export function infer(
  builtins: Builtins,
  parameterType: JavaType,
  argType: JavaType,
  variables: readonly TypeVariable[],
  bindings: Map<TypeVariable, JavaType>
): void {
  if (argType.kind === 'null') return;
  if (parameterType.kind === 'typeVar' && variables.includes(parameterType.variable)) {
    const inferred = isPrimitive(argType) ? boxedTypeOf(builtins.wrappers, argType) : argType;
    if (!inferred) return;
    const existing = bindings.get(parameterType.variable);
    if (!existing || isWidening(existing, inferred, builtins.objectClass))
      bindings.set(parameterType.variable, inferred);
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
    infer(builtins, parameterArg, arg.kind === 'wildcard' ? upperBound(arg) : arg, variables, bindings);
  }
}

/** Makes raw the class types that mention `unresolved` variables, which also erase where they stand alone. */
export function rawify(type: JavaType, unresolved: readonly TypeVariable[]): JavaType {
  if (unresolved.length === 0) return type;
  const mentions = (inner: JavaType): boolean => {
    switch (inner.kind) {
      case 'typeVar': {
        return unresolved.includes(inner.variable);
      }
      case 'class': {
        return inner.args?.some(mentions) ?? false;
      }
      case 'array': {
        return mentions(inner.element);
      }
      case 'wildcard': {
        return inner.bound !== undefined && mentions(inner.bound);
      }
      default: {
        return false;
      }
    }
  };
  return mentions(type) ? erasure(type) : type;
}
