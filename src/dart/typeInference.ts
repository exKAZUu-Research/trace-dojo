import {
  asInstanceOf,
  boundOf,
  type DartType,
  DYNAMIC,
  type FunctionType,
  instantiateToBounds,
  type InterfaceType,
  isSubtype,
  lowerBound,
  mentionsTypeParams,
  NEVER,
  type RecordType,
  resolveBound,
  substitute,
  type TypeParam,
  upperBound,
} from './types';

/**
 * Collects the constraints a context puts on a function's result type: where the result is a subclass of the context's
 * class (`R<int> r = E()`), its type arguments are matched through the subclass's supertype.
 */
export function inferFromContext(
  context: DartType,
  formal: DartType,
  params: ReadonlySet<TypeParam>,
  solution: Map<TypeParam, DartType>
): void {
  const base = resolveBound(context);
  const constraints = new InferenceConstraints(params, solution, undefined, (a) => a, true);
  if (
    formal.kind === 'interface' &&
    base.kind === 'interface' &&
    formal.cls !== base.cls &&
    formal.cls.isSubclassOf(base.cls)
  ) {
    const path = asInstanceOf(formal, base.cls);
    if (path) {
      for (const [index, arg] of path.args.entries()) {
        const given = base.args[index];
        if (given) constraints.infer(given, arg);
      }
      return;
    }
  }
  constraints.infer(context, formal);
}

/** Collects constraints on type parameters that occur in the parameter type of a generic call. */
export function inferFromSubtype(
  actual: DartType,
  formal: DartType,
  params: ReadonlySet<TypeParam>,
  lower: Map<TypeParam, DartType>,
  join: (a: DartType, b: DartType) => DartType = (a) => a,
  upper?: Map<TypeParam, DartType>
): void {
  new InferenceConstraints(params, lower, upper, join).infer(actual, formal);
}

export function inferExtensionReceiver(actual: DartType, formal: DartType, params: readonly TypeParam[]): DartType[] {
  const parameters = new Set(params);
  const lower = new Map<TypeParam, DartType>();
  const upper = new Map<TypeParam, DartType>();
  new InferenceConstraints(parameters, lower, upper, upperBound, true).infer(actual, formal);
  if (upper.size === 0) return instantiateToBounds(params, lower);
  const initial = instantiateToBounds(params, new Map([...upper, ...lower]));
  const env = new Map(params.map((param, index) => [param, initial[index]]));
  for (const [param, limit] of upper) {
    if (!lower.has(param)) lower.set(param, extensionUpperSolution(limit, boundOf(param), parameters, env));
  }
  return instantiateToBounds(params, lower);
}

function extensionUpperSolution(
  limit: DartType,
  declaredBound: DartType,
  parameters: ReadonlySet<TypeParam>,
  env: ReadonlyMap<TypeParam, DartType>
): DartType {
  if (declaredBound.kind === 'typeParam' && parameters.has(declaredBound.param)) return limit;
  const meet = lowerBound(limit, substitute(declaredBound, env));
  if (meet.kind === 'never' || meet.kind === 'null' || !mentionsTypeParams(declaredBound, parameters)) return meet;
  return limit;
}

export function inferTearOffTypes(
  source: FunctionType,
  expected: FunctionType,
  defaults: DartType[]
): DartType[] | undefined {
  const solution = new Map<TypeParam, DartType>();
  const upper = new Map<TypeParam, DartType>();
  const constraints = new InferenceConstraints(new Set(source.typeParams), solution, upper, upperBound, true);
  for (const [index, parameter] of source.positional.entries()) {
    const given = expected.positional[index];
    if (given) constraints.infer(given, parameter);
  }
  for (const named of source.named) {
    const given = expected.named.find((other) => other.name === named.name);
    if (given) constraints.infer(given.type, named.type);
  }
  if (expected.returnType.kind !== 'dynamic' && expected.returnType.kind !== 'void')
    constraints.infer(expected.returnType, source.returnType, true);
  const typeArgs = source.typeParams.map((param, index) => solution.get(param) ?? upper.get(param) ?? defaults[index]);
  const argumentsByParameter = new Map(source.typeParams.map((param, index) => [param, typeArgs[index]]));
  for (const [param, arg] of argumentsByParameter) {
    if (param.bound && !isSubtype(arg, substitute(param.bound, argumentsByParameter))) return undefined;
  }
  return typeArgs;
}

