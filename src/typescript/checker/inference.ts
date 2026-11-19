// code-gauge-allow-file fileNcss 433 -- Keeps generic candidate collection, constraint fitting and inference completion together.
import type { Checker, Mapper } from './checker';
import { childTypes, objectMemberTypes } from './genericTypes';
import { applicableIndex, isIndexKeyOf, isPropertyKeyOf, keyedIndexes } from './indexInfos';
import {
  anyType,
  errorType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  literalType,
  type ObjectType,
  type Parameter,
  regularOf,
  type Signature,
  type Structure,
  type TemplateLiteralType,
  type TupleElement,
  type Type,
  type TypeParameter,
  unionOf,
  type UnionType,
  unknownType,
  voidType,
} from './types';

/**
 * How indirectly a step infers, as TypeScript's `InferencePriority` flags: a candidate replaces those of a greater
 * priority and is ignored next to those of a smaller one.
 */
export const InferencePriority = {
  Direct: 0,
  /** Through a homomorphic mapped type, as `T` in `Partial<T>`. */
  HomomorphicMappedType: 8,
  MappedTypeConstraint: 32,
  /** From the type the call's result is expected to have. */
  ReturnType: 128,
} as const;

export interface Inference {
  candidates: Type[];
  contravariant: Type[];
  /** The priority of the candidates so far. */
  priority: number;
  /** Whether a candidate came from a position where the parameter is the whole type, not part of one. */
  topLevel: boolean;
  /** How many arguments a rest parameter typed by this parameter takes, as `A` in `...args: A` does. */
  impliedArity?: number;
  /** The type a callback's parameters fixed the parameter to, which later candidates no longer change. */
  fixed?: Type;
}

/** The inferences for the type parameters of one call or comparison, which each inference step adds to. */
export interface InferenceRun {
  inferences: Map<number, Inference>;
  parameters: TypeParameter[];
  priority: number;
  contextualSignatures: boolean;
}

type Recurse = (source: Type, target: Type, covariant?: boolean, priority?: number) => void;

/** Infers type arguments from the types that are matched against the types their parameters appear in. */
export class TypeInference {
  constructor(private readonly c: Checker) {}

