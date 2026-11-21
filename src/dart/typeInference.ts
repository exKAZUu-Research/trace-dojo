import {
  asInstanceOf,
  boundOf,
  closeTypeVariables,
  type DartType,
  DYNAMIC,
  type FunctionType,
  instantiateFunction,
  instantiateToBounds,
  type InterfaceType,
  isSubtype,
  lowerBound,
  mentionsTypeParams,
  NEVER,
  objectPatternBound,
  type RecordType,
  resolveBound,
  substitute,
  type TypeParam,
  typeParamType,
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
  const lower = new Map<TypeParam, DartType>();
  const upper = new Map<TypeParam, DartType>();
  new InferenceConstraints(params, lower, upper, upperBound, true).infer(context, formal, true);
  for (const param of params) {
    const choice = lower.get(param) ?? upper.get(param);
    if (choice) solution.set(param, choice);
  }
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

export function inferObjectPatternType(
  matchedType: DartType,
  template: DartType,
  params: readonly TypeParam[]
): DartType {
  const parameters = new Set(params);
  const lower = new Map<TypeParam, DartType>();
  const upper = new Map<TypeParam, DartType>();
  new InferenceConstraints(parameters, lower, upper, upperBound, true).infer(
    nonNullOf(resolveBound(matchedType)),
    template,
    true
  );
  const inferred = new Map(
    params.map((param) => [param, lower.get(param) ?? upper.get(param) ?? objectPatternBound(param, parameters)])
  );
  for (const [param, candidate] of inferred) {
    const declared = substitute(boundOf(param), inferred);
    if (!isSubtype(candidate, declared)) inferred.set(param, objectPatternBound(param, parameters));
  }
  return substitute(template, inferred);
}

export function inferExtensionReceiver(actual: DartType, formal: DartType, params: readonly TypeParam[]): DartType[] {
  const parameters = new Set(params);
  const lower = new Map<TypeParam, DartType>();
  const upper = new Map<TypeParam, DartType>();
  const constraints = new InferenceConstraints(parameters, lower, upper, upperBound, true);
  constraints.infer(actual, formal);
  const solution = new Map<TypeParam, DartType>();
  const env = new Map<TypeParam, DartType>(params.map((param) => [param, DYNAMIC]));
  for (const param of params) {
    const input = lower.get(param);
    if (input && param.bound && mentionsTypeParams(param.bound, parameters)) constraints.infer(input, param.bound);
    const limit = upper.get(param);
    const choice = lower.get(param) ?? (limit && lowerBound(limit, substitute(boundOf(param), env)));
    if (choice) {
      solution.set(param, choice);
      env.set(param, choice);
    }
  }
  return instantiateToBounds(params, solution);
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
  private scopedParameters = new Set<TypeParam>();

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
      this.inferFunction(given, pattern, reversed);
    } else if (pattern.kind === 'record' && given.kind === 'record') {
      this.inferRecord(given, pattern, reversed);
    }
  }

  private addBound(given: DartType, pattern: DartType & { kind: 'typeParam' }, reversed: boolean): void {
    const bounds = reversed ? this.upper : this.lower;
    if (!bounds || (reversed && given.kind === 'dynamic')) return;
    let target = pattern.nullable ? nonNullOf(given) : given;
    if (this.scopedParameters.size > 0 && mentionsTypeParams(target, this.scopedParameters)) {
      target = closeTypeVariables(target, this.scopedParameters, !reversed);
    }
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

  private inferFunction(given: FunctionType, pattern: FunctionType, reversed: boolean): void {
    if (given.typeParams.length !== pattern.typeParams.length) return;
    if (given.typeParams.length === 0) {
      this.inferFunctionBody(given, pattern, reversed);
      return;
    }
    const enclosingParameters = this.scopedParameters;
    this.scopedParameters = new Set([...enclosingParameters, ...given.typeParams]);
    try {
      const typeArguments = given.typeParams.map((param) => typeParamType(param));
      const renamed = new Map(pattern.typeParams.map((param, index) => [param, typeArguments[index]]));
      for (const [index, param] of pattern.typeParams.entries()) {
        const givenBound = boundOf(given.typeParams[index]);
        const patternBound = substitute(boundOf(param), renamed);
        this.infer(givenBound, patternBound);
        this.infer(givenBound, patternBound, true);
      }
      this.inferFunctionBody(given, instantiateFunction(pattern, typeArguments), reversed);
    } finally {
      this.scopedParameters = enclosingParameters;
    }
  }

  private inferFunctionBody(given: FunctionType, pattern: FunctionType, reversed: boolean): void {
    this.infer(given.returnType, pattern.returnType, reversed);
    if (this.upper) this.inferParameters(given, pattern, !reversed);
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
