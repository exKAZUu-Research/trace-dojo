// code-gauge-allow-file fileNcss -- Keeps generic candidate collection, constraint fitting and inference completion together.
import { ExecutionLimitError, LIMITS } from '../../interpreter/limits';
import type { Checker, Mapper } from './checker';
import { isUnit } from './flow';
import { childTypes, objectMemberTypes } from './genericTypes';
import { applicableIndex, hasIndexSignature, isIndexKeyOf, isPropertyKeyOf, keyedIndexes } from './indexInfos';
import { reverseMappedType } from './reverseMappedInference';
import { hasBivariantParameters } from './signatures';
import { templateParts } from './templateParts';
import { tupleTypesDefinitelyUnrelated } from './tupleIndexes';
import {
  anonymousObject,
  anyType,
  type ConditionalType,
  createMapper,
  emptyStructure,
  errorType,
  functionType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  isTemplateOrStringMapping,
  literalType,
  type MappedInfo,
  neverType,
  newTypeId,
  nullType,
  type ObjectType,
  type Parameter,
  propertyAccessType,
  regularOf,
  type Signature,
  type Structure,
  type TemplateLiteralType,
  type TupleElement,
  type TupleInfo,
  type Type,
  typeMembers,
  type TypeParameter,
  undefinedType,
  unionOf,
  type UnionType,
  unknownType,
  voidType,
} from './types';
import { couldContainTypeVariables } from './typeVariables';

/**
 * How indirectly a step infers, as TypeScript's `InferencePriority` flags: a candidate replaces those of a greater
 * priority and is ignored next to those of a smaller one.
 */
export const InferencePriority = {
  Direct: 0,
  NakedTypeVariable: 1,
  SpeculativeTuple: 2,
  SubstituteSource: 4,
  /** Through a homomorphic mapped type, as `T` in `Partial<T>`. */
  HomomorphicMappedType: 8,
  MappedTypeConstraint: 32,
  ContravariantConditional: 64,
  /** From the type the call's result is expected to have. */
  ReturnType: 128,
} as const;

export interface Inference {
  candidates: Type[];
  candidateDepths: Map<number, number>;
  contravariant: Type[];
  /** The priority of the candidates so far. */
  priority: number;
  /** Whether a candidate came from a position where the parameter is the whole type, not part of one. */
  topLevel: boolean;
  /** How many arguments a rest parameter typed by this parameter takes, as `A` in `...args: A` does. */
  impliedArity?: number;
  /** The type a callback's parameters fixed the parameter to, which later candidates no longer change. */
  fixed?: Type;
  /** Whether a callback parameter mentioned this parameter, preventing later candidates even before any exist. */
  isFixed?: boolean;
}

/** The inferences for the type parameters of one call or comparison, which each inference step adds to. */
export interface InferenceRun {
  inferences: Map<number, Inference>;
  parameters: TypeParameter[];
  priority: number;
  bivariant?: boolean;
  reportInference?: (priority: number) => void;
  contextualSignatures: boolean;
  higherOrder?: { outer: Signature; parameters: TypeParameter[] };
  reverseMapped?: { source: TypeParameter; key: TypeParameter; value: TypeParameter };
}

type ParameterPosition = 'parameter' | 'bivariantParameter';

type Recurse = (
  source: Type,
  target: Type,
  position?: ParameterPosition,
  priority?: number,
  reportInference?: InferenceRun['reportInference']
) => void;

interface InferencePath {
  active: Set<string>;
  argumentDepth: number;
  originalTarget: Type;
  sources: Type[];
  targets: Type[];
}

/** Infers type arguments from the types that are matched against the types their parameters appear in. */
export class TypeInference {
  private depth = 0;
  private inferentialDepth = 0;
  private readonly nonInferrableParameters = new Map<number, TypeParameter>();
  constructor(private readonly c: Checker) {}

  get isInferential(): boolean {
    return this.inferentialDepth > 0;
  }

  probeInferential<T>(run: () => T): T {
    this.inferentialDepth++;
    try {
      return run();
    } finally {
      this.inferentialDepth--;
    }
  }

  contextualMapper(
    parameters: TypeParameter[],
    inferences: Map<number, Inference>,
    fixes: (parameter: TypeParameter) => boolean = () => false,
    keepsFixed: (parameter: TypeParameter) => boolean = () => false
  ): Mapper | undefined {
    return this.partialMapper(parameters, inferences, fixes, keepsFixed, true);
  }