  /**
   * The type arguments inferred so far, with each parameter `fixes` selects fixed to its constraint or `unknown` when
   * nothing was inferred for it; the others stay type parameters. A parameter `keepsFixed` selects keeps that type, as
   * TypeScript fixes a parameter once a callback's parameter types it.
   */
  partialMapper(
    parameters: TypeParameter[],
    inferences: Map<number, Inference>,
    fixes: (parameter: TypeParameter) => boolean = () => false,
    keepsFixed: (parameter: TypeParameter) => boolean = () => false
  ): Mapper | undefined {
    const mapper: Mapper = new Map();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id);
      const fixed = fixes(parameter);
      let type: Type | undefined;
      if (inference?.fixed) type = inference.fixed;
      else if (inference && (inference.candidates.length > 0 || inference.contravariant.length > 0))
        // A parameter fixed for a callback's parameters takes its widened type, as `0` gives `number`.
        type = this.inferredType(parameter, inference, fixed);
      else if (fixed) type = parameter.constraint?.() ?? unknownType;
      if (!type) continue;
      mapper.set(parameter.id, type);
      if (fixed && inference && keepsFixed(parameter)) inference.fixed = type;
    }
    return mapper.size > 0 ? mapper : undefined;
  }

  finalMapper(signature: Signature, parameters: TypeParameter[], inferences: Map<number, Inference>): Mapper {
    const mapper: Mapper = new Map();
    for (const parameter of parameters) {
      const inference = inferences.get(parameter.id) as Inference;
      mapper.set(
        parameter.id,
        inference.fixed ??
          (inference.candidates.length > 0 || inference.contravariant.length > 0
            ? this.inferredType(parameter, inference, !this.isTopLevelInReturn(signature, parameter))
            : this.c.instantiate(parameter.default?.() ?? parameter.constraint?.() ?? unknownType, mapper))
      );
    }
    this.constrainInferences(parameters, mapper);
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
      return this.commonSubtype(inference.contravariant);
    }
    const shouldWiden =
      widen && inference.topLevel && !parameter.isConst && !this.c.literals.hasPrimitiveConstraint(parameter);
    const candidates = inference.candidates.map((candidate) =>
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
        (candidate) => candidate.kind === 'object' && (candidate.isLiteral || this.c.literals.isArrayLiteral(candidate))
      )
    )
      return this.widenObjectLiterals(unionOf(candidates));
    const supertype = candidates.find((candidate) => candidates.every((other) => this.isSubtype(other, candidate)));
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
  // code-gauge-allow functionCognitiveComplexity 20 -- Infers through each target form, including literal strings matched against template placeholders.
  inferTypes(run: InferenceRun, source: Type, target: Type, covariant: boolean, depth = 0): void {
    if (depth > 8 || target.noInfer) return;
    const recurse: Recurse = (s, t, isCovariant = covariant, priority = run.priority) =>
      this.inferTypes({ ...run, priority }, s, t, isCovariant, depth + 1);
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
    if (target.kind === 'templateLiteral' && source.kind === 'literal' && typeof source.value === 'string')
      this.inferTemplateLiteral(source.value, target, recurse);
    if (target.kind === 'object') this.inferToObject(run, source, target, recurse);
  }

  private inferTemplateLiteral(value: string, target: TemplateLiteralType, recurse: Recurse): void {
    this.c.budget.spend(value.length * target.types.length);
    const captures = templateCaptures(value, target.texts);
    if (!captures) return;
    const { types } = target;
    for (const [index, type] of types.entries()) {
      const constraint = type.kind === 'typeParameter' ? type.constraint?.() : type;
      const text = captures[index];
      const candidate =
        constraint && isIntrinsic(constraint, 'number') && text.trim() !== '' && Number.isFinite(Number(text))
          ? literalType(Number(text))
          : literalType(text);
      recurse(candidate, type);
    }
  }

  private inferToParameter(
    run: InferenceRun,
    source: Type,
    target: TypeParameter,
    covariant: boolean,
    topLevel: boolean
  ): void {
    const inference = run.inferences.get(target.id);
    if (!inference || inference.fixed || isIntrinsic(source, 'never')) return;
    if (inference.candidates.length > 0 && run.priority > inference.priority) return;
    if (!covariant) {
      inference.contravariant.push(source);
      return;
    }
    if (inference.candidates.length > 0 && run.priority < inference.priority) inference.candidates.length = 0;
    inference.priority = run.priority;
    if (!inference.candidates.some((candidate) => candidate.id === source.id)) inference.candidates.push(source);
    if (topLevel) inference.topLevel = true;
  }

  private inferToUnion(run: InferenceRun, source: Type, target: UnionType, recurse: Recurse): void {
    const { sourceMembers, targetMembers } = inferFromMatchingMembers(
      source.kind === 'union' ? source.types : [source],
      target.types,
      recurse
    );
    if (sourceMembers.length === 0) return;
    const naked = targetMembers.filter((member) => member.kind === 'typeParameter' && run.inferences.has(member.id));
    const others = targetMembers.filter((member) => !naked.includes(member));
    const inferable = (other: Type): boolean => run.parameters.some((parameter) => this.mentions(other, parameter));
    const remaining = sourceMembers.filter(
      (member) => !others.some((other) => !inferable(other) && this.c.relations.isAssignable(member, other))
    );
    for (const other of others) {
      if (inferable(other)) for (const member of sourceMembers) recurse(member, other);
    }
    if (naked.length === 1 && remaining.length > 0) recurse(unionOf(remaining, true), naked[0]);
  }

  private inferToObject(run: InferenceRun, source: Type, target: ObjectType, recurse: Recurse): void {
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
      this.inferToMapped(source, target, recurse);
      return;
    }
    if (source.kind === 'object' && this.inferFromElements(run, source, target, recurse)) return;
    this.inferFromMembers(run, source, target, recurse);
  }

  private inferToMapped(source: Type, target: ObjectType, recurse: Recurse): void {
    const info = target.mapped;
    if (!info || info.nameType) return;
    if (info.constraint.kind === 'keyof' && info.template.kind === 'indexedAccess') {
      recurse(source, info.constraint.type, undefined, InferencePriority.HomomorphicMappedType);
      return;
    }
    const keys = this.c.typeOperators.keyofType(source);
    recurse(keys, info.constraint, undefined, InferencePriority.MappedTypeConstraint);
    const entries = this.mappedInferenceEntries(source, this.c.baseConstraint(info.constraint));
    if (!this.mentions(info.template, info.typeParameter)) {
      if (entries.length > 0) recurse(unionOf(entries.map((entry) => entry.type)), info.template);
      return;
    }
    for (const entry of entries)
      recurse(entry.type, this.c.instantiate(info.template, new Map([[info.typeParameter.id, entry.key]])));
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
    } else if (source.kind === 'literal' || source.kind === 'intrinsic') {
      const apparent = this.c.apparentType(source);
      if (apparent.kind === 'object' && target.objectKind !== 'reference') recurse(apparent, target);
    }
  }

  /** Infers from the type arguments or elements of related references, arrays, and tuples; whether it applied. */
  private inferFromElements(run: InferenceRun, source: ObjectType, target: ObjectType, recurse: Recurse): boolean {
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
    this.inferFromTupleElements(run, source.tuple?.elements ?? [], target.tuple?.elements ?? [], recurse);
    return true;
  }

  /**
   * Infers from the elements of a tuple as TypeScript matches them: those before the target's rest by position, those
   * after it from the end, and the source elements between to the rest.
   */
  private inferFromTupleElements(
    run: InferenceRun,
    sourceElements: TupleElement[],
    targetElements: TupleElement[],
    recurse: Recurse
  ): void {
    for (const [index, element] of targetElements.entries()) {
      if (this.inferFromVariadicPair(run, sourceElements.slice(index), element, targetElements[index + 1], recurse))
        break;
      if (element.rest) {
        this.inferFromRestAndEnd(sourceElements, targetElements, index, recurse);
        break;
      }
      if (sourceElements[index]) recurse(sourceElements[index].type, element.type);
    }
  }

  private inferFromRestAndEnd(
    sourceElements: TupleElement[],
    targetElements: TupleElement[],
    restIndex: number,
    recurse: Recurse
  ): void {
    const end = targetElements.slice(restIndex + 1);
    // As TypeScript does, the fixed elements ending both tuples pair up from the end, and the rest takes the middle.
    const endLength = Math.min(fixedEndLength(sourceElements), end.length);
    const middleEnd = sourceElements.length - endLength;
    if (end.some((element) => element.rest) || endLength < end.length || middleEnd < restIndex) {
      recurse(this.c.tupleType(sourceElements.slice(restIndex)), targetElements[restIndex].type);
      return;
    }
    for (const [offset, element] of end.slice(end.length - endLength).entries())
      recurse(sourceElements[middleEnd + offset].type, element.type);
    recurse(this.c.tupleType(sourceElements.slice(restIndex, middleEnd)), targetElements[restIndex].type);
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
      if (sourceProperty) recurse(sourceProperty.type(), property.type());
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

  // code-gauge-allow functionCognitiveComplexity 17 -- Infers callback this, parameters, rests, returns, and predicates, fitting generic guards to their target.
  private inferFromSignatures(run: InferenceRun, generic: Signature, target: Signature, recurse: Recurse): void {
    const source = this.inferenceSignature(run, generic, target);
    if (source.thisType && target.thisType) recurse(source.thisType, target.thisType, false);
    const restIndex = target.parameters.findIndex((parameter) => parameter.rest);
    const count = Math.min(source.parameters.length, restIndex === -1 ? target.parameters.length : restIndex);
    for (let index = 0; index < count; index++) {
      recurse(source.parameters[index].type, target.parameters[index].type, false);
    }
    // A rest parameter such as `(...args: infer P)` takes the source's remaining parameters as a tuple.
    if (restIndex !== -1) {
      const rest = source.parameters
        .slice(restIndex)
        .map((parameter) =>
          parameter.rest
            ? { type: parameter.type, optional: false, rest: true, name: parameter.name }
            : { type: parameter.type, optional: parameter.optional, rest: false, name: parameter.name }
        );
      const targetRest = target.parameters.slice(restIndex);
      recurse(
        this.c.tupleType(rest),
        targetRest.length === 1
          ? targetRest[0].type
          : this.c.tupleType(targetRest.map(({ type, optional, rest }) => ({ type, optional, rest }))),
        false
      );
    }
    const targetReturn = target.returnType();
    if (!isIntrinsic(targetReturn, 'void')) recurse(source.returnType(), targetReturn, true);
    else if (isIntrinsic(source.returnType(), 'void')) recurse(voidType, targetReturn, true);
    if (source.predicate && target.predicate) recurse(source.predicate.type, target.predicate.type, true);
  }

  private inferenceSignature(run: InferenceRun, generic: Signature, target: Signature): Signature {
    return generic.typeParameters.length === 0
      ? generic
      : run.contextualSignatures || generic.predicate
        ? this.instantiateCallback(run, generic, target)
        : this.c.instantiateSignature(
            { ...generic, typeParameters: [] },
            new Map(generic.typeParameters.map((parameter) => [parameter.id, parameter.constraint?.() ?? unknownType]))
          );
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

  mentions(type: Type, parameter: TypeParameter): boolean {
    const pending = [type];
    const seen = new Set<Type>();
    for (let current = pending.pop(); current; current = pending.pop()) {
      this.c.budget.spend();
      if (current.noInfer || seen.has(current)) continue;
      if (current.kind === 'typeParameter' && current.id === parameter.id) return true;
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
        result.set(parameter.id, intersectionOf(inference.contravariant, this.c.budget));
    }
    this.constrainInferences(parameters, result, outer);
    return result;
  }

  /** A generic signature instantiated to compare with `target`, inferring from the target's parameters. */
  instantiateToFit(source: Signature, target: Signature, contextual = false): Signature {
    const run = newInferenceRun(source.typeParameters, true);
    if (source.thisType && target.thisType) this.inferTypes(run, target.thisType, source.thisType, true);
    for (const [index, parameter] of source.parameters.entries()) {
      const targetType = this.inferenceParameterType(parameter, target, index, contextual);
      if (targetType) this.inferTypes(run, targetType, parameter.type, true);
    }
    const mapper: Mapper = new Map();
    for (const parameter of source.typeParameters) {
      const inference = run.inferences.get(parameter.id) as Inference;
      mapper.set(
        parameter.id,
        inference.candidates.length > 0 ? unionOf(inference.candidates) : (parameter.constraint?.() ?? unknownType)
      );
    }
    this.constrainInferences(source.typeParameters, mapper);
    return { ...this.c.instantiateSignature(source, mapper), typeParameters: [] };
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

  private constrainInferences(parameters: TypeParameter[], mapper: Mapper, outer?: Mapper): void {
    const context = this.completeInference(parameters, mapper, outer);
    for (const parameter of parameters) {
      const inferred = mapper.get(parameter.id);
      if (!inferred) continue;
      const constraint = parameter.constraint?.();
      if (!constraint) continue;
      const instantiated = this.c.instantiate(outer ? this.c.instantiate(constraint, outer) : constraint, context);
      if (this.c.relations.isAssignable(inferred, instantiated)) continue;
      mapper.set(parameter.id, instantiated);
      context.set(parameter.id, instantiated);
    }
  }

  completeInference(parameters: TypeParameter[], mapper: Mapper, outer?: Mapper): Mapper {
    const context = new Map(parameters.map((parameter) => [parameter.id, mapper.get(parameter.id) ?? unknownType]));
    for (const parameter of parameters.toReversed()) {
      if (mapper.has(parameter.id)) continue;
      const constraint = parameter.constraint?.();
      if (!constraint) continue;
      context.set(
        parameter.id,
        this.c.instantiate(outer ? this.c.instantiate(constraint, outer) : constraint, context)
      );
    }
    return context;
  }
}

export function newInferenceRun(parameters: TypeParameter[], contextualSignatures = false): InferenceRun {
  return {
    inferences: new Map(
      parameters.map((parameter) => [
        parameter.id,
        { candidates: [], contravariant: [], priority: InferencePriority.Direct, topLevel: false },
      ])
    ),
    parameters,
    priority: InferencePriority.Direct,
    contextualSignatures,
  };
}

function templateCaptures(value: string, texts: string[]): string[] | undefined {
  if (!value.startsWith(texts[0])) return undefined;
  let position = texts[0].length;
  const captures: string[] = [];
  for (let index = 0; index < texts.length - 1; index++) {
    const delimiter = texts[index + 1];
    const last = index === texts.length - 2;
    const end = last ? value.length - delimiter.length : delimiter ? value.indexOf(delimiter, position) : position + 1;
    if (end < position || end > value.length || !value.startsWith(delimiter, end)) return undefined;
    captures.push(value.slice(position, end));
    position = end + delimiter.length;
  }
  return position === value.length ? captures : undefined;
}

/** How many required elements end a tuple after its last rest or optional element. */
function fixedEndLength(elements: TupleElement[]): number {
  const last = elements.findLastIndex((element) => element.rest || element.optional);
  return elements.length - last - 1;
}

/**
 * Infers between the members of a source and a target union that instantiate the same generic type, as an
 * `IteratorYieldResult<X>` with an `IteratorYieldResult<T>`, and returns the members left unmatched, as TypeScript's
 * `inferFromMatchingTypes` does, so a member never infers to a differently shaped one.
 */
function inferFromMatchingMembers(
  sources: readonly Type[],
  targets: readonly Type[],
  recurse: Recurse
): { sourceMembers: Type[]; targetMembers: Type[] } {
  const matchedSources = new Set<Type>();
  const matchedTargets = new Set<Type>();
  for (const target of targets) {
    for (const source of sources) {
      if (!instantiatesSameType(source, target)) continue;
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