class InferenceConstraints {
  constructor(
    private readonly params: ReadonlySet<TypeParam>,
    private readonly lower: Map<TypeParam, DartType>,
    private readonly upper: Map<TypeParam, DartType> | undefined,
    private readonly join: (a: DartType, b: DartType) => DartType,
    private readonly retainBottom = false
  ) {}

  infer(given: DartType, pattern: DartType, reversed = false): void {
    if (pattern.kind === 'typeParam' && this.params.has(pattern.param)) {
      this.addBound(given, pattern, reversed);
    } else if (pattern.kind === 'interface') {
      this.inferInterface(given, pattern, reversed);
    } else if (pattern.kind === 'function' && given.kind === 'function') {
      this.infer(given.returnType, pattern.returnType, reversed);
      if (this.upper) this.inferParameters(given, pattern, !reversed);
    } else if (pattern.kind === 'record' && given.kind === 'record') {
      this.inferRecord(given, pattern, reversed);
    }
  }

  private addBound(given: DartType, pattern: DartType & { kind: 'typeParam' }, reversed: boolean): void {
    const bounds = reversed ? this.upper : this.lower;
    if (!bounds || (reversed && given.kind === 'dynamic')) return;
    const target = pattern.nullable ? nonNullOf(given) : given;
    if (!this.retainBottom && !reversed && target.kind === 'never' && !target.nullable) return;
    const previous = bounds.get(pattern.param);
    const join = reversed ? lowerBound : this.join;
    bounds.set(pattern.param, previous ? join(previous, target) : target);
  }

  private inferInterface(given: DartType, pattern: InterfaceType, reversed: boolean): void {
    const base = resolveBound(given);
    if (base.kind === 'dynamic' && !reversed) {
      for (const arg of pattern.args) this.infer(DYNAMIC, arg);
      return;
    }
    if (base.kind !== 'interface') return;
    const actualType = reversed ? base : asInstanceOf({ ...base, nullable: false }, pattern.cls);
    const formalType = reversed ? asInstanceOf(pattern, base.cls) : pattern;
    if (!actualType || !formalType) return;
    for (const [index, arg] of formalType.args.entries()) {
      const actualArg = actualType.args[index];
      if (actualArg) this.infer(actualArg, arg, reversed);
    }
  }

  private inferParameters(given: FunctionType, pattern: FunctionType, reversed: boolean): void {
    for (const [index, parameter] of pattern.positional.entries()) {
      const corresponding = given.positional[index];
      if (corresponding) this.infer(corresponding, parameter, reversed);
    }
    for (const parameter of pattern.named) {
      const corresponding = given.named.find((other) => other.name === parameter.name);
      if (corresponding) this.infer(corresponding.type, parameter.type, reversed);
    }
  }

  private inferRecord(given: RecordType, pattern: RecordType, reversed: boolean): void {
    for (const [index, field] of pattern.positional.entries()) {
      const actualField = given.positional[index];
      if (actualField) this.infer(actualField, field, reversed);
    }
    for (const field of pattern.named) {
      const actualField = given.named.find((other) => other.name === field.name);
      if (actualField) this.infer(actualField.type, field.type, reversed);
    }
  }
}

function nonNullOf(type: DartType): DartType {
  if (type.kind === 'null') return NEVER;
  if (type.kind === 'interface' || type.kind === 'function' || type.kind === 'record') {
    return type.nullable ? { ...type, nullable: false } : type;
  }
  if (type.kind === 'typeParam' && type.nullable) return { ...type, nullable: false };
  return type;
}
