import type { ClassSymbol, TypeParameterSymbol } from './symbols';

/** A Kotlin type as the compiler checks it. Generic arguments are erased when the program runs, as on the JVM. */
export type KType = ClassType | ParameterType | FunctionType | NothingType | VariableType;

export interface ClassType {
  kind: 'class';
  cls: ClassSymbol;
  args: TypeArgument[];
  nullable: boolean;
}

export interface ParameterType {
  kind: 'param';
  param: TypeParameterSymbol;
  nullable: boolean;
  /** Whether the type is `T & Any`, which no `null` is of, whatever `T` is. */
  definitelyNonNull?: boolean;
}

export interface FunctionType {
  kind: 'function';
  receiver: KType | undefined;
  params: KType[];
  returnType: KType;
  nullable: boolean;
  /** Whether the type is `suspend () -> R`, whose values only coroutines and suspend functions call. */
  isSuspend?: boolean;
  /** The types of `context(A) () -> R`, whose values a call passes from its context, after the receiver. */
  contextTypes?: KType[];
}

/** `Nothing`, whose nullable form `Nothing?` is the type of `null`. */
export interface NothingType {
  kind: 'nothing';
  nullable: boolean;
}

/** A type variable of a generic call that inference has not yet fixed. */
export interface VariableType {
  kind: 'variable';
  variable: InferenceVariable;
  nullable: boolean;
}

export interface InferenceVariable {
  param: TypeParameterSymbol;
  /** Types the variable must be a supertype of. */
  lower: KType[];
  /** Types the variable must be a subtype of. */
  upper: KType[];
  fixed: KType | undefined;
}

export type TypeArgument = { variance: 'inv' | 'out' | 'in'; type: KType } | { variance: 'star' };

export const NOTHING: NothingType = { kind: 'nothing', nullable: false };
export const NULL_TYPE: NothingType = { kind: 'nothing', nullable: true };

export function classType(cls: ClassSymbol, args: KType[] = [], nullable = false): ClassType {
  return { kind: 'class', cls, args: args.map((type) => ({ variance: 'inv', type })), nullable };
}

export function withNullability<T extends KType>(type: T, nullable: boolean): T {
  if (type.kind === 'param' && nullable && type.definitelyNonNull)
    return { ...type, nullable, definitelyNonNull: undefined };
  if (type.nullable === nullable) return type;
  return { ...type, nullable };
}

export function nullable(type: KType): KType {
  return withNullability(type, true);
}

export function nonNull(type: KType): KType {
  if (type.kind === 'variable' && type.variable.fixed) return nonNull(type.variable.fixed);
  // A type parameter that may stand for a nullable type is `T & Any` once a value of it is known not to be null.
  if (type.kind === 'param' && !type.definitelyNonNull && isNullable({ ...type, nullable: false }))
    return { ...type, nullable: false, definitelyNonNull: true };
  return withNullability(type, false);
}

/** Whether a value of the type may be `null`, which a type parameter without a non-null bound may hold. */
export function isNullable(type: KType): boolean {
  if (type.nullable) return true;
  if (type.kind === 'param')
    return !type.definitelyNonNull && (type.param.bounds.length === 0 || type.param.bounds.every(isNullable));
  if (type.kind === 'variable' && type.variable.fixed) return isNullable(type.variable.fixed);
  return false;
}

/** Whether the type is `Nothing` itself, the type of expressions that never complete. */
export function isNothing(type: KType): boolean {
  return type.kind === 'nothing' && !type.nullable;
}

export function isNonNullClass(type: KType | undefined, cls: ClassSymbol): boolean {
  const actual = type && resolved(type);
  return actual?.kind === 'class' && actual.cls === cls && !actual.nullable;
}

/** The argument types of a class type, with a star projection read as its bound. */
export function argumentTypes(type: ClassType, starBound: () => KType): KType[] {
  return type.args.map((argument) => (argument.variance === 'star' ? starBound() : argument.type));
}

export type Substitution = ReadonlyMap<TypeParameterSymbol, KType>;

