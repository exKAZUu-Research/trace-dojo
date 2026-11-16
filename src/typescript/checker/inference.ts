import type { Checker, Mapper } from './checker';
import {
  anyType,
  errorType,
  isAnyLike,
  isIntrinsic,
  type ObjectType,
  regularOf,
  type Signature,
  type Structure,
  type Type,
  type TypeParameter,
  unionOf,
  type UnionType,
  unknownType,
  voidType,
} from './types';

interface Inference {
  candidates: Type[];
  contravariant: Type[];
  /** Whether a candidate came from a position where the parameter is the whole type, not part of one. */
  topLevel: boolean;
}

/** The inferences for the type parameters of one call or comparison, which each inference step adds to. */
export interface InferenceRun {
  inferences: Map<number, Inference>;
  parameters: TypeParameter[];
  /** Whether a step only fills type parameters that nothing has inferred yet, as the contextual return type does. */
  lowPriority: boolean;
}

type Recurse = (source: Type, target: Type, covariant?: boolean) => void;

/** Infers type arguments from the types that are matched against the types their parameters appear in. */
export class TypeInference {
  constructor(private readonly c: Checker) {}

  /** The inferences so far as a mapper; with `fixing`, a parameter without one becomes its constraint or `unknown`. */
  partialMapper(parameters: TypeParameter[], inferences: Map<number, Inference>, fixing = false): Mapper | undefined {
    const mapper: Mapper = new Map();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id);
      if (inference && (inference.candidates.length > 0 || inference.contravariant.length > 0)) {
        mapper.set(parameter.id, this.inferredType(parameter, inference, false));
      } else if (fixing) {
        mapper.set(parameter.id, parameter.constraint?.() ?? unknownType);
      }
    }
    return mapper.size > 0 ? mapper : undefined;
  }

  finalMapper(signature: Signature, parameters: TypeParameter[], inferences: Map<number, Inference>): Mapper {
    const mapper: Mapper = new Map();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id) as Inference;
      let type: Type =
        inference.candidates.length > 0 || inference.contravariant.length > 0
          ? this.inferredType(parameter, inference, !this.isTopLevelInReturn(signature, parameter))
          : (parameter.default?.() ?? parameter.constraint?.() ?? unknownType);
      const constraint = parameter.constraint?.();
      if (constraint && !this.c.relations.isAssignable(type, this.c.instantiate(constraint, mapper))) {
        type = this.c.instantiate(constraint, mapper);
      }
      mapper.set(parameter.id, type);
    }
    return mapper;
  }

  private isTopLevelInReturn(signature: Signature, parameter: TypeParameter): boolean {
    const returnType = signature.returnType();
    return (returnType.kind === 'union' ? returnType.types : [returnType]).some(
      (member) => member.kind === 'typeParameter' && member.id === parameter.id
    );
  }

  private inferredType(parameter: TypeParameter, inference: Inference, widen: boolean): Type {
    if (inference.candidates.length === 0) {
      return inference.contravariant[0];
    }
    const constraint = parameter.constraint?.();
    const primitiveConstraint =
      constraint !== undefined &&
      (constraint.kind === 'union' ? constraint.types : [constraint]).some(
        (member) =>
          (member.kind === 'intrinsic' && ['string', 'number', 'bigint', 'boolean'].includes(member.name)) ||
          member.kind === 'literal'
      );
    const shouldWiden = widen && inference.topLevel && !primitiveConstraint;
    const candidates = inference.candidates.map((candidate) =>
      shouldWiden ? this.c.widenLiteral(candidate) : regularOf(candidate)
    );
    const supertype = candidates.find((candidate) =>
      candidates.every((other) => this.c.relations.isAssignable(other, candidate))
    );
    if (supertype) return this.widenObjectLiterals(supertype);
    // Literals of one primitive unite, as `1` and `2` give `1 | 2` (or `number` when widened).
    if (
      candidates.every(
        (candidate) =>
          candidate.kind === 'literal' || isIntrinsic(candidate, 'undefined') || isIntrinsic(candidate, 'null')
      )
    ) {
      const kinds = new Set(
        candidates
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
  // code-gauge-allow functionCognitiveComplexity 17 -- Follows TypeScript's order of inference for each kind of target.
  inferTypes(run: InferenceRun, source: Type, target: Type, covariant: boolean, depth = 0): void {
    if (depth > 8) return;
    const recurse: Recurse = (s, t, isCovariant = covariant) => this.inferTypes(run, s, t, isCovariant, depth + 1);
    if (target.kind === 'typeParameter') {
      this.inferToParameter(run, source, target, covariant, depth === 0);
      return;
    }
    if (isAnyLike(source) && depth > 0) {
      // `any` infers `any` for every parameter the target mentions.
      for (const parameter of run.parameters) {
        if (this.mentions(target, parameter)) recurse(source, parameter);
      }
      return;
    }
    if (target.kind === 'union') {
      this.inferToUnion(run, source, target, recurse);
      return;
    }
    if (target.kind === 'intersection') {
      for (const member of target.types) recurse(source, member);
      return;
    }
    if (source.kind === 'union') {
      for (const member of source.types) recurse(member, target);
      return;
    }
    if (target.kind === 'object') this.inferToObject(source, target, recurse);
  }

  private inferToParameter(
    run: InferenceRun,
    source: Type,
    target: TypeParameter,
    covariant: boolean,
    topLevel: boolean
  ): void {
    const inference = run.inferences.get(target.id);
    if (!inference || source === errorType || isIntrinsic(source, 'never')) return;
    if (run.lowPriority && inference.candidates.length > 0) return;
    if (!covariant) {
      inference.contravariant.push(source);
      return;
    }
    if (!inference.candidates.some((candidate) => candidate.id === source.id)) inference.candidates.push(source);
    if (topLevel) inference.topLevel = true;
  }

  private inferToUnion(run: InferenceRun, source: Type, target: UnionType, recurse: Recurse): void {
    const naked = target.types.filter((member) => member.kind === 'typeParameter' && run.inferences.has(member.id));
    const others = target.types.filter((member) => !naked.includes(member));
    const sourceMembers = source.kind === 'union' ? source.types : [source];
    const remaining = sourceMembers.filter(
      (member) =>
        !others.some((other) => !this.c.relations.isGeneric(other) && this.c.relations.isAssignable(member, other))
    );
    for (const other of others) {
      if (this.c.relations.isGeneric(other)) for (const member of sourceMembers) recurse(member, other);
    }
    if (naked.length === 1 && remaining.length > 0) recurse(unionOf(remaining, true), naked[0]);
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Follows TypeScript's order of inference for each kind of object target.
  private inferToObject(source: Type, target: ObjectType, recurse: Recurse): void {
    if (source.kind !== 'object' && source.kind !== 'intersection') {
      if (source.kind === 'literal' || source.kind === 'intrinsic') {
        const apparent = this.c.apparentType(source);
        if (apparent.kind === 'object' && target.objectKind !== 'reference') recurse(apparent, target);
      }
      return;
    }
    if (target.objectKind === 'mapped' && target.mapped) {
      const { constraint, template } = target.mapped;
      if (constraint.kind === 'keyof' && template.kind === 'indexedAccess') recurse(source, constraint.type);
      return;
    }
    if (source.kind === 'object' && this.inferFromElements(source, target, recurse)) return;
    this.inferFromMembers(source, target, recurse);
  }

  /** Infers from the type arguments or elements of related references, arrays, and tuples; whether it applied. */
  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of type whose elements inference matches.
  private inferFromElements(source: ObjectType, target: ObjectType, recurse: Recurse): boolean {
    if (source.objectKind === 'reference' && target.objectKind === 'reference' && source.target === target.target) {
      const sourceArguments = source.typeArguments ?? [];
      for (const [index, argument] of (target.typeArguments ?? []).entries()) {
        if (sourceArguments[index]) recurse(sourceArguments[index], argument);
      }
      return true;
    }
    if (this.c.isArrayOrTuple(source) && target.objectKind === 'reference' && this.isArrayLike(target)) {
      recurse(this.c.elementTypeOf(source), (target.typeArguments ?? [])[0] ?? anyType);
      return true;
    }
    if (source.objectKind !== 'tuple' || target.objectKind !== 'tuple') return false;
    const sourceElements = source.tuple?.elements ?? [];
    for (const [index, element] of (target.tuple?.elements ?? []).entries()) {
      if (element.rest) {
        recurse(this.c.tupleType(sourceElements.slice(index)), element.type);
        break;
      }
      if (sourceElements[index]) recurse(sourceElements[index].type, element.type);
    }
    return true;
  }

  private inferFromMembers(source: Type, target: ObjectType, recurse: Recurse): void {
    const targetStructure = target.resolve();
    const sourceStructure = this.c.structureOf(source);
    for (const [name, property] of targetStructure.properties) {
      const sourceProperty = sourceStructure.properties.get(name) ?? this.c.propertyOf(source, name);
      if (sourceProperty) recurse(sourceProperty.type(), property.type());
    }
    const targetSignatures = targetStructure.callSignatures;
    const sourceSignatures = sourceStructure.callSignatures;
    if (targetSignatures.length > 0 && sourceSignatures.length > 0) {
      const sourceSignature = sourceSignatures.at(-1) as Signature;
      const targetSignature = targetSignatures.at(-1) as Signature;
      this.inferFromSignatures(sourceSignature, targetSignature, recurse);
    }
    const sourceConstruct = sourceStructure.constructSignatures;
    const targetConstruct = targetStructure.constructSignatures;
    if (sourceConstruct.length > 0 && targetConstruct.length > 0) {
      this.inferFromSignatures(sourceConstruct.at(-1) as Signature, targetConstruct.at(-1) as Signature, recurse);
    }
    this.inferFromIndexSignatures(source, sourceStructure, targetStructure, recurse);
  }

  private inferFromIndexSignatures(
    source: Type,
    sourceStructure: Structure,
    targetStructure: Structure,
    recurse: Recurse
  ): void {
    if (targetStructure.stringIndex) {
      const sourceIndex =
        sourceStructure.stringIndex?.type ??
        (source.kind === 'object' && source.isLiteral
          ? unionOf([...sourceStructure.properties.values()].map((property) => property.type()))
          : undefined);
      if (sourceIndex) recurse(sourceIndex, targetStructure.stringIndex.type);
    }
    if (targetStructure.numberIndex) {
      const sourceIndex = sourceStructure.numberIndex?.type ?? sourceStructure.stringIndex?.type;
      if (sourceIndex) recurse(sourceIndex, targetStructure.numberIndex.type);
    }
  }

  private inferFromSignatures(source: Signature, target: Signature, recurse: Recurse): void {
    const count = Math.min(source.parameters.length, target.parameters.length);
    for (let index = 0; index < count; index++) {
      recurse(source.parameters[index].type, target.parameters[index].type, false);
    }
    const targetReturn = target.returnType();
    if (!isIntrinsic(targetReturn, 'void')) recurse(source.returnType(), targetReturn, true);
    else if (isIntrinsic(source.returnType(), 'void')) recurse(voidType, targetReturn, true);
    if (source.predicate && target.predicate) recurse(source.predicate.type, target.predicate.type, true);
  }

  private isArrayLike(type: ObjectType): boolean {
    return ['Array', 'ReadonlyArray', 'Iterable', 'ArrayLike', 'IterableIterator', 'Iterator'].includes(
      type.target?.name ?? ''
    );
  }

  private mentions(type: Type, parameter: TypeParameter): boolean {
    if (type.kind === 'typeParameter') return type.id === parameter.id;
    if (type.kind === 'union' || type.kind === 'intersection')
      return type.types.some((member) => this.mentions(member, parameter));
    if (type.kind === 'object' && type.objectKind === 'reference')
      return (type.typeArguments ?? []).some((argument) => this.mentions(argument, parameter));
    return false;
  }

  /** Infers the type parameters of `types` from `source` matched against `target`, as `infer U` does. */
  inferFromTypes(parameters: TypeParameter[], source: Type, target: Type): Map<number, Type> {
    const run = newInferenceRun(parameters);
    this.inferTypes(run, source, target, true);
    const result = new Map<number, Type>();
    for (const parameter of parameters) {
      const inference = run.inferences.get(parameter.id) as Inference;
      if (inference.candidates.length > 0)
        result.set(parameter.id, unionOf(inference.candidates.map((candidate) => regularOf(candidate))));
      else if (inference.contravariant.length > 0) result.set(parameter.id, inference.contravariant[0]);
    }
    return result;
  }

  /** A generic signature instantiated to compare with `target`, inferring from the target's parameters. */
  instantiateToFit(source: Signature, target: Signature): Signature {
    const run = newInferenceRun(source.typeParameters);
    const count = Math.min(source.parameters.length, target.parameters.length);
    for (let index = 0; index < count; index++) {
      this.inferTypes(run, target.parameters[index].type, source.parameters[index].type, true);
    }
    const mapper: Mapper = new Map();
    for (const parameter of source.typeParameters) {
      const inference = run.inferences.get(parameter.id) as Inference;
      mapper.set(
        parameter.id,
        inference.candidates.length > 0 ? unionOf(inference.candidates) : (parameter.constraint?.() ?? unknownType)
      );
    }
    return { ...this.c.instantiateSignature(source, mapper), typeParameters: [] };
  }
}

export function newInferenceRun(parameters: TypeParameter[]): InferenceRun {
  return {
    inferences: new Map(
      parameters.map((parameter) => [parameter.id, { candidates: [], contravariant: [], topLevel: false }])
    ),
    parameters,
    lowPriority: false,
  };
}