  /**
   * The type arguments inferred so far, with each parameter `fixes` selects fixed to its constraint or `unknown` when
   * nothing was inferred for it; the others stay type parameters. A parameter `keepsFixed` selects keeps that type, as
   * TypeScript fixes a parameter once a callback's parameter types it.
   */
  partialMapper(
    parameters: TypeParameter[],
    inferences: Map<number, Inference>,
    fixes: (parameter: TypeParameter) => boolean = () => false,
    keepsFixed: (parameter: TypeParameter) => boolean = () => false,
    useNonInferrable = false
  ): Mapper | undefined {
    const mapper: Mapper = new Map();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id);
      const fixed = fixes(parameter);
      const type =
        this.provisionalType(parameter, inference, fixed) ??
        (useNonInferrable ? this.nonInferrableOf(parameter) : undefined);
      if (!type) continue;
      mapper.set(parameter.id, type);
      if (fixed && inference && keepsFixed(parameter)) {
        inference.isFixed = true;
        if (hasCandidates(inference)) inference.fixed = type;
      }
    }
    return mapper.size > 0 ? mapper : undefined;
  }

  private provisionalType(
    parameter: TypeParameter,
    inference: Inference | undefined,
    fixed: boolean
  ): Type | undefined {
    if (inference?.fixed) return inference.fixed;
    if (!inference || !hasCandidates(inference)) return fixed ? (parameter.constraint?.() ?? unknownType) : undefined;
    const type = this.inferredType(parameter, inference, fixed);
    if (inference.priority === InferencePriority.ReturnType && isAnyLike(type)) {
      return fixed ? (parameter.constraint?.() ?? unknownType) : undefined;
    }
    return type;
  }

  private nonInferrableOf(parameter: TypeParameter): TypeParameter {
    let placeholder = this.nonInferrableParameters.get(parameter.id);
    if (!placeholder) {
      placeholder = { ...parameter, id: newTypeId(), isNonInferrable: true };
      this.nonInferrableParameters.set(parameter.id, placeholder);
    }
    return placeholder;
  }

  finalMapper(signature: Signature, parameters: TypeParameter[], inferences: Map<number, Inference>): Mapper {
    return this.finalMappers(signature, parameters, inferences).mapper;
  }

  finalMappers(
    signature: Signature,
    parameters: TypeParameter[],
    inferences: Map<number, Inference>
  ): { mapper: Mapper; contextualMapper?: Mapper } {
    const mapper: Mapper = new Map();
    const nonInferrable = new Set<number>();
    const silent = new Set<number>();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id) as Inference;
      const resolved = this.resolveParameterInference(signature, parameter, inference, mapper);
      mapper.set(parameter.id, resolved.type);
      if (resolved.silent) silent.add(parameter.id);
      if (resolved.nonInferrable) nonInferrable.add(parameter.id);
    }
    for (const clamped of this.constrainInferences(parameters, mapper, undefined, silent)) nonInferrable.add(clamped);
    if (this.inferentialDepth > 0 || nonInferrable.size === 0) return { mapper };
    const contextualMapper: Mapper = createMapper(mapper);
    for (const parameter of parameters) {
      if (nonInferrable.has(parameter.id)) contextualMapper.set(parameter.id, this.nonInferrableOf(parameter));
    }
    return { mapper, contextualMapper };
  }

  private resolveParameterInference(
    signature: Signature,
    parameter: TypeParameter,
    inference: Inference,
    mapper: Mapper
  ): { type: Type; silent?: true; nonInferrable?: true } {
    if (inference.fixed) return { type: inference.fixed };
    if (hasCandidates(inference)) {
      return { type: this.inferredType(parameter, inference, !this.isTopLevelInReturn(signature, parameter)) };
    }
    if (this.inferentialDepth > 0 && !parameter.default) return { type: silentNeverType, silent: true };
    return {
      type: this.c.instantiate(parameter.default?.() ?? parameter.constraint?.() ?? unknownType, createMapper(mapper)),
      nonInferrable: !inference.isFixed ? true : undefined,
    };
  }

  private isTopLevelInReturn(signature: Signature, parameter: TypeParameter): boolean {
    const returnType =
      signature.predicate && !signature.predicate.asserts ? signature.predicate.type : signature.returnType();
    return !!returnType && isTopLevelTypeParameter(returnType, parameter);
  }

  private inferredType(parameter: TypeParameter, inference: Inference, widen: boolean): Type {
    const raw = this.rawInferredType(parameter, inference, widen);
    return couldContainTypeVariables(raw) ? this.c.instantiate(raw, silentNeverToUnknown) : raw;
  }

  private rawInferredType(parameter: TypeParameter, inference: Inference, widen: boolean): Type {
    if (inference.candidates.length === 0) {
      return this.commonSubtype(inference.contravariant);
    }
    const shouldWiden =
      widen && inference.topLevel && !parameter.isConst && !this.c.literals.hasPrimitiveConstraint(parameter);
    const candidates = equivalentInferenceCandidates(inference).map((candidate) =>
      shouldWiden ? this.c.widenLiteral(candidate) : regularOf(candidate)
    );
    const covariantType = this.commonSupertype(candidates);
    // A covariant inference that fits none of the contravariant ones loses to them, as `A` in `f.call(null, ...args)`.
    if (
      inference.contravariant.length > 0 &&
      !inference.contravariant.some((candidate) => this.c.relations.isAssignable(covariantType, candidate))
    )
      return this.commonSubtype(inference.contravariant);
    return covariantType;
  }

  /** Each candidate in turn replaces the one kept so far if it is assignable to it, as TypeScript's `getCommonSubtype`. */
  private commonSubtype(candidates: Type[]): Type {
    let subtype = candidates[0];
    for (const candidate of candidates.slice(1)) if (this.isSubtype(candidate, subtype)) subtype = candidate;
    return subtype;
  }

  /**
   * Assignability, except that `any` is a subtype only of `any`, so an `any` candidate wins over the others, `unknown`
   * included, in whatever order they come, as TypeScript infers.
   */
  private isSubtype(source: Type, target: Type): boolean {
    if (isAnyLike(source)) return isAnyLike(target);
    return this.c.relations.isAssignable(source, target);
  }

  private commonSupertype(candidates: Type[]): Type {
    const nullable = candidates.filter(
      (candidate) => isIntrinsic(candidate, 'null') || isIntrinsic(candidate, 'undefined')
    );
    const defined = candidates.filter((candidate) => !nullable.includes(candidate));
    if (nullable.length > 0 && defined.length > 0) return unionOf([this.commonSupertype(defined), ...nullable]);
    if (
      candidates.every(
        (candidate) => this.c.literals.isWrittenObjectLiteral(candidate) || this.c.literals.isArrayLiteral(candidate)
      )
    )
      return this.widenObjectLiterals(unionOf(candidates));
    const supertype = candidates.find((candidate) => candidates.every((other) => this.isSubtype(other, candidate)));
    if (supertype) return this.widenObjectLiterals(supertype);
    // Literals of one primitive unite, as `1` and `2` give `1 | 2` (or `number` when widened).
    const members = candidates.flatMap(typeMembers);
    if (
      members.every(
        (candidate) =>
          candidate.kind === 'literal' || isIntrinsic(candidate, 'undefined') || isIntrinsic(candidate, 'null')
      )
    ) {
      const kinds = new Set(
        members
          .filter((candidate) => candidate.kind === 'literal')
          .map((candidate) => typeof (candidate as { value: unknown }).value)
      );
      if (kinds.size <= 1) return unionOf(candidates);
    }
    return this.widenObjectLiterals(candidates[0]);
  }

  private widenObjectLiterals(type: Type): Type {
    return this.c.literals.widenDeclared(type, true);
  }

  /** Collects the types `source` gives the type parameters that `target` mentions. */
  inferTypes(run: InferenceRun, source: Type, target: Type, covariant: boolean): void {
    this.inferPair(run, source, target, covariant, {
      active: new Set(),
      argumentDepth: 0,
      originalTarget: target,
      sources: [],
      targets: [],
    });
  }

  inferArgument(run: InferenceRun, source: Type, target: Type): void {
    if (!this.inferHigherOrderCallback(run, source, target)) this.inferTypes(run, source, target, true);
  }

  withInferredCallbackParameters(run: InferenceRun, outer: Signature): Signature {
    const parameters = run.higherOrder?.parameters;
    if (!parameters?.length) return outer;
    const result = this.singleFunctionSignature(outer.returnType());
    if (!result) return outer;
    const signature = { ...result.signature, typeParameters: parameters };
    const returned =
      result.kind === 'call'
        ? functionType(signature)
        : anonymousObject(() => ({ ...emptyStructure(), constructSignatures: [signature] }), { isFunction: true });
    return { ...outer, returnType: () => returned };
  }

  private inferHigherOrderCallback(run: InferenceRun, source: Type, target: Type): boolean {
    const state = run.higherOrder;
    if (!state || [...run.inferences.values()].every(hasCandidates)) return false;
    const callback = this.singleFunctionSignature(source, true);
    if (!callback?.signature.typeParameters.length) return false;
    const expected = this.singleFunctionSignature(this.c.relations.removeNullish(target));
    if (!expected || expected.kind !== callback.kind || expected.signature.typeParameters.length > 0) return false;
    const result = this.singleFunctionSignature(state.outer.returnType());
    if (!result || result.signature.typeParameters.length > 0) return false;
    const sourceSignature = this.renameCallbackParameters(callback.signature, state.parameters);
    const candidate = newInferenceRun(run.parameters, run.contextualSignatures);
    const infer: Recurse = (from, to, position) =>
      this.inferTypes({ ...candidate, bivariant: position === 'bivariantParameter' }, from, to, !position);
    this.inferSignatureParameters(sourceSignature, expected.signature, infer);
    if (![...candidate.inferences.values()].some(hasCandidates)) return false;
    this.inferSignatureReturns(sourceSignature, expected.signature, infer);
    const adopted = [...candidate.inferences].filter(([, inference]) => hasCandidates(inference));
    if (adopted.some(([id]) => hasCandidates(run.inferences.get(id)))) return false;
    for (const [id, inference] of adopted)
      run.inferences.set(id, { ...inference, impliedArity: run.inferences.get(id)?.impliedArity });
    state.parameters.push(...sourceSignature.typeParameters);
    return true;
  }

  private singleFunctionSignature(
    type: Type,
    allowMembers = false
  ): { kind: 'call' | 'construct'; signature: Signature } | undefined {
    if (type.kind !== 'object') return undefined;
    const structure = this.c.structureOf(type);
    if (!allowMembers && (structure.properties.size > 0 || hasIndexSignature(structure))) return undefined;
    const { callSignatures: calls, constructSignatures: constructors } = structure;
    if (calls.length === 1 && constructors.length === 0) return { kind: 'call', signature: calls[0] };
    if (constructors.length === 1 && calls.length === 0) return { kind: 'construct', signature: constructors[0] };
    return undefined;
  }

  private renameCallbackParameters(signature: Signature, previous: TypeParameter[]): Signature {
    const names = new Set(previous.map((parameter) => parameter.name));
    const mapper: Mapper = new Map();
    const parameters = signature.typeParameters.map((parameter): TypeParameter => {
      let name = parameter.name;
      for (let suffix = 1; names.has(name); suffix++) name = `${parameter.name}${suffix}`;
      names.add(name);
      const fresh = { ...parameter, id: newTypeId(), name };
      mapper.set(parameter.id, fresh);
      return fresh;
    });
    for (const parameter of parameters) {
      const constraint = parameter.constraint;
      const defaultType = parameter.default;
      parameter.constraint = constraint && (() => this.instantiateParameterBound(constraint(), mapper));
      parameter.default = defaultType && (() => this.instantiateParameterBound(defaultType(), mapper));
    }
    return { ...this.c.instantiateSignature(signature, mapper), typeParameters: parameters };
  }

  private instantiateParameterBound(type: Type | undefined, mapper: Mapper): Type | undefined {
    return type && this.c.instantiate(type, mapper);
  }

  private inferPair(run: InferenceRun, source: Type, target: Type, covariant: boolean, path: InferencePath): void {
    const { active } = path;
    this.c.budget.spend();
    if (
      source === silentNeverType ||
      isNonInferrableParameter(source) ||
      target.noInfer ||
      !couldContainTypeVariables(target)
    )
      return;
    const variable = inferenceVariable(target, run);
    if (variable) {
      this.inferToParameter(run, source, variable, covariant, path);
      return;
    }
    const key = `${source.id}/${target.id}/${run.priority}/${covariant}/${run.bivariant ?? false}`;
    if (active.has(key)) return;
    if (this.depth >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    active.add(key);
    this.depth++;
    try {
      const recurse: Recurse = (s, t, position, priority = run.priority, reportInference = run.reportInference) => {
        const bivariant = run.bivariant || position === 'bivariantParameter';
        this.inferPair({ ...run, priority, reportInference, bivariant }, s, t, position ? !covariant : covariant, path);
      };
      this.inferDeeper(run, source, target, path, recurse, covariant);
    } finally {
      this.depth--;
      active.delete(key);
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Dispatches each target form to its inference rules.
  private inferDeeper(
    run: InferenceRun,
    source: Type,
    target: Type,
    path: InferencePath,
    recurse: Recurse,
    covariant: boolean
  ): void {
    if (isAnyLike(source) && path.active.size > 1) {
      // `any` infers `any` for every parameter the target mentions.
      for (const parameter of run.parameters) {
        if (this.mentions(target, parameter, run)) recurse(source, parameter);
      }
      return;
    }
    if (target.kind === 'union') {
      this.inferToUnion(run, source, target, recurse);
      return;
    }
    if (this.inferFromSubstitution(run, source, target, recurse)) return;
    if (target.kind === 'intersection') {
      for (const member of target.types) recurse(source, member);
      return;
    }
    if (target.kind === 'conditional') {
      this.inferToNestedConditional(run, source, target, path, recurse, covariant);
      return;
    }
    if (source.kind === 'union') {
      for (const member of source.types) recurse(member, target);
      return;
    }
    if (target.kind === 'templateLiteral') this.inferTemplateLiteral(source, target, recurse);
    if (source.kind === 'stringMapping' && target.kind === 'stringMapping' && source.mapping === target.mapping)
      recurse(source.type, target.type);
    if (target.kind === 'object') this.inferToObject(run, source, target, path, recurse);
  }

  private inferFromSubstitution(run: InferenceRun, source: Type, target: Type, recurse: Recurse): boolean {
    if (source.kind !== 'typeParameter' || !source.substitution) return false;
    const { base, constraint } = source.substitution;
    recurse(base, target);
    recurse(
      intersectionOf([base, constraint], this.c),
      target,
      undefined,
      run.priority | InferencePriority.SubstituteSource
    );
    return true;
  }

  /** A recursive conditional alias, as `Awaited<T>` is, makes a new conditional type each time it unfolds. */
  private inferToNestedConditional(
    run: InferenceRun,
    source: Type,
    target: ConditionalType,
    path: InferencePath,
    recurse: Recurse,
    covariant: boolean
  ): void {
    path.targets.push(target);
    try {
      if (!this.c.relations.isDeeplyNested(target, path.targets))
        this.inferToConditional(run, source, target, recurse, covariant);
    } finally {
      path.targets.pop();
    }
  }

  private inferToConditional(
    run: InferenceRun,
    source: Type,
    target: ConditionalType,
    recurse: Recurse,
    covariant: boolean
  ): void {
    if (source.kind === 'conditional') {
      recurse(source.checkType, target.checkType);
      recurse(source.extendsType, target.extendsType);
      recurse(this.c.conditionalTrueType(source), target.trueType);
      recurse(source.falseType, target.falseType);
      return;
    }
    const priority = covariant ? run.priority : run.priority | InferencePriority.ContravariantConditional;
    const branches = [target.trueType, target.falseType];
    const variables = branches.filter((branch) => {
      const variable = inferenceVariable(branch, run);
      return variable && run.inferences.has(variable.id);
    });
    for (const branch of branches) if (!variables.includes(branch)) recurse(source, branch, undefined, priority);
    for (const variable of variables)
      recurse(source, variable, undefined, priority | InferencePriority.NakedTypeVariable);
  }

  private inferTemplateLiteral(source: Type, target: TemplateLiteralType, recurse: Recurse): void {
    const match = this.templateInferenceCaptures(source, target);
    // An unmatched all-hole template must not collapse to the holes' broad string constraints.
    if (!match && target.texts.some(Boolean)) return;
    for (const [index, type] of target.types.entries()) {
      const candidate = match ? this.templateCandidate(match.parts[index], type, match.aligned) : neverType;
      recurse(candidate, type);
    }
  }

  private templateInferenceCaptures(
    source: Type,
    target: TemplateLiteralType
  ): { parts: Type[]; aligned: boolean } | undefined {
    const sourceParts =
      source.kind === 'literal' && typeof source.value === 'string'
        ? { texts: [source.value], types: [] }
        : source.kind === 'templateLiteral'
          ? source
          : undefined;
    if (!sourceParts) return undefined;
    const { budget, typeOperators } = this.c;
    const textLength = sourceParts.texts.reduce((length, text) => length + text.length, 0);
    budget.spend((textLength + sourceParts.types.length) * target.types.length);
    const aligned =
      sourceParts.texts.length === target.texts.length &&
      sourceParts.texts.every((text, index) => text === target.texts[index]);
    const parts = aligned
      ? sourceParts.types
      : templateParts(sourceParts, target, (texts, types) => typeOperators.templateLiteral(texts, types));
    return parts && { parts, aligned };
  }

  private templateCandidate(capture: Type, placeholder: Type, aligned: boolean): Type {
    if (capture.kind === 'literal' && typeof capture.value === 'string')
      return this.templateCapture(capture.value, this.c.baseConstraint(placeholder));
    if (
      !aligned ||
      isAnyLike(capture) ||
      isTemplateOrStringMapping(capture) ||
      isIntrinsic(capture, 'string') ||
      this.c.relations.isAssignable(this.c.baseConstraint(capture), this.c.baseConstraint(placeholder))
    )
      return capture;
    return this.c.typeOperators.templateLiteral(['', ''], [capture]);
  }

  private inferToParameter(
    run: InferenceRun,
    source: Type,
    target: TypeParameter,
    covariant: boolean,
    path: InferencePath
  ): void {
    const inference = run.inferences.get(target.id);
    if (!inference || this.containsNonInferrable(source)) return;
    run.reportInference?.(run.priority);
    if (inference.fixed || inference.isFixed || run.priority > inference.priority) return;
    if (run.priority < inference.priority) {
      inference.candidates.length = 0;
      inference.candidateDepths.clear();
      inference.contravariant.length = 0;
      inference.topLevel = true;
      inference.priority = run.priority;
    }
    if (covariant || run.bivariant) this.recordCovariantCandidate(inference, source, path.argumentDepth);
    else if (!inference.contravariant.some((candidate) => candidate.id === source.id))
      inference.contravariant.push(source);
    if ((run.priority & InferencePriority.ReturnType) === 0 && !isTopLevelTypeParameter(path.originalTarget, target))
      inference.topLevel = false;
  }

  private containsNonInferrable(type: Type): boolean {
    if (this.nonInferrableParameters.size === 0 || !couldContainTypeVariables(type)) return false;
    const pending = [type];
    const seen = new Set<Type>();
    for (let current = pending.pop(); current; current = pending.pop()) {
      this.c.budget.spend();
      if (seen.has(current)) continue;
      if (isNonInferrableParameter(current)) return true;
      seen.add(current);
      for (const child of nonInferrableChildren(current)) pending.push(child);
    }
    return false;
  }

  private recordCovariantCandidate(inference: Inference, source: Type, depth: number): void {
    const previous = inference.candidateDepths.get(source.id);
    if (previous !== undefined) {
      if (previous >= depth) return;
      const index = inference.candidates.findIndex((candidate) => candidate.id === source.id);
      inference.candidates.splice(index, 1);
    }
    inference.candidateDepths.set(source.id, depth);
    inference.candidates.push(source);
  }

  private templateCapture(text: string, constraint: Type): Type {
    const literal = literalType(text);
    if (this.c.relations.isAssignable(literal, constraint)) return literal;
    const primitive = this.primitiveTemplateCapture(text, constraint);
    return primitive ?? literal;
  }

  private primitiveTemplateCapture(text: string, constraint: Type): Type | undefined {
    const { relations } = this.c;
    const number = Number(text);
    // Only a numeric spelling that round-trips through the primitive can represent a literal type.
    if (Number.isFinite(number) && String(number) === text) {
      const candidate = literalType(number);
      if (relations.isAssignable(candidate, constraint)) return candidate;
    }
    const hasBigint = typeMembers(constraint).some(
      (member) => isIntrinsic(member, 'bigint') || (member.kind === 'literal' && typeof member.value === 'bigint')
    );
    if (hasBigint && /^(?:0|-?[1-9]\d*)$/.test(text)) {
      const candidate = literalType(BigInt(text));
      if (relations.isAssignable(candidate, constraint)) return candidate;
    }
    const candidate = templatePrimitiveWord(text);
    return candidate && relations.isAssignable(candidate, constraint) ? candidate : undefined;
  }

  private inferToUnion(run: InferenceRun, source: Type, target: UnionType, recurse: Recurse): void {
    const original = typeMembers(source);
    const exact = inferFromMatchingMembers(original, target.types, recurse, (member, other) =>
      this.isTypeOrBaseIdentical(member, other)
    );
    const { sourceMembers, targetMembers } = inferFromMatchingMembers(
      exact.sourceMembers,
      exact.targetMembers,
      recurse,
      instantiatesSameType
    );
    if (targetMembers.length === 0) return;
    const fallback = run.priority | InferencePriority.NakedTypeVariable;
    if (sourceMembers.length === 0) {
      recurse(source, unionOf(targetMembers, true), undefined, fallback);
      return;
    }
    const remaining = sourceMembers.length === original.length ? source : unionOf(sourceMembers, true);
    if (targetMembers.length === 1) {
      recurse(remaining, targetMembers[0]);
      return;
    }
    if (remaining.kind === 'typeParameter' && remaining.substitution) {
      this.inferFromSubstitution(run, remaining, unionOf(targetMembers, true), recurse);
      return;
    }
    const naked = targetMembers.filter((member) => {
      const variable = inferenceVariable(member, run);
      return variable && run.inferences.has(variable.id);
    });
    const structured = targetMembers.filter((member) => !naked.includes(member));
    const matched = this.inferStructuredUnionMembers(run, sourceMembers, structured, recurse);
    const unmatched = sourceMembers.filter((member) => !matched.has(member));
    if (naked.length === 1 && unmatched.length > 0) {
      recurse(unionOf(unmatched, true), naked[0]);
      return;
    }
    for (const variable of naked) recurse(remaining, variable, undefined, fallback);
  }

  private isTypeOrBaseIdentical(source: Type, target: Type): boolean {
    return (
      this.c.relations.identical(regularOf(source), regularOf(target)) ||
      (source.kind === 'literal' &&
        ((typeof source.value === 'string' && isIntrinsic(target, 'string')) ||
          (typeof source.value === 'number' && isIntrinsic(target, 'number'))))
    );
  }

  private inferStructuredUnionMembers(
    run: InferenceRun,
    sources: Type[],
    targets: Type[],
    recurse: Recurse
  ): Set<Type> {
    const matched = new Set<Type>();
    for (const target of targets) {
      for (const source of sources) {
        recurse(source, target, undefined, undefined, (priority) => {
          run.reportInference?.(priority);
          if (priority === run.priority) matched.add(source);
        });
      }
    }
    return matched;
  }

  private inferToObject(
    run: InferenceRun,
    source: Type,
    target: ObjectType,
    path: InferencePath,
    recurse: Recurse
  ): void {
    if (this.c.isLibraryType(target, 'ArrayLike')) source = this.c.apparentType(source);
    // An iterable target infers its element from what iterating the source gives, as a string's characters.
    if (
      target.objectKind === 'reference' &&
      ['Iterable', 'IterableIterator'].some((name) => this.c.isLibraryType(target, name)) &&
      !(source.kind === 'object' && source.objectKind === 'reference' && source.target === target.target)
    ) {
      const element = this.c.silently(() => this.c.patterns.iteratedType(undefined, source));
      if (element !== errorType) recurse(element, target.typeArguments?.[0] ?? unknownType);
      return;
    }
    if (source.kind !== 'object' && source.kind !== 'intersection') {
      this.inferFromNonObject(source, target, recurse);
      return;
    }
    if (target.objectKind === 'mapped' && target.mapped) {
      this.inferToMapped(run, source, target.mapped, recurse);
      return;
    }
    if (source.kind === 'object' && this.inferFromElements(run, source, target, path, recurse)) return;
    if (this.structuresDefinitelyUnrelated(source, target)) return;
    const { sources, targets } = path;
    sources.push(source);
    targets.push(target);
    try {
      const relations = this.c.relations;
      if (relations.isDeeplyNested(source, sources, 2) && relations.isDeeplyNested(target, targets, 2)) return;
      this.inferFromMembers(run, source, target, recurse);
    } finally {
      sources.pop();
      targets.pop();
    }
  }

  private inferToMapped(run: InferenceRun, source: Type, info: MappedInfo, recurse: Recurse): void {
    if (info.nameType) return;
    if (info.constraint.kind !== 'keyof')
      recurse(
        this.c.typeOperators.keyofType(source),
        info.constraint,
        undefined,
        InferencePriority.MappedTypeConstraint
      );
    if (this.inferMappedSource(run, source, info, recurse)) return;
    const entries = this.mappedInferenceEntries(source, this.c.baseConstraint(info.constraint));
    if (!this.mentions(info.template, info.typeParameter, run)) {
      if (entries.length > 0) recurse(unionOf(entries.map((entry) => entry.type)), info.template);
      return;
    }
    for (const entry of entries)
      recurse(entry.type, this.c.instantiate(info.template, new Map([[info.typeParameter.id, entry.key]])));
  }

  private inferMappedSource(run: InferenceRun, source: Type, info: MappedInfo, recurse: Recurse): boolean {
    const constraint = info.constraint.kind === 'typeParameter' ? info.constraint.constraint?.() : info.constraint;
    if (constraint?.kind !== 'keyof') return false;
    const target = constraint.type;
    const inference = run.inferences.get(target.id);
    if (target.kind === 'typeParameter' && inference) {
      if (!inference.fixed) {
        const reversed = this.inferReverseMapping(source, info, target);
        if (reversed) recurse(reversed, target, undefined, InferencePriority.HomomorphicMappedType);
      }
      return true;
    }
    if (info.constraint.kind !== 'keyof' || info.template.kind !== 'indexedAccess') return false;
    recurse(source, target, undefined, InferencePriority.HomomorphicMappedType);
    return true;
  }

  private inferReverseMapping(input: Type, info: MappedInfo, source: TypeParameter): Type | undefined {
    const cache = new Map<Type, Type>();
    let template: Type | undefined;
    return reverseMappedType(this.c, input, info, (property) => {
      const cached = cache.get(property);
      if (cached) return cached;
      const value: TypeParameter = { kind: 'typeParameter', id: newTypeId(), name: source.name };
      const run = newInferenceRun([value]);
      run.reverseMapped = { source, key: info.typeParameter, value };
      template ??= info.optionalModifier === '+' ? unionOf([info.template, undefinedType]) : info.template;
      this.inferTypes(run, property, template, true);
      const inference = run.inferences.get(value.id);
      const type = inference && hasCandidates(inference) ? this.inferredType(value, inference, false) : unknownType;
      cache.set(property, type);
      return type;
    });
  }

  private mappedInferenceEntries(source: Type, allowed: Type): { key: Type; type: Type }[] {
    const structure = this.c.structureOf(source);
    const keys = allowed.kind === 'union' ? allowed.types : [allowed];
    const entries: { key: Type; type: Type }[] = [];
    for (const property of structure.properties.values()) {
      this.c.budget.spend();
      if (property.visibility !== 'public' || !keys.some((key) => isPropertyKeyOf(this.c, property, key))) continue;
      entries.push({ key: this.c.typeOperators.propertyKeyType(property), type: property.type() });
    }
    for (const index of keyedIndexes(structure)) {
      if (isIndexKeyOf(this.c, index.keyType, allowed)) entries.push({ key: index.keyType, type: index.type });
    }
    return entries;
  }

  /** Infers to an object from what a non-object source stands for, as TypeScript's `inferFromTypes` takes its apparent type. */
  private inferFromNonObject(source: Type, target: ObjectType, recurse: Recurse): void {
    if (['typeParameter', 'indexedAccess', 'keyof', 'conditional'].includes(source.kind)) {
      const constraint = this.c.baseConstraint(source);
      if (constraint !== source && !isIntrinsic(constraint, 'unknown')) recurse(constraint, target);
    } else if (source.kind === 'literal' || source.kind === 'intrinsic' || isTemplateOrStringMapping(source)) {
      const apparent = this.c.apparentType(source);
      if (apparent.kind === 'object' && target.objectKind !== 'reference') recurse(apparent, target);
    }
  }

  /** Infers from the type arguments or elements of related references, arrays, and tuples; whether it applied. */
  private inferFromElements(
    run: InferenceRun,
    source: ObjectType,
    target: ObjectType,
    path: InferencePath,
    recurse: Recurse
  ): boolean {
    if (source.aliasId !== undefined && source.aliasId === target.aliasId && target.aliasArguments?.length) {
      this.inferFromTypeArguments(source.aliasArguments ?? [], target.aliasArguments, path, recurse);
      return true;
    }
    if (this.hasMatchingReferenceTarget(source, target)) {
      this.inferFromTypeArguments(source.typeArguments ?? [], target.typeArguments ?? [], path, recurse);
      return true;
    }
    if (this.c.isArrayOrTuple(source) && target.objectKind === 'reference' && this.isArrayLike(target)) {
      recurse(this.c.elementTypeOf(source), (target.typeArguments ?? [])[0] ?? anyType);
      return true;
    }
    if (!target.tuple) return false;
    if (source.tuple) {
      if (!tupleTypesDefinitelyUnrelated(source, target))
        this.inferFromTupleElements(run, source.tuple, target.tuple, path, recurse);
      return true;
    }
    if (!this.c.isArrayOrTuple(source)) return false;
    if (!this.structuresDefinitelyUnrelated(source, target))
      this.inferFromOpenArray(this.c.elementTypeOf(source), target.tuple.elements, recurse);
    return true;
  }

  private hasMatchingReferenceTarget(source: ObjectType, target: ObjectType): boolean {
    if (source.objectKind !== 'reference' || target.objectKind !== 'reference') return false;
    return source.target === target.target || (this.c.isArrayOrTuple(source) && this.c.isArrayOrTuple(target));
  }

  private inferFromTypeArguments(source: Type[], target: Type[], path: InferencePath, recurse: Recurse): void {
    path.argumentDepth++;
    try {
      for (const [index, argument] of target.entries()) if (source[index]) recurse(source[index], argument);
    } finally {
      path.argumentDepth--;
    }
  }

  private structuresDefinitelyUnrelated(source: Type, target: Type): boolean {
    return this.hasUnmatchedProperty(source, target, true) && this.hasUnmatchedProperty(target, source, false);
  }

  private hasUnmatchedProperty(source: Type, target: Type, matchDiscriminants: boolean): boolean {
    for (const [name, expected] of this.c.structureOf(target).properties) {
      this.c.budget.spend();
      if (expected.optional) continue;
      const actual = this.c.propertyOf(source, name);
      if (!actual) return true;
      if (!matchDiscriminants) continue;
      const type = propertyAccessType(expected);
      if (!isUnit(type) || type === voidType) continue;
      const actualType = propertyAccessType(actual);
      if (!isAnyLike(actualType) && regularOf(actualType) !== regularOf(type)) return true;
    }
    return false;
  }

  private inferFromOpenArray(element: Type, targets: TupleElement[], recurse: Recurse): void {
    for (const target of targets) {
      if (target.rest && this.c.relations.isGenericRestType(target.type))
        recurse(this.c.arrayType(element), target.type);
      else recurse(element, target.rest ? this.c.restElementType(target.type) : tupleInferenceType(target));
    }
  }

  private inferFromTupleElements(
    run: InferenceRun,
    source: TupleInfo,
    target: TupleInfo,
    path: InferencePath,
    recurse: Recurse
  ): void {
    const sourceElements = source.elements;
    const targetElements = target.elements;
    if (
      sourceElements.length === targetElements.length &&
      sourceElements.every(
        (element, index) => this.tupleElementShape(element) === this.tupleElementShape(targetElements[index])
      )
    ) {
      const sourceTypes = sourceElements.map((element) => this.tupleTypeArgument(element));
      const targetTypes = targetElements.map((element) => this.tupleTypeArgument(element));
      if (
        source.readonly === target.readonly &&
        sourceElements.every(
          (element, index) =>
            element.optional === targetElements[index].optional && element.labelId === targetElements[index].labelId
        )
      )
        this.inferFromTypeArguments(sourceTypes, targetTypes, path, recurse);
      else for (const [index, element] of sourceTypes.entries()) recurse(element, targetTypes[index]);
      return;
    }
    const sourceStart = fixedStartLength(sourceElements);
    const targetStart = fixedStartLength(targetElements);
    const start = Math.min(sourceStart, targetStart);
    const end =
      targetStart === targetElements.length
        ? 0
        : Math.min(fixedEndLength(sourceElements), fixedEndLength(targetElements));
    for (let index = 0; index < start; index++)
      recurse(tupleInferenceType(sourceElements[index]), tupleInferenceType(targetElements[index]));
    this.inferFromTupleMiddle(
      run,
      sourceElements.slice(start, sourceElements.length - end),
      targetElements.slice(start, targetElements.length - end),
      targetElements.at(-1)?.optional ?? false,
      recurse
    );
    for (let offset = 1; offset <= end; offset++)
      recurse(
        tupleInferenceType(sourceElements[sourceElements.length - offset]),
        tupleInferenceType(targetElements[targetElements.length - offset])
      );
  }

  private tupleElementShape(element: TupleElement): 'fixed' | 'variadic' | 'rest' {
    if (!element.rest) return 'fixed';
    return this.c.relations.isGenericRestType(element.type) ? 'variadic' : 'rest';
  }

  private tupleTypeArgument(element: TupleElement): Type {
    return this.tupleElementShape(element) === 'rest'
      ? this.c.restElementType(element.type)
      : tupleInferenceType(element);
  }

  private inferFromTupleMiddle(
    run: InferenceRun,
    source: TupleElement[],
    target: TupleElement[],
    optionalTail: boolean,
    recurse: Recurse
  ): void {
    const [first] = target;
    if (!first) return;
    if (source.length === 1 && this.tupleElementShape(source[0]) === 'rest') {
      this.inferFromOpenArray(this.c.restElementType(source[0].type), target, recurse);
      return;
    }
    if (target.length === 2 && this.inferFromVariadicPair(run, source, first, target[1], recurse)) return;
    if (target.length !== 1 || !first.rest) return;
    const middle = this.c.tupleType(source);
    if (this.c.relations.isGenericRestType(first.type)) {
      const priority = optionalTail ? run.priority | InferencePriority.SpeculativeTuple : run.priority;
      recurse(middle, first.type, undefined, priority);
    } else if (source.length > 0) {
      recurse(this.c.restElementType(middle), this.c.restElementType(first.type));
    }
  }

  /** Infers `[...A, ...B]` by splitting the source where the arguments passed to `...args: A` end; whether it applied. */
  private inferFromVariadicPair(
    run: InferenceRun,
    sourceElements: TupleElement[],
    element: TupleElement,
    next: TupleElement | undefined,
    recurse: Recurse
  ): boolean {
    if (!element.rest || !next?.rest || element.type.kind !== 'typeParameter') return false;
    const arity = run.inferences.get(element.type.id)?.impliedArity;
    if (arity === undefined) return false;
    // A source rest element, as in `(...values: number[])`, takes any count on both sides of the split.
    const open = sourceElements.slice(0, arity).some((sourceElement) => sourceElement.rest);
    recurse(this.c.tupleType(open ? sourceElements : sourceElements.slice(0, arity)), element.type);
    recurse(this.c.tupleType(open ? sourceElements : sourceElements.slice(arity)), next.type);
    return true;
  }

  private inferFromMembers(run: InferenceRun, source: Type, target: ObjectType, recurse: Recurse): void {
    const targetStructure = target.resolve();
    const sourceStructure = this.c.structureOf(source);
    for (const [name, property] of targetStructure.properties) {
      const sourceProperty = sourceStructure.properties.get(name) ?? this.c.propertyOf(source, name);
      if (sourceProperty) recurse(propertyAccessType(sourceProperty), propertyAccessType(property));
    }
    const targetSignatures = targetStructure.callSignatures;
    const sourceSignatures = sourceStructure.callSignatures;
    if (targetSignatures.length > 0 && sourceSignatures.length > 0) {
      const sourceSignature = sourceSignatures.at(-1) as Signature;
      const targetSignature = targetSignatures.at(-1) as Signature;
      this.inferFromSignatures(run, sourceSignature, targetSignature, recurse);
    }
    const sourceConstruct = sourceStructure.constructSignatures;
    const targetConstruct = targetStructure.constructSignatures;
    if (sourceConstruct.length > 0 && targetConstruct.length > 0) {
      this.inferFromSignatures(run, sourceConstruct.at(-1) as Signature, targetConstruct.at(-1) as Signature, recurse);
    }
    this.inferFromIndexSignatures(source, sourceStructure, targetStructure, recurse);
  }

  /** Infers to each index signature of the target as TypeScript's `inferFromIndexTypes` does. */
  private inferFromIndexSignatures(
    source: Type,
    sourceStructure: Structure,
    targetStructure: Structure,
    recurse: Recurse
  ): void {
    const inferable = hasInferableIndex(source, sourceStructure);
    for (const targetIndex of keyedIndexes(targetStructure)) {
      const types = inferable ? this.typesUnderIndex(sourceStructure, targetIndex.keyType) : [];
      if (types.length > 0) recurse(unionOf(types), targetIndex.type);
      const sourceIndex = applicableIndex(this.c, sourceStructure, targetIndex.keyType);
      if (sourceIndex) recurse(sourceIndex.type, targetIndex.type);
    }
  }

  /** The types of the properties and index signatures of an object literal or type literal that an index for `keyType` covers. */
  private typesUnderIndex(structure: Structure, keyType: Type): Type[] {
    return [
      ...[...structure.properties.values()]
        .filter((property) => isPropertyKeyOf(this.c, property, keyType))
        .map((property) => (property.optional ? this.c.relations.removeUndefined(property.type()) : property.type())),
      ...keyedIndexes(structure)
        .filter((index) => isIndexKeyOf(this.c, index.keyType, keyType))
        .map((index) => index.type),
    ];
  }

  private inferFromSignatures(run: InferenceRun, generic: Signature, target: Signature, recurse: Recurse): void {
    const source = this.inferenceSignature(run, generic, target);
    this.inferSignatureParameters(source, target, recurse);
    this.inferSignatureReturns(source, target, recurse);
  }

  private inferSignatureParameters(source: Signature, target: Signature, recurse: Recurse): void {
    const position = hasBivariantParameters(target) ? 'bivariantParameter' : 'parameter';
    if (source.thisType && target.thisType) recurse(source.thisType, target.thisType, position);
    const restIndex = target.parameters.findIndex((parameter) => parameter.rest);
    const positional = restIndex === -1 ? target.parameters.length : restIndex;
    const count = source.parameters.at(-1)?.rest ? positional : Math.min(source.parameters.length, positional);
    const calls = this.c.expressions.calls;
    for (let index = 0; index < count; index++) {
      const from = calls.parameterTypeAt(source, index);
      const to = calls.parameterTypeAt(target, index);
      if (from && to) recurse(from, to, position);
    }
    if (restIndex !== -1) {
      recurse(this.signatureRestType(source, count), this.signatureRestType(target, restIndex), position);
    }
  }

  private signatureRestType(signature: Signature, start: number): Type {
    const parameters = signature.parameters;
    const last = parameters.at(-1);
    const lastIndex = parameters.length - 1;
    if (last?.rest && start >= lastIndex)
      return start === lastIndex ? last.type : this.c.arrayType(this.c.restElementType(last.type));
    return this.c.tupleType(
      parameters.slice(start).map(({ type, optional, rest, name }) => ({ type, optional, rest, name }))
    );
  }

  private inferSignatureReturns(source: Signature, target: Signature, recurse: Recurse): void {
    const targetReturn = target.returnType();
    if (!isIntrinsic(targetReturn, 'void')) recurse(source.returnType(), targetReturn);
    else if (isIntrinsic(source.returnType(), 'void')) recurse(voidType, targetReturn);
    if (source.predicate && target.predicate) recurse(source.predicate.type, target.predicate.type);
  }

  private inferenceSignature(run: InferenceRun, generic: Signature, target: Signature): Signature {
    return generic.typeParameters.length === 0
      ? generic
      : run.contextualSignatures || generic.predicate
        ? this.instantiateCallback(run, generic, target)
        : this.baseInferenceSignature(generic);
  }

  private baseInferenceSignature(signature: Signature): Signature {
    const parameters = signature.typeParameters;
    const bounds: Mapper = new Map(
      parameters.map((parameter) => [parameter.id, parameter.constraint?.() ?? unknownType])
    );
    const eraser: Mapper = new Map(parameters.map((parameter) => [parameter.id, anyType]));
    const mapper: Mapper = new Map();
    for (const [id, type] of bounds) {
      let bound = type;
      for (let index = 1; index < parameters.length; index++) bound = this.c.instantiate(bound, bounds);
      mapper.set(id, this.c.instantiate(bound, eraser));
    }
    return this.c.instantiateSignature({ ...signature, typeParameters: [] }, mapper);
  }

  private instantiateCallback(run: InferenceRun, generic: Signature, target: Signature): Signature {
    const fixes = (parameter: TypeParameter): boolean => {
      const inference = run.inferences.get(parameter.id);
      return (
        !!inference &&
        (inference.candidates.length > 0 || inference.contravariant.length > 0) &&
        target.parameters.some((item) => this.mentions(item.type, parameter))
      );
    };
    const mapper = this.partialMapper(run.parameters, run.inferences, fixes, fixes);
    const context = mapper ? this.c.instantiateSignature(target, mapper) : target;
    return this.instantiateToFit(generic, context, true);
  }

  private isArrayLike(type: ObjectType): boolean {
    return ['Array', 'ReadonlyArray', 'Iterable', 'ArrayLike', 'IterableIterator', 'Iterator'].some((name) =>
      this.c.isLibraryType(type, name)
    );
  }

  mentions(type: Type, parameter: TypeParameter, run?: InferenceRun): boolean {
    const pending = [type];
    const seen = new Set<Type>();
    for (let current = pending.pop(); current; current = pending.pop()) {
      this.c.budget.spend();
      if (current.noInfer || seen.has(current)) continue;
      if (inferenceVariable(current, run)?.id === parameter.id) return true;
      seen.add(current);
      for (const child of childTypes(current)) pending.push(child);
      if (current.kind === 'object' && !current.aliasMapper) {
        for (const member of objectMemberTypes(current)) pending.push(member);
      }
    }
    return false;
  }

  /** Infers the type parameters of `types` from `source` matched against `target`, as `infer U` does. */
  inferFromTypes(parameters: TypeParameter[], source: Type, target: Type, outer?: Mapper): Map<number, Type> {
    const run = newInferenceRun(parameters);
    this.inferTypes(run, source, target, true);
    const result = new Map<number, Type>();
    for (const parameter of parameters) {
      const inference = run.inferences.get(parameter.id) as Inference;
      if (inference.candidates.length > 0)
        result.set(parameter.id, unionOf(inference.candidates.map((candidate) => regularOf(candidate))));
      else if (inference.contravariant.length > 0)
        result.set(parameter.id, intersectionOf(inference.contravariant, this.c));
    }
    this.constrainInferences(parameters, result, outer);
    return result;
  }

  /** A generic signature instantiated against a concrete target. */
  instantiateToFit(source: Signature, target: Signature, contextual = false): Signature {
    const run = newInferenceRun(source.typeParameters, true);
    if (source.thisType && target.thisType) this.inferTypes(run, target.thisType, source.thisType, true);
    for (const [index, parameter] of source.parameters.entries()) {
      const targetType = this.inferenceParameterType(parameter, target, index, contextual);
      if (targetType) this.inferTypes(run, targetType, parameter.type, true);
    }
    if (!contextual) this.inferSignatureResult(run, source, target);
    const mapper = this.finalMapper(source, source.typeParameters, run.inferences);
    return { ...this.c.instantiateSignature(source, mapper), typeParameters: [] };
  }

  private inferSignatureResult(run: InferenceRun, source: Signature, target: Signature): void {
    const result = { ...run, priority: InferencePriority.ReturnType };
    if (source.predicate && target.predicate && source.predicate.index === target.predicate.index) {
      this.inferTypes(result, target.predicate.type, source.predicate.type, true);
      return;
    }
    const destination = target.returnType();
    if (!isIntrinsic(destination, 'void')) this.inferTypes(result, destination, source.returnType(), true);
  }

  private inferenceParameterType(
    parameter: Parameter,
    target: Signature,
    index: number,
    contextual: boolean
  ): Type | undefined {
    const last = target.parameters.at(-1);
    if (
      (contextual || !parameter.rest) &&
      last?.rest &&
      index >= target.parameters.length - 1 &&
      this.c.relations.isGenericRestType(last.type)
    )
      return undefined;
    const declared = target.parameters[index];
    const tail = target.parameters.slice(index);
    return parameter.rest
      ? tail.length === 1 && tail[0].rest
        ? tail[0].type
        : this.c.tupleType(tail.map(({ type, optional, rest }) => ({ type, optional, rest })))
      : declared && !declared.rest
        ? declared.type
        : this.c.expressions.calls.parameterTypeAt(target, index);
  }

  private constrainInferences(
    parameters: TypeParameter[],
    mapper: Mapper,
    outer?: Mapper,
    skip?: ReadonlySet<number>
  ): Set<number> {
    const clamped = new Set<number>();
    const context = this.completeInference(parameters, mapper, outer);
    for (const parameter of parameters) {
      if (skip?.has(parameter.id)) continue;
      const inferred = mapper.get(parameter.id);
      if (!inferred) continue;
      const constraint = parameter.constraint?.();
      if (!constraint) continue;
      const instantiated = this.c.instantiate(
        outer ? this.c.instantiate(constraint, outer) : constraint,
        createMapper(context)
      );
      if (this.c.relations.isAssignable(inferred, instantiated)) continue;
      mapper.set(parameter.id, instantiated);
      context.set(parameter.id, instantiated);
      clamped.add(parameter.id);
    }
    return clamped;
  }

  completeInference(parameters: TypeParameter[], mapper: Mapper, outer?: Mapper): Mapper {
    const context = new Map(parameters.map((parameter) => [parameter.id, mapper.get(parameter.id) ?? unknownType]));
    for (const parameter of parameters.toReversed()) {
      if (mapper.has(parameter.id)) continue;
      const constraint = parameter.constraint?.();
      if (!constraint) continue;
      context.set(
        parameter.id,
        this.c.instantiate(outer ? this.c.instantiate(constraint, outer) : constraint, createMapper(context))
      );
    }
    return context;
  }
}

function templatePrimitiveWord(text: string): Type | undefined {
  switch (text) {
    case 'true':
    case 'false': {
      return literalType(text === 'true');
    }
    case 'undefined': {
      return undefinedType;
    }
    case 'null': {
      return nullType;
    }
    default: {
      return undefined;
    }
  }
}

export function newInferenceRun(parameters: TypeParameter[], contextualSignatures = false): InferenceRun {
  return {
    inferences: new Map(
      parameters.map((parameter) => [
        parameter.id,
        {
          candidates: [],
          candidateDepths: new Map(),
          contravariant: [],
          priority: Number.POSITIVE_INFINITY,
          topLevel: false,
        },
      ])
    ),
    parameters,
    priority: InferencePriority.Direct,
    contextualSignatures,
  };
}

const silentNeverType: TypeParameter = {
  kind: 'typeParameter',
  id: newTypeId(),
  name: 'never',
  constraint: () => neverType,
};

const silentNeverToUnknown: Mapper = new Map([[silentNeverType.id, unknownType]]);

function hasCandidates(inference: Inference | undefined): boolean {
  return !!inference && (inference.candidates.length > 0 || inference.contravariant.length > 0);
}

function isNonInferrableParameter(type: Type): boolean {
  return type.kind === 'typeParameter' && type.isNonInferrable === true;
}

function nonInferrableChildren(type: Type): readonly Type[] {
  if (type.kind === 'conditional') {
    return [type.checkType, type.extendsType, ...(type.mapper?.values() ?? [])];
  }
  const children = childTypes(type);
  if (type.kind !== 'object') return children;
  const mapped =
    type.objectKind === 'mapped' && type.mapped
      ? [type.mapped.constraint, type.mapped.template, type.mapped.nameType, type.mapped.source].filter(
          (child): child is Type => child !== undefined
        )
      : [];
  return [...children, ...(type.aliasArguments ?? []), ...(type.mapper?.values() ?? []), ...mapped];
}

function inferenceVariable(type: Type, run?: InferenceRun): TypeParameter | undefined {
  if (type.kind === 'typeParameter') return type.substitution?.base ?? type;
  const reverse = run?.reverseMapped;
  return reverse &&
    type.kind === 'indexedAccess' &&
    type.objectType.id === reverse.source.id &&
    type.indexType.id === reverse.key.id
    ? reverse.value
    : undefined;
}

function inferenceCandidateBase(type: Type): number {
  return type.kind === 'typeParameter' ? (type.substitution?.base.id ?? type.id) : type.id;
}

function equivalentInferenceCandidates(inference: Inference): Type[] {
  if (!inference.candidates.some((type) => type.kind === 'typeParameter' && type.substitution))
    return inference.candidates;
  const byBase = new Map<number, Type>();
  const depth = (type: Type): number => inference.candidateDepths.get(type.id) ?? 0;
  for (const candidate of inference.candidates) {
    const base = inferenceCandidateBase(candidate);
    const previous = byBase.get(base);
    if (!previous || depth(candidate) <= depth(previous)) byBase.set(base, candidate);
  }
  return [...byBase.values()];
}

function isTopLevelTypeParameter(type: Type, parameter: TypeParameter, depth = 0): boolean {
  if (type.kind === 'typeParameter') return inferenceCandidateBase(type) === parameter.id;
  if (type.kind === 'union' || type.kind === 'intersection')
    return type.types.some((member) => isTopLevelTypeParameter(member, parameter, depth));
  return (
    depth < 3 &&
    type.kind === 'conditional' &&
    (isTopLevelTypeParameter(type.trueType, parameter, depth + 1) ||
      isTopLevelTypeParameter(type.falseType, parameter, depth + 1))
  );
}

function tupleInferenceType(element: TupleElement): Type {
  return element.optional ? unionOf([element.type, undefinedType]) : element.type;
}

function fixedStartLength(elements: TupleElement[]): number {
  const first = elements.findIndex((element) => element.rest);
  return first === -1 ? elements.length : first;
}

function fixedEndLength(elements: TupleElement[]): number {
  const last = elements.findLastIndex((element) => element.rest);
  return elements.length - last - 1;
}

/**
 * Pairs matching members before inferring from the union's remaining members.
 */
function inferFromMatchingMembers(
  sources: readonly Type[],
  targets: readonly Type[],
  recurse: Recurse,
  matches: (source: Type, target: Type) => boolean
): { sourceMembers: Type[]; targetMembers: Type[] } {
  const matchedSources = new Set<Type>();
  const matchedTargets = new Set<Type>();
  for (const target of targets) {
    for (const source of sources) {
      if (!matches(source, target)) continue;
      recurse(source, target);
      matchedSources.add(source);
      matchedTargets.add(target);
    }
  }
  return {
    sourceMembers: sources.filter((source) => !matchedSources.has(source)),
    targetMembers: targets.filter((target) => !matchedTargets.has(target)),
  };
}

function instantiatesSameType(source: Type, target: Type): boolean {
  if (source.kind !== 'object' || target.kind !== 'object') return false;
  if (source.objectKind === 'reference' && target.objectKind === 'reference') return source.target === target.target;
  return source.origin !== undefined && source.origin === target.origin;
}

/**
 * Whether inferring to an index signature may read `type`'s properties, as TypeScript's
 * `isObjectTypeWithInferableIndex` allows for an object literal or type literal but not a class or interface.
 */
function hasInferableIndex(type: Type, structure: Structure): boolean {
  return (
    type.kind === 'object' &&
    type.objectKind === 'anonymous' &&
    !type.classInfo &&
    structure.callSignatures.length === 0 &&
    structure.constructSignatures.length === 0
  );
}