/** Replaces the type parameters a substitution maps, keeping the nullability the use adds. */
export function substitute(type: KType, substitution: Substitution): KType {
  if (substitution.size === 0) return type;
  switch (type.kind) {
    case 'param': {
      const replacement = substitution.get(type.param);
      if (!replacement) return type;
      if (type.definitelyNonNull) return nonNull(replacement);
      return type.nullable ? nullable(replacement) : replacement;
    }
    case 'class': {
      if (type.args.length === 0) return type;
      return {
        ...type,
        args: type.args.map((argument) =>
          argument.variance === 'star'
            ? argument
            : { variance: argument.variance, type: substitute(argument.type, substitution) }
        ),
      };
    }
    case 'function': {
      return {
        ...type,
        receiver: type.receiver ? substitute(type.receiver, substitution) : undefined,
        contextTypes: type.contextTypes?.map((each) => substitute(each, substitution)),
        params: type.params.map((param) => substitute(param, substitution)),
        returnType: substitute(type.returnType, substitution),
      };
    }
    default: {
      return type;
    }
  }
}

/** Follows fixed inference variables to the types they stand for. */
export function resolved(type: KType): KType {
  switch (type.kind) {
    case 'variable': {
      const { fixed } = type.variable;
      if (!fixed) return type;
      const inner = resolved(fixed);
      return type.nullable ? nullable(inner) : inner;
    }
    case 'class': {
      if (type.args.length === 0) return type;
      return {
        ...type,
        args: type.args.map((argument) =>
          argument.variance === 'star' ? argument : { variance: argument.variance, type: resolved(argument.type) }
        ),
      };
    }
    case 'function': {
      return {
        ...type,
        receiver: type.receiver ? resolved(type.receiver) : undefined,
        contextTypes: type.contextTypes?.map(resolved),
        params: type.params.map(resolved),
        returnType: resolved(type.returnType),
      };
    }
    default: {
      return type;
    }
  }
}

/** Whether a type mentions an inference variable that is not fixed yet. */
export function hasOpenVariables(type: KType): boolean {
  return mentionsVariable(type, (variable) => variable.fixed === undefined);
}

/** Whether a type mentions an inference variable that `test` accepts, looking through fixed variables to their types. */
export function mentionsVariable(type: KType, test: (variable: InferenceVariable) => boolean): boolean {
  switch (type.kind) {
    case 'variable': {
      return test(type.variable) || (type.variable.fixed !== undefined && mentionsVariable(type.variable.fixed, test));
    }
    case 'class': {
      return type.args.some((argument) => argument.variance !== 'star' && mentionsVariable(argument.type, test));
    }
    case 'function': {
      return (
        (type.receiver !== undefined && mentionsVariable(type.receiver, test)) ||
        type.params.some((param) => mentionsVariable(param, test)) ||
        mentionsVariable(type.returnType, test)
      );
    }
    default: {
      return false;
    }
  }
}

/** Writes a type as Kotlin's compiler does in its messages. */
// code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
export function typeToString(type: KType): string {
  const suffix = type.nullable ? '?' : '';
  switch (type.kind) {
    case 'class': {
      const args =
        type.args.length === 0
          ? ''
          : `<${type.args
              .map((argument) => {
                if (argument.variance === 'star') return '*';
                const variance = argument.variance === 'inv' ? '' : `${argument.variance} `;
                return `${variance}${typeToString(argument.type)}`;
              })
              .join(', ')}>`;
      return `${type.cls.name}${args}${suffix}`;
    }
    case 'param': {
      return type.definitelyNonNull ? `${type.param.name} & Any` : `${type.param.name}${suffix}`;
    }
    case 'function': {
      const receiver = type.receiver ? `${typeToString(type.receiver)}.` : '';
      const contexts = type.contextTypes?.length ? `context(${type.contextTypes.map(typeToString).join(', ')}) ` : '';
      const text = `${contexts}${type.isSuspend ? 'suspend ' : ''}${receiver}(${type.params.map(typeToString).join(', ')}) -> ${typeToString(type.returnType)}`;
      return type.nullable ? `(${text})?` : text;
    }
    case 'nothing': {
      return `Nothing${suffix}`;
    }
    case 'variable': {
      return type.variable.fixed
        ? typeToString(withNullabilityOf(type.variable.fixed, type.nullable))
        : `${type.variable.param.name}${suffix}`;
    }
  }
}

function withNullabilityOf(type: KType, addsNullable: boolean): KType {
  return addsNullable ? nullable(type) : type;
}
