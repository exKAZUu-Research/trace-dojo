import type { Builtins } from './builtins';
import { boxedTypeOf } from './builtinWrappers';
import { functionalMethodOf } from './functionalInterfaces';
import { conditionalType } from './operators';
import {
  asSuper,
  bindingsOf,
  type ClassInfo,
  type ClassType,
  erasure,
  hasGenericOuter,
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

/**
 * Whether a postponed argument may be passed as `to`: a lambda or method reference as a functional interface whose
 * function takes a number of parameters it can, and a postponed call as anything its result type widens to.
 */
function isPendingConvertible(builtins: Builtins, from: Extract<JavaType, { kind: 'pending' }>, to: JavaType): boolean {
  if (from.isPoly) {
    return to.kind !== 'void' && (!from.polyErasure || isWidening(from.polyErasure, erasure(to), builtins.objectClass));
  }
  const bound = upperBound(to);
  const method = bound.kind === 'class' ? functionalMethodOf(bound.cls, builtins.objectClass) : undefined;
  if (!method) return false;
  const count = method.parameterTypes.length;
  // A lambda cannot implement a generic function, which a method reference may (JLS 15.27.3).
  if (from.lambda && !from.lambda.isReference && (method.typeParameters?.length ?? 0) > 0) return false;
  const fitsResult = !from.lambda || (method.returnType.kind === 'void' ? from.lambda.inVoid : from.lambda.inValue);
  return fitsResult && (from.arity === undefined || count === from.arity) && (from.arities?.includes(count) ?? true);
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
  if (from.kind === 'pending') return isPendingConvertible(builtins, from, to);
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
  if (!receiverType || (owner.typeParameters.length === 0 && !hasGenericOuter(owner))) return new Map();
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
export function methodView(method: MethodInfo, receiverBindings: ReadonlyMap<TypeVariable, JavaType>): MethodInfo {
  if (receiverBindings.size === 0) return method;
  const { typeParameters, bindings } = withBoundTypeParameters(method.typeParameters, receiverBindings);
  return {
    ...method,
    typeParameters,
    // A parameter of type `? super T` accepts a T, as capture conversion allows.
    parameterTypes: method.parameterTypes.map((type) => {
      const substituted = flattenWildcards(substitute(type, bindings));
      return substituted.kind === 'wildcard' && substituted.isSuper && substituted.bound
        ? substituted.bound
        : substituted;
    }),
    returnType: memberType(method.returnType, bindings),
    declared: method.declared ?? method,
  };
}

/**
 * A generic method's own type parameters as a receiver sees them: those bounded by the class's type variables, as
 * `<U extends T>` in `Box<T>`, become fresh variables bounded by the receiver's type arguments.
 */
function withBoundTypeParameters(
  typeParameters: TypeVariable[] | undefined,
  receiverBindings: ReadonlyMap<TypeVariable, JavaType>
): { typeParameters: TypeVariable[] | undefined; bindings: ReadonlyMap<TypeVariable, JavaType> } {
  // Bindings of the method's own type parameters, as explicit type arguments give, instantiate it instead.
  if (typeParameters?.some((variable) => receiverBindings.has(variable)))
    return { typeParameters, bindings: receiverBindings };
  const receiverVariables = [...receiverBindings.keys()];
  const isBoundByReceiver = typeParameters?.some((variable) =>
    variable.bounds.some((bound) => receiverVariables.some((receiverVariable) => mentions(bound, receiverVariable)))
  );
  if (!typeParameters || !isBoundByReceiver) return { typeParameters, bindings: receiverBindings };
  const bindings = new Map(receiverBindings);
  const fresh = typeParameters.map((variable): TypeVariable => ({ name: variable.name, bounds: [] }));
  for (const [index, variable] of typeParameters.entries()) {
    bindings.set(variable, { kind: 'typeVar', variable: fresh[index] as TypeVariable });
  }
  for (const [index, variable] of typeParameters.entries()) {
    (fresh[index] as TypeVariable).bounds = variable.bounds.map((bound) => substitute(bound, bindings));
  }
  return { typeParameters: fresh, bindings };
}

/**
 * Replaces a wildcard bounded by a wildcard, which substituting a receiver's wildcard type argument makes, by one
 * bounded by the inner bound, as capture conversion would: for `List<? super Integer>`, `addAll`'s
 * `Collection<? extends E>` takes a `Collection<? extends Integer>`, since `Integer` is below the captured `E`.
 */
function flattenWildcards(type: JavaType): JavaType {
  switch (type.kind) {
    case 'class': {
      return type.args ? { ...type, args: type.args.map((arg) => flattenWildcards(arg)) } : type;
    }
    case 'array': {
      return { ...type, element: flattenWildcards(type.element) };
    }
    case 'wildcard': {
      const bound = type.bound && flattenWildcards(type.bound);
      return { ...type, bound: bound?.kind === 'wildcard' ? bound.bound : bound };
    }
    default: {
      return type;
    }
  }
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
  // A type argument the target leaves undecided decides nothing, and the variable stays open for a later pass.
  for (const [variable, type] of bindings) if (mentionsHole(type)) bindings.delete(variable);
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
export function inferFromTarget(
  builtins: Builtins,
  method: MethodInfo,
  targetType: JavaType,
  bindings: Map<TypeVariable, JavaType>
): void {
  const fromTarget = new Map<TypeVariable, JavaType>();
  // A bounded wildcard of the target stands for its bound, as `T` in `Comparator<T>` takes `String` from
  // `Comparator<? super String>`, consistently with the target's other type arguments.
  const target =
    targetType.kind === 'class' && targetType.args
      ? { ...targetType, args: targetType.args.map((arg) => (arg.kind === 'wildcard' && arg.bound ? arg.bound : arg)) }
      : targetType;
  infer(builtins, liftTo(method.returnType, target), target, method.typeParameters ?? [], fromTarget);
  for (const [variable, type] of fromTarget) {
    const existing = bindings.get(variable);
    // A target only bounds a variable that is the whole result, as `R` of `collect`, so that an argument still
    // decides a narrower type: `Collection<Integer> c = stream.collect(toList())` takes `R` = `List<Integer>`.
    const isWholeResult = method.returnType.kind === 'typeVar' && method.returnType.variable === variable;
    if (!existing && isWholeResult && type.kind !== 'wildcard') {
      // The target itself, wildcards included, bounds the result, as `Map<K, ? extends Collection<V>>` does.
      bindUpperBound(builtins, variable, targetType, bindings);
      continue;
    }
    const widensToTarget =
      existing !== undefined &&
      type.kind !== 'wildcard' &&
      occursInTypeArgument(method.returnType, variable) &&
      isWidening(existing, type, builtins.objectClass);
    if (!existing || widensToTarget) bindings.set(variable, type);
  }
}

/**
 * `type` viewed as the supertype that has the class of `target`, with its type arguments viewed likewise, as
 * `List<T>` is a `Collection<T>` for a `Collection<Number>` target, so that inference can match it against the target.
 */
function liftTo(type: JavaType, target: JavaType): JavaType {
  if (type.kind !== 'class' || target.kind !== 'class') return type;
  const lifted = type.cls === target.cls ? type : asSuper(type, target.cls);
  if (!lifted?.args || !target.args) return lifted ?? type;
  const targetArgs = target.args;
  return {
    ...lifted,
    args: lifted.args.map((arg, index) => {
      const targetArg = targetArgs[index];
      const bound = targetArg?.kind === 'wildcard' ? targetArg.bound : targetArg;
      return bound ? liftTo(arg, bound) : arg;
    }),
  };
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
    bindVariable(builtins, parameterType.variable, argType, bindings);
    return;
  }
  if (parameterType.kind === 'array' && argType.kind === 'array') {
    infer(builtins, parameterType.element, argType.element, variables, bindings);
    return;
  }
  const parameterBound = parameterType.kind === 'wildcard' ? parameterType.bound : parameterType;
  // A wildcard bounded by a type variable alone, such as `? super V`, decides that variable.
  if (parameterBound?.kind === 'typeVar' && argType.kind !== 'wildcard') {
    // A type variable that is not being inferred, such as the enclosing method's `T`, decides nothing.
    if (parameterType.kind === 'wildcard') inferFromWildcard(builtins, parameterType, argType, variables, bindings);
    return;
  }
  if (parameterBound?.kind !== 'class' || !parameterBound.args) return;
  const argBound = upperBound(isPrimitive(argType) ? (boxedTypeOf(builtins.wrappers, argType) ?? argType) : argType);
  const supertype = argBound.kind === 'class' ? asSuper(argBound, parameterBound.cls) : undefined;
  if (!supertype?.args) return;
  for (const [index, parameterArg] of parameterBound.args.entries()) {
    const arg = supertype.args[index];
    // A type argument a nested generic call left partly undecided decides nothing.
    if (mentionsHole(arg)) continue;
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

/** Infers from a wildcard bounded by a type variable alone: `? super T` bounds `T` from above, `? extends T` decides it. */
function inferFromWildcard(
  builtins: Builtins,
  wildcard: Extract<JavaType, { kind: 'wildcard' }>,
  argType: JavaType,
  variables: readonly TypeVariable[],
  bindings: Map<TypeVariable, JavaType>
): void {
  const bound = wildcard.bound as Extract<JavaType, { kind: 'typeVar' }>;
  if (wildcard.isSuper && variables.includes(bound.variable))
    bindUpperBound(builtins, bound.variable, argType, bindings);
  else infer(builtins, bound, argType, variables, bindings);
}

/** The bindings that only an upper bound decided, which a type below it that another argument gives replaces. */
const upperBoundBindings = new WeakSet<JavaType>();

/**
 * Binds `variable`, which a `? super T` parameter bounds from above by an argument's type, to that type unless
 * another argument decides it: `copy(List<? super T> dst, List<T> src)` takes `T` from `src`.
 */
function bindUpperBound(
  builtins: Builtins,
  variable: TypeVariable,
  argType: JavaType,
  bindings: Map<TypeVariable, JavaType>
): void {
  if (bindings.has(variable)) return;
  const bound = isPrimitive(argType) ? boxedTypeOf(builtins.wrappers, argType) : argType;
  if (!bound) return;
  const binding = { ...bound };
  upperBoundBindings.add(binding);
  bindings.set(variable, binding);
}

/** Binds `variable` to the type of an argument, or to its least upper bound with the type it already has. */
function bindVariable(
  builtins: Builtins,
  variable: TypeVariable,
  argType: JavaType,
  bindings: Map<TypeVariable, JavaType>
): void {
  const inferred = isPrimitive(argType) ? boxedTypeOf(builtins.wrappers, argType) : argType;
  if (!inferred) return;
  const existing = bindings.get(variable);
  // A raw type, as a method reference such as `List::size` names it, gives way to the same class with arguments.
  const isRawOfInferred =
    existing?.kind === 'class' &&
    inferred.kind === 'class' &&
    existing.cls === inferred.cls &&
    !existing.args?.length &&
    (inferred.args?.length ?? 0) > 0;
  if (
    !existing ||
    isRawOfInferred ||
    isWidening(existing, inferred, builtins.objectClass) ||
    (upperBoundBindings.has(existing) && isWidening(inferred, existing, builtins.objectClass))
  ) {
    bindings.set(variable, inferred);
  } else if (!isWidening(inferred, existing, builtins.objectClass)) {
    bindings.set(variable, conditionalType(builtins.objectClass, existing, inferred) ?? builtins.objectClass.type);
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
  const target = arg.kind === 'wildcard' && arg.bound ? arg.bound : arg;
  // A raw class, as `List::size` names it, decides a variable only until another argument gives its type arguments.
  const isRaw = hint.kind === 'class' && !hint.args?.length && hint.cls.typeParameters.length > 0;
  if (isRaw && target.kind === 'typeVar' && variables.includes(target.variable)) {
    bindUpperBound(builtins, target.variable, hint, bindings);
    return;
  }
  infer(builtins, target, hint, variables, bindings);
}

/**
 * Replaces type variables left `unresolved`: inside a wildcard's bound by their erasure, as a type argument by making
 * its class type raw, and standing alone by their erasure.
 */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of type, as the replacement walks the type.
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
      return { kind: 'array', element: rawify(type.element, unresolved, asWildcards, asHoles) };
    }
    case 'wildcard': {
      // A wildcard bounded by an undecided variable, as `? extends R`, leaves it undecided too.
      if (asHoles && type.bound?.kind === 'typeVar' && unresolved.includes(type.bound.variable)) {
        return { kind: 'wildcard', bound: undefined, isSuper: false, isHole: true };
      }
      return type.bound ? { ...type, bound: rawify(type.bound, unresolved, asWildcards, asHoles) } : type;
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

/** Whether a type has a type argument that inference left undecided. */
export function mentionsHole(type: JavaType): boolean {
  if (type.kind === 'wildcard') return type.isHole === true || (type.bound !== undefined && mentionsHole(type.bound));
  if (type.kind === 'array') return mentionsHole(type.element);
  return type.kind === 'class' && (type.args?.some((arg) => mentionsHole(arg)) ?? false);
}

/**
 * Whether `type` is more specific than `other` for an explicitly typed lambda argument because its function returns
 * a value where the other's returns nothing (JLS 15.12.2.5).
 */
export function returnsForLambda(
  builtins: Builtins,
  arg: JavaType | undefined,
  type: JavaType,
  other: JavaType
): boolean {
  if (arg?.kind !== 'pending' || !arg.lambda?.isExplicit) return false;
  const functionOf = (candidate: JavaType): MethodInfo | undefined => {
    const bound = upperBound(candidate);
    return bound.kind === 'class' ? functionalMethodOf(bound.cls, builtins.objectClass) : undefined;
  };
  const [mine, theirs] = [functionOf(type), functionOf(other)];
  return (
    mine !== undefined && theirs !== undefined && mine.returnType.kind !== 'void' && theirs.returnType.kind === 'void'
  );
}
