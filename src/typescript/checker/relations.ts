// code-gauge-allow-file fileNcss 816 -- Decides assignability and comparability for every kind of type, as TypeScript's checker does in one place.
import { minimumArguments } from './callArity';
import type { Checker } from './checker';
import { isUnit } from './flow';
import {
  childTypes,
  conditionalBranch,
  isGenericObjectOrIndexType,
  mappedOptionality,
  typeParametersIn,
} from './genericTypes';
import {
  applicableIndex,
  hasIndexSignature,
  isIndexKeyOf,
  isPatternKey,
  isPropertyKeyOf,
  keyedIndexes,
} from './indexInfos';
import { isBigintTemplateText, isNumberTemplateText, templateParts } from './templateParts';
import { structurallyIdentical } from './typeIdentity';
import {
  anonymousObject,
  anyType,
  booleanType,
  type ConditionalType,
  errorType,
  filterType,
  type IndexedAccessType,
  intersectionOf,
  type IntersectionType,
  isAnyLike,
  isIntrinsic,
  isPrimitive,
  literalType,
  nonPrimitiveType,
  nullType,
  numberType,
  type ObjectType,
  permissiveAnyType,
  type Property,
  propertyAccessType,
  regularOf,
  type Signature,
  stringType,
  type Structure,
  type TemplateLiteralType,
  type TupleElement,
  type TupleInfo,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  type UnionType,
  unknownType,
  voidType,
} from './types';

type Relation = 'assignable' | 'comparable' | 'identical';
type SignatureMode = 'signature' | 'strictCallback' | 'bivariantCallback';

const MAX_RELATION_DEPTH = 100;
const EXPANDING_SOURCE = 1;
const EXPANDING_TARGET = 2;
const INTERSECTION_SOURCE = 1;
const INTERSECTION_TARGET = 2;
/** How many times a recursive type may recur in a comparison stack before TypeScript stops expanding it. */
const MAX_RECURSION_IDENTITY_COUNT = 3;

/** Whether one type is assignable to, or comparable with, another, as TypeScript decides it. */
export class Relations {
  /** Pairs assumed related while comparing their members, which recursive types revisit. */
  private readonly assumed = new Set<string>();
  /**
   * Pairs found related while others were assumed, in order, kept until the outermost comparison decides whether its
   * assumptions held, as TypeScript's `maybeKeys` are.
   */
  private readonly provisional: string[] = [];
  private readonly provisionalKeys = new Set<string>();
  private readonly cache = new Map<string, boolean>();
  /** The structured sources and targets being compared, outermost first. */
  private readonly sourceStack: Type[] = [];
  private readonly targetStack: Type[] = [];
  /** Which of the source and target stacks have expanded a recursive type too deeply, as `EXPANDING_*` flags. */
  private expanding = 0;

  constructor(private readonly c: Checker) {}

  isAssignable(source: Type, target: Type): boolean {
    if (source.kind === 'object' && (this.trivialRelation(source, target) === true || isIntrinsic(target, 'object')))
      return true;
    return this.isRelated(source, target, 'assignable');
  }

  /** Whether `===` may find two values of these types equal: one is comparable to the other. */
  isComparable(a: Type, b: Type): boolean {
    return this.isRelated(a, b, 'comparable') || this.isRelated(b, a, 'comparable');
  }

  /**
   * With `INTERSECTION_TARGET` in `state`, as for a member of an intersection target, skips the check of a weak target
   * type; with `INTERSECTION_SOURCE`, as for a member of an intersection source, infers no index signature.
   */
  isRelated(
    source: Type,
    target: Type,
    relation: Relation,
    state = 0,
    track = EXPANDING_SOURCE | EXPANDING_TARGET
  ): boolean {
    if (source === target) return true;
    if (relation === 'assignable' && source.kind === 'object' && isPrimitiveComparisonTarget(target)) return false;
    source = referencesForComparison(source);
    target = referencesForComparison(target);
    if (source === target) return true;
    this.c.budget.spend();
    const key = `${relation}-${state}:${source.id}:${target.id}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (this.assumed.has(key) || this.provisionalKeys.has(key)) return true;
    if (isLeaf(source) && isLeaf(target)) return this.structuredRelated(source, target, relation, state);
    // TypeScript gives up here with "Excessive stack depth comparing types" (TS2321).
    if (Math.max(this.sourceStack.length, this.targetStack.length) >= MAX_RELATION_DEPTH) return false;
    // An outermost comparison that an exception ended left its provisional pairs undecided.
    if (this.assumed.size === 0) this.dropProvisional(0);
    const start = this.provisional.length;
    this.assumed.add(key);
    let result: boolean;
    try {
      result = this.nestedRelated(source, target, relation, state, track);
    } finally {
      this.assumed.delete(key);
    }
    this.record(key, result, start);
    return result;
  }

  /** A failure holds whatever was assumed, but a success may rest on an assumption that has yet to fail. */
  private record(key: string, result: boolean, start: number): void {
    if (!result) {
      this.cache.set(key, false);
      this.dropProvisional(start);
    } else if (this.assumed.size === 0) {
      for (const provisional of this.provisional) this.cache.set(provisional, true);
      this.dropProvisional(0);
      this.cache.set(key, true);
    } else {
      this.provisional.push(key);
      this.provisionalKeys.add(key);
    }
  }

  private dropProvisional(start: number): void {
    for (const key of this.provisional.splice(start)) this.provisionalKeys.delete(key);
  }

  /** Compares structured types on the comparison stacks, as TypeScript's `recursiveTypeRelatedTo` does. */
  private nestedRelated(source: Type, target: Type, relation: Relation, state: number, track: number): boolean {
    const saved = this.expanding;
    const trackSource = (track & EXPANDING_SOURCE) !== 0;
    const trackTarget = (track & EXPANDING_TARGET) !== 0;
    if (trackSource) this.sourceStack.push(source);
    if (trackTarget) this.targetStack.push(target);
    try {
      if (trackSource && !(saved & EXPANDING_SOURCE) && this.isDeeplyNested(source, this.sourceStack))
        this.expanding |= EXPANDING_SOURCE;
      if (trackTarget && !(saved & EXPANDING_TARGET) && this.isDeeplyNested(target, this.targetStack))
        this.expanding |= EXPANDING_TARGET;
      // Both sides keep expanding the same recursive types, so TypeScript assumes the relation holds.
      return (
        this.expanding === (EXPANDING_SOURCE | EXPANDING_TARGET) ||
        this.structuredRelated(source, target, relation, state)
      );
    } finally {
      if (trackSource) this.sourceStack.pop();
      if (trackTarget) this.targetStack.pop();
      this.expanding = saved;
    }
  }

  /** Whether a stack ending in `type` has expanded its recursive type too often, as TypeScript's `isDeeplyNestedType` decides. */
  isDeeplyNested(type: Type, stack: Type[], limit = MAX_RECURSION_IDENTITY_COUNT): boolean {
    if (stack.length < limit || isLeaf(type)) return false;
    if (type.kind === 'intersection') return type.types.some((member) => this.isDeeplyNested(member, stack, limit));
    const identity = this.recursionIdentity(type);
    let count = 0;
    let lastId = 0;
    for (const member of stack) {
      if (!this.hasRecursionIdentity(member, identity)) continue;
      // Only a type created later than the previous match, as by an expanding instantiation, counts.
      if (member.id >= lastId && ++count >= limit) return true;
      lastId = member.id;
    }
    return false;
  }

  private hasRecursionIdentity(type: Type, identity: unknown): boolean {
    return type.kind === 'intersection'
      ? type.types.some((member) => this.hasRecursionIdentity(member, identity))
      : this.recursionIdentity(type) === identity;
  }

  /** An array literal is its own identity, so that nested literals such as `[[1]]` never count as a recursive type. */
  private recursionIdentity(type: Type): unknown {
    return this.c.literals.isArrayOrTupleLiteral(type) ? type : recursionIdentity(type);
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- Follows TypeScript's order of checks for each kind of type.
  // code-gauge-allow functionNcss 38 -- Follows TypeScript's order of checks for each kind of type.
  private structuredRelated(source: Type, target: Type, relation: Relation, state: number): boolean {
    const s = this.c.reducedTypes.of(regularOf(source));
    const t = this.c.reducedTypes.of(regularOf(target));
    if (relation === 'identical') return structurallyIdentical(this.c, s, t);
    const trivial = this.trivialRelation(s, t);
    if (trivial !== undefined) return trivial;
    if (s.kind === 'union') return this.unionSourceRelated(s, t, relation, state);
    if (!(state & INTERSECTION_TARGET) && this.lacksWeakTypeProperty(s, t, relation)) return false;
    if (t.kind === 'union') return this.relatedToUnion(s, t, relation);
    // TypeScript checks a weak intersection as a whole, so a member whose properties are all optional need not share one.
    if (t.kind === 'intersection')
      return t.types.every((member) => this.isRelated(s, member, relation, state | INTERSECTION_TARGET));
    if (this.relatedToGenericTarget(s, t, relation)) return true;
    if (t.kind === 'keyof' && this.relatedToKeyof(s, t.type, relation, state)) return true;
    if (s.kind === 'intersection') return this.intersectionSourceRelated(s, t, relation, state);
    if (s.kind === 'typeParameter')
      return (
        this.typeParameterRelated(s, t, relation) ||
        (t.kind === 'conditional' && this.relatedToConditional(s, t, relation, state))
      );
    if (s.kind === 'indexedAccess' || s.kind === 'keyof' || s.kind === 'conditional') {
      if (this.genericSourceRelated(s, t, relation)) return true;
      if (t.kind !== 'typeParameter' && t.kind !== 'conditional') return false;
    }
    if (t.kind === 'typeParameter') return relation === 'comparable' && this.constraintAdmits(s, t);
    if (t.kind === 'indexedAccess') return this.relatedToIndexedAccess(s, t, relation);
    if (t.kind === 'conditional') return this.relatedToConditional(s, t, relation, state);
    if (t.kind === 'keyof') return false;
    return this.relatedToConcrete(s, t, relation, state);
  }

  private intersectionSourceRelated(s: IntersectionType, t: Type, relation: Relation, state: number): boolean {
    if (s.types.some((member) => this.isRelated(member, t, relation, state | INTERSECTION_SOURCE))) return true;
    // An intersection with `null` or `undefined`, as `T & null`, has no members.
    if (s.types.some((member) => isIntrinsic(member, 'null') || isIntrinsic(member, 'undefined'))) return false;
    return t.kind === 'object' && this.objectRelated(s, t, relation, state);
  }

  private typeParameterRelated(s: TypeParameter, t: Type, relation: Relation): boolean {
    if ((t.kind === 'typeParameter' && s.id === t.id) || this.constraintRelated(s, t, relation)) return true;
    if (t.kind === 'object' && t.tuple && this.fitsVariadicTuple(s, t.tuple, relation)) return true;
    return t.kind === 'indexedAccess' && this.relatedToIndexedAccess(s, t, relation);
  }

  private fitsVariadicTuple(source: TypeParameter, target: TupleInfo, relation: Relation): boolean {
    const element = this.singleVariadicElement(target);
    if (!element) return false;
    const bound = this.c.baseConstraint(source);
    const mutable = this.c.isArrayType(bound) || (bound.kind === 'object' && bound.tuple?.readonly === false);
    return (target.readonly || mutable) && this.isRelated(source, element, relation);
  }

  private singleVariadicElement(tuple: TupleInfo | undefined): Type | undefined {
    const element = tuple?.elements.length === 1 ? tuple.elements[0] : undefined;
    return element?.rest && this.isGenericRestType(element.type) ? element.type : undefined;
  }

  private relatedToIndexedAccess(s: Type, t: IndexedAccessType, relation: Relation): boolean {
    if (t.indexType.kind === 'union')
      return t.indexType.types.every((key) =>
        this.isRelated(s, this.c.typeOperators.indexedAccess(t.objectType, key), relation, 0, EXPANDING_TARGET)
      );
    if (
      s.kind === 'indexedAccess' &&
      this.isRelated(s.objectType, t.objectType, relation) &&
      this.isRelated(s.indexType, t.indexType, relation)
    )
      return true;
    const mapped = this.c.typeOperators.mappedIndexConstraint(t);
    if (mapped && mapped !== t) return this.isRelated(s, mapped, relation, 0, EXPANDING_TARGET);
    if (s.kind === 'indexedAccess') {
      const mappedSource = this.c.typeOperators.mappedIndexConstraint(s);
      if (mappedSource && mappedSource !== s && this.isRelated(mappedSource, t, relation, 0, EXPANDING_SOURCE))
        return true;
    }
    return this.relatedToIndexedWritingConstraint(s, t, relation);
  }

  /**
   * Writing `o[k]` must suit the property, or the index signature, of every key the constraint of `k` allows in the
   * constraint of `o`. As in TypeScript, the constraint of `o` offers only its number index signature, since a type
   * argument may lack the others.
   */
  private relatedToIndexedWritingConstraint(s: Type, t: IndexedAccessType, relation: Relation): boolean {
    const object = this.constraintForWriting(t.objectType);
    const keys = this.constraintForWriting(t.indexType);
    if (isGenericObjectOrIndexType(object) || isGenericObjectOrIndexType(keys)) return false;
    const numberIndexOnly = object !== t.objectType;
    return (keys.kind === 'union' ? keys.types : [keys]).every((key) => {
      const tuple = this.c.typeOperators.variadicIndexConstraint(t, key);
      const writeType = tuple && tuple !== t ? tuple : this.writeTypeOf(object, key, numberIndexOnly);
      return writeType !== undefined && this.isRelated(s, writeType, relation, 0, EXPANDING_TARGET);
    });
  }

  /**
   * TypeScript's `getBaseConstraintOfType(type) || type`: the constraint of a type parameter followed through type
   * parameters, or the type parameter itself when it has none.
   */
  private constraintForWriting(type: Type): Type {
    let current = type;
    for (
      let constraint = this.constraintOfParameter(current);
      constraint;
      constraint = this.constraintOfParameter(current)
    )
      current = constraint;
    return current.kind === 'typeParameter' ? current : this.c.baseConstraint(current);
  }

  private constraintOfParameter(type: Type): Type | undefined {
    return type.kind === 'typeParameter' ? this.c.constraintOf(type) : undefined;
  }

  private writeTypeOf(object: Type, key: Type, numberIndexOnly: boolean): Type | undefined {
    const structure = this.c.structureOf(object);
    const { stringIndex, numberIndex } = structure;
    if (key.kind === 'literal') {
      const indexed = typeof key.value === 'number' && numberIndex !== undefined;
      if (numberIndexOnly && !indexed && !this.hasProperty(object, String(key.value))) return undefined;
      return this.c.typeOperators.indexedAccess(object, key);
    }
    if (isIntrinsic(key, 'number')) return (numberIndex ?? (numberIndexOnly ? undefined : stringIndex))?.type;
    if (numberIndexOnly) return undefined;
    if (isIntrinsic(key, 'string') || isIntrinsic(key, 'symbol') || isPatternKey(key))
      return applicableIndex(this.c, structure, key)?.type;
    return undefined;
  }

  private hasProperty(object: Type, name: string): boolean {
    return object.kind === 'union'
      ? object.types.every((member) => this.hasProperty(member, name))
      : this.c.propertyOf(object, name) !== undefined;
  }

  private genericSourceRelated(s: Type, t: Type, relation: Relation): boolean {
    if (t.kind === s.kind && this.sameGeneric(s, t)) return true;
    if (s.kind === 'indexedAccess' && t.kind === 'indexedAccess') return this.relatedToIndexedAccess(s, t, relation);
    if (s.kind === 'conditional' && t.kind === 'conditional' && this.conditionalsRelated(s, t, relation)) return true;
    // TypeScript tries a conditional type's branches before their constraints, so `Exclude<keyof T, K>` fits `keyof T`.
    if (s.kind === 'conditional' && this.isRelated(unionOf([s.trueType, s.falseType]), t, relation)) return true;
    const constraint = this.c.baseConstraint(s);
    return constraint !== s && this.isRelated(constraint, t, relation, 0, EXPANDING_SOURCE);
  }

  private relatedToKeyof(source: Type, object: Type, relation: Relation, state: number): boolean {
    if (source.kind === 'keyof' && this.isRelated(object, source.type, relation, state)) return true;
    const keys = this.c.typeOperators.guaranteedKeys(object);
    return !isIntrinsic(keys, 'never') && this.isRelated(source, keys, relation, state);
  }

  private relatedToConditional(source: Type, target: ConditionalType, relation: Relation, state: number): boolean {
    const root = target.root ?? target;
    const universal = isAnyLike(target.extendsType) || isIntrinsic(target.extendsType, 'unknown');
    if (universal && target.trueType === target.checkType && isIntrinsic(target.falseType, 'never'))
      return this.isRelated(source, target.trueType, relation, state);
    if (
      root.inferTypeParameters.length > 0 ||
      (source.kind === 'conditional' && (source.root ?? source) === root) ||
      this.branchesDependOnDistribution(root)
    )
      return false;
    const branch = conditionalBranch(this.c, target.checkType, target.extendsType);
    return (
      (branch === 'false' || this.isRelated(source, target.trueType, relation, state)) &&
      (branch === 'true' || this.isRelated(source, target.falseType, relation, state))
    );
  }

  private branchesDependOnDistribution(root: ConditionalType): boolean {
    if (!root.distributive) return false;
    const containsCheck = (type: Type): boolean =>
      typeParametersIn(type, [], this.c.budget).some((parameter) => parameter.id === root.checkType.id);
    return containsCheck(root.trueType) || containsCheck(root.falseType);
  }

  /**
   * As TypeScript relates two conditional types: their extends types are identical once the source's `infer` type
   * parameters are inferred from the target's, either check type is related to the other, and so are their branches.
   */
  private conditionalsRelated(s: ConditionalType, t: ConditionalType, relation: Relation): boolean {
    const mapper = this.c.inference.inferFromTypes(s.inferTypeParameters, t.extendsType, s.extendsType);
    return (
      this.identical(this.c.instantiate(s.extendsType, mapper), t.extendsType) &&
      (this.isRelated(s.checkType, t.checkType, relation) || this.isRelated(t.checkType, s.checkType, relation)) &&
      this.isRelated(this.c.instantiate(s.trueType, mapper), t.trueType, relation) &&
      this.isRelated(s.falseType, t.falseType, relation)
    );
  }

  private unionSourceRelated(s: UnionType, t: Type, relation: Relation, state: number): boolean {
    return relation === 'comparable'
      ? s.types.some((member) => this.isRelated(member, t, relation, state))
      : s.types.every((member) => this.isRelated(member, t, relation, state));
  }

  /** The relation that holds whatever the types' structures are, if any. */
  private trivialRelation(s: Type, t: Type): boolean | undefined {
    if (s === t || s === errorType || t === errorType || s === permissiveAnyType || t === permissiveAnyType)
      return true;
    if (isAnyLike(t) || isIntrinsic(t, 'unknown')) return true;
    if (isAnyLike(s)) return !isIntrinsic(t, 'never');
    if (isIntrinsic(s, 'never')) return true;
    if (t.kind === 'union' && this.isUnknownLikeUnion(t.types)) return true;
    return undefined;
  }

  private isUnknownLikeUnion(members: Type[]): boolean {
    if (members.length < 3 || !members.includes(undefinedType) || !members.includes(nullType)) return false;
    this.c.budget.spend(members.length);
    return members.some(
      (member) =>
        member.kind === 'object' &&
        member.objectKind === 'anonymous' &&
        !member.isResolvedMappedType &&
        this.hasNoMembers(member)
    );
  }

  private relatedToUnion(s: Type, t: UnionType, relation: Relation): boolean {
    // A type parameter is related to a union its constraint is related to as a whole.
    if (
      s.kind === 'typeParameter' &&
      (t.types.some((member) => member.kind === 'typeParameter' && member.id === s.id) ||
        this.constraintRelated(s, t, relation))
    )
      return true;
    if (t === booleanType && s.kind === 'literal' && typeof s.value === 'boolean') return true;
    if (t.types.some((member) => this.isRelated(s, member, relation))) return true;
    // Another generic type is related to a union its constraint is related to as a whole, as `keyof T` is to `PropertyKey`.
    if (s.kind === 'indexedAccess' || s.kind === 'keyof' || s.kind === 'conditional')
      return this.genericSourceRelated(s, t, relation);
    // An object can be assignable to a union of objects only as a whole, as a discriminated one is.
    return s.kind === 'object' && this.isRelatedToDiscriminatedUnion(s, t.types, relation);
  }

  private relatedToConcrete(s: Type, t: Type, relation: Relation, state: number): boolean {
    switch (t.kind) {
      case 'intrinsic': {
        return this.intrinsicTarget(s, t.name, relation);
      }
      case 'literal': {
        if (s.kind === 'literal') return s.value === t.value;
        return relation === 'comparable' && s.kind === 'intrinsic' && s.name === typeof t.value;
      }
      case 'templateLiteral':
      case 'stringMapping': {
        if (s.kind === 'literal' && typeof s.value === 'string') return this.matchesTemplate(s.value, t);
        if (s.kind === 'templateLiteral' && t.kind === 'templateLiteral')
          return this.sameGeneric(s, t) || this.templateMatchesTemplate(s, t, relation);
        if (s.kind === 'stringMapping' && t.kind === 'stringMapping' && s.mapping === t.mapping)
          return this.isRelated(s.type, t.type, relation);
        return relation === 'comparable' && isIntrinsic(s, 'string');
      }
      case 'object': {
        return this.relatedToObject(s, t, relation, state);
      }
      default: {
        return false;
      }
    }
  }

  private relatedToObject(s: Type, t: ObjectType, relation: Relation, state: number): boolean {
    if (s.kind === 'intrinsic') {
      if (['null', 'undefined', 'void', 'unknown'].includes(s.name)) return false;
      // `object` has the members of `Object`.
      if (s.name === 'object')
        return (
          this.isEmptyObjectType(t) ||
          isOptionalMappedType(t) ||
          this.objectRelated(this.c.globalType('Object'), t, relation)
        );
    }
    if (s.kind === 'literal' || s.kind === 'intrinsic' || s.kind === 'templateLiteral' || s.kind === 'stringMapping') {
      // A primitive has the members of its boxing interface.
      return this.isEmptyObjectType(t) || this.objectRelated(s, t, relation, state);
    }
    return s.kind === 'object' && this.objectRelated(s, t, relation, state);
  }

  /** TypeScript relates to a generic mapped type or a type parameter target before it turns to the source's constraint. */
  private relatedToGenericTarget(s: Type, t: Type, relation: Relation): boolean {
    if (t.kind === 'object') return this.relatedToHomomorphicMapped(s, t, relation);
    if (t.kind !== 'typeParameter' || s.kind !== 'object') return false;
    const element = s.tuple?.readonly === false ? this.singleVariadicElement(s.tuple) : undefined;
    return (
      (element !== undefined && this.isRelated(element, t, relation)) || this.mappedRelatedToParameter(s, t, relation)
    );
  }

  /**
   * As TypeScript's rules for a generic mapped target `{ [P in K]: O[P] }` that keeps its optionality: `O` is related
   * to it, and so is a type related to `O` that has every key in `K`, or with `?` some key in `K`, as `T` is to
   * `Partial<T>` and `Readonly<Partial<T>>`.
   */
  private relatedToHomomorphicMapped(s: Type, t: ObjectType, relation: Relation): boolean {
    const mapped = t.objectKind === 'mapped' ? t.mapped : undefined;
    if (!mapped || mapped.optionalModifier === '-' || mapped.nameType) return false;
    const { template, typeParameter, constraint } = mapped;
    // An optional template holds `undefined` too, as `Partial<T>[P]` in `Readonly<Partial<T>>` is `T[P] | undefined`.
    const component = this.removeNullish(template);
    if (component.kind !== 'indexedAccess' || component.indexType !== typeParameter) return false;
    if (template === component && this.identical(template.objectType, s)) return true;
    if (s.kind === 'object' && s.objectKind === 'mapped') return false;
    const sourceKeys = this.c.typeOperators.keyofType(s);
    const hasKeys =
      mapped.optionalModifier === '+'
        ? !isIntrinsic(intersectionOf([constraint, sourceKeys], this.c.budget), 'never')
        : this.isRelated(constraint, sourceKeys, relation);
    return hasKeys && this.isRelated(s, component.objectType, relation);
  }

  /**
   * TypeScript relates `{ [P in K]: X }` that does not add `?` to a type parameter `T` when `keyof T` is related to
   * `K` and `X` to `T[P]`, so `Readonly<T>` is assignable to `T`.
   */
  private mappedRelatedToParameter(s: ObjectType, t: TypeParameter, relation: Relation): boolean {
    const mapped = s.objectKind === 'mapped' ? s.mapped : undefined;
    if (!mapped || mapped.nameType || mapped.optionalModifier === '+') return false;
    const { typeOperators } = this.c;
    return (
      this.isRelated(typeOperators.keyofType(t), mapped.constraint, relation) &&
      this.isRelated(mapped.template, typeOperators.indexedAccess(t, mapped.typeParameter), relation)
    );
  }

  /**
   * Whether a type parameter is related to a type through its constraint; one without a constraint is comparable to
   * any type but another type parameter, as TypeScript lets `x as T` and `v === "x"` stand in generic code.
   */
  private constraintRelated(source: TypeParameter, target: Type, relation: Relation): boolean {
    const constraint = this.c.constraintOf(source);
    if (!constraint) return relation === 'comparable' && target.kind !== 'typeParameter';
    return this.isRelated(constraint, target, relation);
  }

  /** Whether a type is comparable to a type parameter, which it is unless the parameter's constraint excludes it. */
  private constraintAdmits(source: Type, target: TypeParameter): boolean {
    const constraint = this.c.constraintOf(target);
    return constraint ? this.isRelated(source, constraint, 'comparable') : true;
  }

  private sameGeneric(a: Type, b: Type): boolean {
    if (a.kind === 'indexedAccess' && b.kind === 'indexedAccess')
      return this.identical(a.objectType, b.objectType) && this.identical(a.indexType, b.indexType);
    if (a.kind === 'keyof' && b.kind === 'keyof') return this.identical(a.type, b.type);
    if (a.kind === 'conditional' && b.kind === 'conditional') return this.identical(a, b);
    if (a.kind === 'templateLiteral' && b.kind === 'templateLiteral')
      return (
        a.texts.join('\0') === b.texts.join('\0') &&
        a.types.every((type, index) => this.identical(type, b.types[index]))
      );
    return false;
  }

  identical(a: Type, b: Type): boolean {
    return this.isRelated(a, b, 'identical');
  }

  private intrinsicTarget(s: Type, name: string, relation: Relation): boolean {
    switch (name) {
      case 'never': {
        return false;
      }
      case 'void': {
        return isIntrinsic(s, 'undefined') || isIntrinsic(s, 'void');
      }
      case 'undefined': {
        return isIntrinsic(s, 'undefined') || (relation === 'comparable' && isIntrinsic(s, 'void'));
      }
      case 'null': {
        return isIntrinsic(s, 'null');
      }
      case 'object': {
        if (s.kind === 'object') return true;
        if (s.kind === 'intersection')
          return s.types.some((member) => this.isRelated(member, nonPrimitiveType, relation));
        return false;
      }
      case 'string':
      case 'number':
      case 'bigint':
      case 'symbol': {
        if (s.kind === 'literal') return typeof s.value === name;
        if (s.kind === 'templateLiteral' || s.kind === 'stringMapping') return name === 'string';
        return isIntrinsic(s, name as 'string');
      }
      default: {
        return false;
      }
    }
  }

  /** Whether a string matches a template literal type such as `` `id-${number}` ``. */
  private matchesTemplate(value: string, target: Type): boolean {
    if (target.kind === 'stringMapping') {
      const inner = target.type;
      const literal = literalType(value);
      const mapped = this.c.typeOperators.stringMapping(target.mapping, literal);
      if (mapped.kind !== 'literal' || mapped.value !== value) return false;
      return isIntrinsic(inner, 'string') || this.isAssignable(literal, inner);
    }
    if (target.kind !== 'templateLiteral') return false;
    const parts = templatePlaceholderTexts(value, target.texts);
    return parts?.every((text, index) => this.matchesPlaceholder(text, target.types[index])) ?? false;
  }

  /**
   * Whether a template literal type fits another, as `` `ab${number}` `` fits `` `a${string}` ``: TypeScript's
   * `isTypeMatchedByTemplateLiteralType` splits the source at the target's texts and fits each part to a placeholder.
   */
  private templateMatchesTemplate(
    source: TemplateLiteralType,
    target: TemplateLiteralType,
    relation: Relation
  ): boolean {
    const parts = templateParts(source, target, (texts, types) => this.c.typeOperators.templateLiteral(texts, types));
    return parts?.every((part, index) => this.fitsPlaceholder(part, target.types[index], relation)) ?? false;
  }

  /** TypeScript's `isValidTypeForTemplateLiteralPlaceholder`. */
  private fitsPlaceholder(part: Type, placeholder: Type, relation: Relation): boolean {
    if (isIntrinsic(placeholder, 'string') || this.isRelated(part, placeholder, relation)) return true;
    if (part.kind === 'literal' && typeof part.value === 'string')
      return this.matchesPlaceholder(part.value, placeholder);
    return (
      part.kind === 'templateLiteral' &&
      part.texts.length === 2 &&
      part.texts.every((text) => text === '') &&
      this.isRelated(part.types[0], placeholder, relation)
    );
  }

  private matchesPlaceholder(text: string, type: Type): boolean {
    if (isIntrinsic(type, 'string') || isAnyLike(type)) return true;
    if (isIntrinsic(type, 'number')) return isNumberTemplateText(text);
    // TypeScript accepts what scans as a bigint literal, so radix prefixes but no leading zero, sign, or separator.
    if (isIntrinsic(type, 'bigint')) return isBigintTemplateText(text);
    if (type.kind === 'literal') return String(type.value) === text;
    if (type.kind === 'union') return type.types.some((member) => this.matchesPlaceholder(text, member));
    if (type.kind === 'templateLiteral' || type.kind === 'stringMapping') return this.matchesTemplate(text, type);
    return false;
  }

  /** Whether an object type has no members, as `{}` does, which every non-nullish value is assignable to. */
  isEmptyObjectType(type: Type): boolean {
    if (type.kind !== 'object') return false;
    return this.c.isLibraryType(type, 'Object') || this.hasNoMembers(type);
  }

  /**
   * What reading an object with only a string index signature by a generic key gives: TypeScript's
   * `getIndexedAccessTypeOrUndefined` reads it by `string` when the key is assignable to `string` or to `number`, as
   * `r[k]` with `K extends string` on a `Record<string, number[]>` is `number[]`, but leaves `K extends string | number`
   * deferred.
   */
  stringIndexReadByGenericKey(object: Type, key: Type): Type | undefined {
    if (!this.isGeneric(key) || !this.stringIndexOnly(object)) return undefined;
    if (!this.isAssignable(key, stringType) && !this.isAssignable(key, numberType)) return undefined;
    return this.stringIndexType(object);
  }

  private stringIndexType(object: Type): Type {
    if (object.kind === 'union') return unionOf(object.types.map((member) => this.stringIndexType(member)));
    return this.c.structureOf(object).stringIndex?.type ?? errorType;
  }

  /**
   * TypeScript's `isStringIndexSignatureOnlyType`: an object, or a union or intersection of them, with only a string
   * index signature.
   */
  private stringIndexOnly(object: Type): boolean {
    if (object.kind === 'union' || object.kind === 'intersection')
      return object.types.every((member) => this.stringIndexOnly(member));
    if (object.kind !== 'object' || object.objectKind === 'mapped') return false;
    const { properties, stringIndex, numberIndex, symbolIndex, patternIndexes } = this.c.structureOf(object);
    return properties.size === 0 && !!stringIndex && !numberIndex && !symbolIndex && !patternIndexes?.length;
  }

  private hasNoMembers(type: ObjectType): boolean {
    if (type.objectKind === 'mapped') return false;
    const structure = type.resolve();
    return (
      structure.properties.size === 0 &&
      structure.callSignatures.length === 0 &&
      structure.constructSignatures.length === 0 &&
      !hasIndexSignature(structure)
    );
  }

  /**
   * Whether an object is related to a union of objects by its discriminant properties, as `{ ok: boolean }` is to
   * `{ ok: true } | { ok: false }`: each combination of the discriminants' unit values must be related to a member.
   */
  private isRelatedToDiscriminatedUnion(source: ObjectType, targets: Type[], relation: Relation): boolean {
    const union = unionOf(targets);
    const discriminants = [...this.c.structureOf(source).properties.values()]
      .filter((property) => this.c.flow.isDiscriminant(union, property.name))
      .map((property) => {
        const type = property.type();
        return { property, values: type.kind === 'union' ? type.types : [type] };
      })
      .filter(({ values }) => values.length > 1 && values.every((value) => isUnit(value)));
    if (discriminants.length === 0) return false;
    let combinations: Type[][] = [[]];
    for (const { values } of discriminants) {
      combinations = combinations.flatMap((combination) => values.map((value) => [...combination, value]));
      // TypeScript gives up past 25 combinations.
      if (combinations.length > 25) return false;
    }
    return combinations.every((combination) => {
      const variant = anonymousObject(() => {
        const structure = this.c.structureOf(source);
        const properties = new Map(structure.properties);
        for (const [index, { property }] of discriminants.entries()) {
          properties.set(property.name, { ...property, type: () => combination[index] });
        }
        return { ...structure, properties };
      });
      return targets.some((target) => this.isRelated(variant, target, relation));
    });
  }

  private objectRelated(source: Type, target: ObjectType, relation: Relation, state = 0): boolean {
    if (isOptionalMappedType(target) && source.kind === 'object' && this.hasNoMembers(source)) return true;
    if (target.objectKind === 'mapped') {
      return source.kind === 'object' && this.sameMapped(source, target, relation);
    }
    const byElements = this.elementsRelated(source, target, relation);
    if (byElements !== undefined) return byElements;
    const sourceStructure = this.c.structureOf(source);
    const targetStructure = this.c.structureOf(target);
    return (
      this.propertiesRelated(source, sourceStructure, target, targetStructure, relation) &&
      this.signaturesRelated(sourceStructure.callSignatures, targetStructure.callSignatures, relation) &&
      this.signaturesRelated(sourceStructure.constructSignatures, targetStructure.constructSignatures, relation) &&
      keyedIndexes(targetStructure).every((index) =>
        this.indexRelated(sourceStructure, source, index.type, index.keyType, relation, state)
      )
    );
  }

  /** The relation of arrays, tuples, and references to the same generic type, if it decides one. */
  private elementsRelated(source: Type, target: ObjectType, relation: Relation): boolean | undefined {
    if (source.kind === 'object') {
      const related = this.arrayLikeRelated(source, target, relation);
      if (related !== undefined) return related;
    }
    if (target.objectKind === 'tuple') return false;
    if (
      source.kind === 'object' &&
      source.objectKind === 'tuple' &&
      this.c.isArrayType(target) &&
      source.tuple?.readonly
    )
      return false;
    if (source.kind === 'object' && this.c.isReadonlyArrayType(source) && this.c.isArrayType(target)) return false;
    return undefined;
  }

  private arrayLikeRelated(source: ObjectType, target: ObjectType, relation: Relation): boolean | undefined {
    if (source.objectKind === 'reference' && target.objectKind === 'reference' && source.target === target.target) {
      const name = source.target?.name;
      if (name && covariantLibraryTypes.has(name) && this.c.isLibraryType(source, name)) {
        const targetArguments = target.typeArguments ?? [];
        return (source.typeArguments ?? []).every((argument, index) =>
          this.isRelated(argument, targetArguments[index], relation)
        );
      }
    }
    if (source.objectKind === 'tuple' && target.objectKind === 'tuple')
      return this.tupleRelated(source, target, relation);
    if (
      this.c.isArrayOrTuple(source) &&
      target.objectKind === 'reference' &&
      ['ReadonlyArray', 'ArrayLike', 'Array'].some((name) => this.c.isLibraryType(target, name))
    ) {
      if (this.c.isArrayType(target) && (this.c.isReadonlyArrayType(source) || source.tuple?.readonly)) return false;
      return this.isRelated(this.c.elementTypeOf(source), target.typeArguments?.[0] ?? unknownType, relation);
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Checks declared properties, static private members, and same-alias indexes in a single pass.
  private propertiesRelated(
    source: Type,
    sourceStructure: Structure,
    target: ObjectType,
    targetStructure: Structure,
    relation: Relation
  ): boolean {
    const allowMappedIndex = relation === 'assignable' && this.sharesMappedAlias(source, target);
    for (const [name, targetProperty] of targetStructure.properties) {
      this.c.budget.spend();
      if (target.isClassStatic && targetProperty.isPrivateName) continue;
      const sourceProperty =
        source.kind === 'object' || source.kind === 'intersection'
          ? (sourceStructure.properties.get(name) ?? this.c.propertyOf(source, name))
          : this.c.propertyOf(source, name);
      if (!sourceProperty) {
        if (targetProperty.optional) continue;
        const indexed = allowMappedIndex
          ? applicableIndex(this.c, sourceStructure, this.c.typeOperators.propertyKeyType(targetProperty))
          : undefined;
        if (!indexed || !this.isRelated(indexed.type, targetProperty.type(), relation)) return false;
        continue;
      }
      if (!this.propertyRelated(sourceProperty, targetProperty, relation)) return false;
    }
    return true;
  }

  private sharesMappedAlias(source: Type, target: ObjectType): boolean {
    return (
      source.kind === 'object' &&
      source.aliasId !== undefined &&
      source.aliasId === target.aliasId &&
      source.mappedKeys !== undefined &&
      target.mappedKeys !== undefined &&
      this.isAssignable(target.mappedKeys(), source.mappedKeys())
    );
  }

  /**
   * Whether the target is a weak type, whose properties are all optional (an intersection when every member is), and
   * the source has properties but shares none of them.
   */
  private lacksWeakTypeProperty(source: Type, target: Type, relation: Relation): boolean {
    if (relation !== 'assignable' || !isWeakCheckedSource(source) || this.c.isLibraryType(source, 'Object'))
      return false;
    // An intersection drops its empty object literal members, as `Config & {}` is `Config`, but not an empty interface
    // such as `ThisType<any>`, which keeps `PropertyDescriptor & ThisType<any>` from being weak.
    const members =
      target.kind === 'intersection'
        ? target.types.filter(
            (member) => !(member.kind === 'object' && member.objectKind === 'anonymous' && this.hasNoMembers(member))
          )
        : [target];
    if (members.length === 0 || !members.every((member) => member.kind === 'object' && member.objectKind !== 'mapped'))
      return false;
    const targetStructures = members.map((member) => this.c.structureOf(member));
    if (!targetStructures.every((structure) => isWeakStructure(structure))) return false;
    const sourceStructure = this.c.structureOf(source);
    if (sourceStructure.properties.size === 0 && !hasSignatures(sourceStructure)) return false;
    return !targetStructures.some((structure) =>
      [...structure.properties.keys()].some((name) => sourceStructure.properties.has(name))
    );
  }

  /**
   * Whether a generic mapped type is related to another, as TypeScript's `mappedTypeRelatedTo` decides: the target
   * keeps optional what the source makes optional, maps only keys the source maps, renames keys alike, and maps them
   * to related templates.
   */
  private sameMapped(source: ObjectType, target: ObjectType, relation: Relation): boolean {
    const a = source.mapped;
    const b = target.mapped;
    if (!a || !b || source.objectKind !== 'mapped') return false;
    if (relation !== 'comparable' && mappedOptionality(source) > mappedOptionality(target)) return false;
    if (!this.isRelated(b.constraint, a.constraint, relation)) return false;
    const mapper = new Map([[a.typeParameter.id, b.typeParameter as Type]]);
    const sameNames =
      a.nameType && b.nameType
        ? this.identical(this.c.instantiate(a.nameType, mapper), b.nameType)
        : a.nameType === b.nameType;
    return sameNames && this.isRelated(this.c.instantiate(a.template, mapper), b.template, relation);
  }

  private propertyRelated(source: Property, target: Property, relation: Relation): boolean {
    if (target.visibility === 'private' || source.visibility === 'private') {
      // A private member is compatible only with itself.
      if (source.declaration?.id !== target.declaration?.id) return false;
    } else if (target.visibility === 'protected') {
      // A protected member is compatible with one its class or a derived class declares, at either visibility.
      if (!source.declaringClass || !target.declaringClass) return false;
      if (!this.c.classes.derivesFrom(source.declaringClass, target.declaringClass)) return false;
    } else if (source.visibility === 'protected') {
      return false;
    }
    if (source.optional && !target.optional && relation === 'assignable') return false;
    return this.isRelated(propertyAccessType(source), propertyAccessType(target), relation);
  }

  private indexRelated(
    structure: Structure,
    source: Type,
    target: Type,
    keyType: Type,
    relation: Relation,
    state: number
  ): boolean {
    const sourceIndex = applicableIndex(this.c, structure, keyType);
    if (sourceIndex) return this.isRelated(sourceIndex.type, target, relation);
    // TypeScript infers no index signature for a member of an intersection, only for the intersection as a whole.
    if (state & INTERSECTION_SOURCE || !this.hasInferableIndex(source, structure)) return false;
    const narrowerIndexes = keyedIndexes(structure).filter((index) => isIndexKeyOf(this.c, index.keyType, keyType));
    if (narrowerIndexes.some((index) => !this.isRelated(index.type, target, relation))) return false;
    for (const property of structure.properties.values()) {
      if (!isPropertyKeyOf(this.c, property, keyType)) continue;
      if (property.isMethod && source.kind === 'object' && source.objectKind !== 'anonymous') continue;
      if (!this.isRelated(this.inferredIndexMemberType(property, keyType), target, relation)) return false;
    }
    return true;
  }

  private inferredIndexMemberType(property: Property, keyType: Type): Type {
    const type = propertyAccessType(property);
    if (!property.optional) return type;
    if (keyType === numberType || isIntrinsic(type, 'undefined')) return type;
    return filterType(type, (member) => !isIntrinsic(member, 'undefined') && !isIntrinsic(member, 'void'));
  }

  /**
   * Whether the properties of a type satisfy an index signature, as TypeScript's `isObjectTypeWithInferableIndex`
   * decides: an object literal's and a type literal's do; a primitive's, a callable's, a class's, and an interface's do
   * not, and an intersection's do when every member's do.
   */
  private hasInferableIndex(source: Type, structure: Structure): boolean {
    if (source.kind === 'intersection')
      return source.types.every((member) => this.hasInferableIndex(member, this.c.structureOf(member)));
    if (structure.callSignatures.length > 0 || structure.constructSignatures.length > 0) return false;
    if (source.kind !== 'object' || source.objectKind === 'tuple') return false;
    return (source.objectKind !== 'interface' && source.objectKind !== 'reference') || !!source.isLiteral;
  }

  /**
   * Whether a tuple is related to another as TypeScript relates them: each source element is compared with the
   * target element at the same position from the start, or from the end, or else with the target's rest element.
   */
  // code-gauge-allow functionCognitiveComplexity 24 -- Aligns fixed prefixes and suffixes while comparing the whole generic variadic middle.
  private tupleRelated(source: ObjectType, target: ObjectType, relation: Relation): boolean {
    const sourceElements = source.tuple?.elements ?? [];
    const targetElements = target.tuple?.elements ?? [];
    if (source.tuple?.readonly && !target.tuple?.readonly) return false;
    const targetRest = targetElements.findIndex((element) => element.rest);
    const sourceHasRest = sourceElements.some((element) => element.rest);
    if (!sourceHasRest && sourceElements.length < targetElements.filter(isRequired).length) return false;
    if (targetRest === -1 && (sourceHasRest || targetElements.length < sourceElements.length)) return false;
    const startCount = targetRest === -1 ? targetElements.length : targetRest;
    const endCount = targetRest === -1 ? 0 : targetElements.length - targetRest - 1;
    const restType = targetRest === -1 ? undefined : targetElements[targetRest].type;
    const genericRest = this.isGenericRestType(restType);
    if (genericRest) {
      const middle = sourceElements.slice(startCount, Math.max(startCount, sourceElements.length - endCount));
      const middleType = middle.length === 1 && middle[0].rest ? middle[0].type : this.c.tupleType(middle);
      if (!this.isRelated(middleType, restType, relation)) return false;
    }
    return sourceElements.every((element, index) => {
      const fromEnd = sourceElements.length - 1 - index;
      if (genericRest && index >= startCount && fromEnd >= endCount) return true;
      const targetIndex =
        index < startCount ? index : fromEnd < endCount ? targetElements.length - 1 - fromEnd : targetRest;
      return this.tupleElementRelated(element, targetElements[targetIndex], relation);
    });
  }

  isGenericRestType(type: Type | undefined): type is Type {
    return type !== undefined && this.isGeneric(type) && !this.c.isArrayType(type) && !this.c.isReadonlyArrayType(type);
  }

  /** The type a tuple element accepts: a rest element's elements, or `undefined` too when the element is optional. */
  tupleElementTargetType(element: TupleElement): Type {
    if (element.rest) return this.c.restElementType(element.type);
    return element.optional ? unionOf([element.type, undefinedType]) : element.type;
  }

  private tupleElementRelated(element: TupleElement, expected: TupleElement, relation: Relation): boolean {
    if ((element.rest && !expected.rest) || (isRequired(expected) && !isRequired(element))) return false;
    // A missing optional element reads as `undefined` unless the target's element may be missing too.
    const sourceType = element.rest
      ? this.c.restElementType(element.type)
      : element.optional && !expected.optional
        ? unionOf([element.type, undefinedType])
        : element.type;
    return this.isRelated(sourceType, this.tupleElementTargetType(expected), relation);
  }

  private signaturesRelated(sources: Signature[], targets: Signature[], relation: Relation): boolean {
    if (sources.length === 1 && targets.length === 1) return this.signatureRelated(sources[0], targets[0], relation);
    // TypeScript compares overloads with their type parameters erased to `any`.
    const erasedSources = sources.map((source) => this.erased(source));
    for (const target of targets.map((target) => this.erased(target))) {
      if (!erasedSources.some((source) => this.signatureRelated(source, target, relation))) return false;
    }
    return true;
  }

  /**
   * Whether an overload's return type relates either way to its implementation's, or is `void`, and the implementation
   * accepts the overload's arguments, as TypeScript's `isImplementationCompatibleWithOverload` compares erased signatures.
   */
  isImplementationCompatibleWithOverload(implementation: Signature, overload: Signature): boolean {
    const source = this.erased(implementation);
    const target = this.erased(overload);
    const sourceReturn = source.returnType();
    const targetReturn = target.returnType();
    const returnsRelated =
      isIntrinsic(targetReturn, 'void') ||
      isAnyLike(sourceReturn) ||
      this.isAssignable(sourceReturn, targetReturn) ||
      this.isAssignable(targetReturn, sourceReturn);
    return returnsRelated && this.signatureRelated(source, { ...target, returnType: () => voidType }, 'assignable');
  }

  private erased(signature: Signature): Signature {
    if (signature.typeParameters.length === 0) return signature;
    const mapper = new Map(signature.typeParameters.map((parameter) => [parameter.id, anyType as Type]));
    return { ...this.c.instantiateSignature(signature, mapper), typeParameters: [] };
  }

  /**
   * `mode` tells a signature from a callback parameter's, whose parameters TypeScript compares only contravariantly
   * and, for a method's callback, whose return types either way.
   */
  private signatureRelated(
    source: Signature,
    target: Signature,
    relation: Relation,
    mode: SignatureMode = 'signature'
  ): boolean {
    let sourceSignature = source;
    if (source.typeParameters.length > 0) {
      sourceSignature = this.c.inference.instantiateToFit(source, target);
    }
    if (target.isAbstract === false && source.isAbstract) return false;
    const sourceRequired = minimumArguments(sourceSignature);
    const targetCount = target.parameters.some((parameter) => parameter.rest)
      ? Number.POSITIVE_INFINITY
      : target.parameters.length;
    if (sourceRequired > targetCount) return false;
    const bivariant = mode === 'signature' && (source.isMethod === true || target.isMethod === true);
    if (
      !this.thisTypesRelated(sourceSignature, target, relation, bivariant) ||
      !this.parametersRelated(sourceSignature, target, relation, bivariant, mode !== 'signature')
    )
      return false;
    return this.returnsRelated(sourceSignature, target, relation, mode);
  }

  private returnsRelated(source: Signature, target: Signature, relation: Relation, mode: SignatureMode): boolean {
    const targetReturn = target.returnType();
    if (isIntrinsic(targetReturn, 'void')) return true;
    const sourceReturn = source.returnType();
    if (target.predicate && !source.predicate) return false;
    if (target.predicate && source.predicate) {
      return (
        target.predicate.index === source.predicate.index &&
        this.isRelated(source.predicate.type, target.predicate.type, relation)
      );
    }
    return (
      (mode === 'bivariantCallback' && this.isRelated(targetReturn, sourceReturn, relation)) ||
      this.isRelated(sourceReturn, targetReturn, relation)
    );
  }

  /** Whether the target's `this` suits the source's, which only a source that declares a non-`void` one requires. */
  private thisTypesRelated(source: Signature, target: Signature, relation: Relation, bivariant: boolean): boolean {
    if (!source.thisType || isIntrinsic(source.thisType, 'void') || !target.thisType) return true;
    return this.parameterRelated(source.thisType, target.thisType, relation, bivariant, true);
  }

  private parametersRelated(
    source: Signature,
    target: Signature,
    relation: Relation,
    bivariant: boolean,
    inCallback: boolean
  ): boolean {
    if (
      source.parameters.length > 0 &&
      target.parameters.length > 0 &&
      (hasRestTupleTail(source) || hasRestTupleTail(target))
    )
      return this.parameterRelated(
        this.parameterTuple(source),
        this.parameterTuple(target),
        relation,
        bivariant,
        inCallback
      );
    const count = Math.max(source.parameters.length, target.parameters.length);
    for (let index = 0; index < count; index++) {
      const sourceType = this.parameterTypeAt(source, index);
      const targetType = this.parameterTypeAt(target, index);
      if (sourceType && targetType && !this.parameterRelated(sourceType, targetType, relation, bivariant, inCallback))
        return false;
    }
    return true;
  }

  private parameterTuple(signature: Signature): Type {
    const elements: TupleElement[] = [];
    for (const parameter of signature.parameters) {
      const tuple = parameter.rest && parameter.type.kind === 'object' ? parameter.type.tuple : undefined;
      if (tuple) elements.push(...tuple.elements);
      else elements.push({ type: parameter.type, optional: parameter.optional, rest: parameter.rest });
    }
    return this.c.tupleType(elements);
  }

  private parameterRelated(
    sourceType: Type,
    targetType: Type,
    relation: Relation,
    bivariant: boolean,
    inCallback: boolean
  ): boolean {
    const sourceCallback = inCallback ? undefined : this.callbackSignature(sourceType);
    const targetCallback = sourceCallback && this.callbackSignature(targetType);
    // TypeScript compares callback parameters, as `Array#reduce` takes, signature to signature.
    if (sourceCallback && targetCallback && this.isNullable(sourceType) === this.isNullable(targetType))
      return this.signatureRelated(
        targetCallback,
        sourceCallback,
        relation,
        bivariant ? 'bivariantCallback' : 'strictCallback'
      );
    return (
      this.isRelated(targetType, sourceType, relation) ||
      (bivariant && this.isRelated(sourceType, targetType, relation))
    );
  }

  /** The only call signature of a function type without other members, as TypeScript's `getSingleCallSignature`. */
  private callbackSignature(type: Type): Signature | undefined {
    const object = this.removeNullish(type);
    if (object.kind !== 'object') return undefined;
    const { callSignatures, constructSignatures, properties, stringIndex, numberIndex, symbolIndex } =
      this.c.structureOf(object);
    if (callSignatures.length !== 1 || callSignatures[0].predicate) return undefined;
    const hasOtherMembers =
      constructSignatures.length > 0 || properties.size > 0 || stringIndex || numberIndex || symbolIndex;
    return hasOtherMembers ? undefined : callSignatures[0];
  }

  private parameterTypeAt(signature: Signature, index: number): Type | undefined {
    const { parameters } = signature;
    if (index < parameters.length) {
      const parameter = parameters[index];
      if (parameter.rest) return this.c.restElementType(parameter.type);
      return parameter.optional ? unionOf([parameter.type, undefinedType]) : parameter.type;
    }
    const last = parameters.at(-1);
    return last?.rest ? this.c.restElementType(last.type) : undefined;
  }

  // Generic types -------------------------------------------------------------------------------------------------

  /** Whether a type depends on type parameters, other than those in `except`, so that it cannot be resolved yet. */
  isGeneric(type: Type, except: TypeParameter[] = []): boolean {
    const seen = new Set<number>();
    const pending = [type];
    while (pending.length > 0) {
      const current = pending.pop() as Type;
      if (seen.has(current.id)) continue;
      this.c.budget.spend();
      seen.add(current.id);
      if (current.kind === 'typeParameter' && !except.some((parameter) => parameter.id === current.id)) return true;
      if (current.kind === 'conditional' || (current.kind === 'object' && current.objectKind === 'mapped')) return true;
      for (const child of childTypes(current)) pending.push(child);
    }
    return false;
  }

  removeUndefined(type: Type): Type {
    return filterType(type, (member) => !isIntrinsic(member, 'undefined'));
  }

  removeNullish(type: Type): Type {
    return filterType(
      type,
      (member) => !isIntrinsic(member, 'undefined') && !isIntrinsic(member, 'null') && !isIntrinsic(member, 'void')
    );
  }

  isNullable(type: Type): boolean {
    return (type.kind === 'union' ? type.types : [type]).some(
      (member) => isIntrinsic(member, 'undefined') || isIntrinsic(member, 'null') || isIntrinsic(member, 'void')
    );
  }
}

/** The generic types of the library whose type arguments compare covariantly, as TypeScript measures them. */
const covariantLibraryTypes = new Set([
  'Array',
  'ReadonlyArray',
  'ArrayIterator',
  'MapIterator',
  'SetIterator',
  'StringIterator',
  'RegExpStringIterator',
  'ArrayLike',
  'ReadonlyMap',
  'ReadonlySet',
]);

function hasRestTupleTail(signature: Signature): boolean {
  const last = signature.parameters.at(-1);
  if (last?.rest && last.type.kind === 'union') return true;
  const elements = last?.rest && last.type.kind === 'object' ? last.type.tuple?.elements : undefined;
  return elements?.slice(0, -1).some((element) => element.rest) ?? false;
}

/**
 * The text each placeholder of a template literal type takes from a string, as TypeScript splits it without
 * backtracking: a placeholder ends at the first occurrence of the text after it, or after one character when another
 * placeholder follows directly, and the last one takes the rest before the template's final text.
 */
function templatePlaceholderTexts(value: string, texts: readonly string[]): string[] | undefined {
  const startText = texts[0];
  const endText = texts.at(-1) ?? '';
  if (value.length < startText.length + endText.length || !value.startsWith(startText) || !value.endsWith(endText))
    return undefined;
  const body = value.slice(0, value.length - endText.length);
  const parts: string[] = [];
  let position = startText.length;
  for (const delimiter of texts.slice(1, -1)) {
    const end = delimiter === '' ? position + 1 : body.indexOf(delimiter, position);
    if (end < 0 || end > body.length) return undefined;
    parts.push(body.slice(position, end));
    position = end + delimiter.length;
  }
  parts.push(body.slice(position));
  return parts;
}

function isRequired(element: TupleElement): boolean {
  return !element.optional && !element.rest;
}

/** Whether a source is checked against a weak target: an object, an intersection, or a primitive, as in TypeScript. */
function isWeakCheckedSource(source: Type): boolean {
  if (source.kind === 'intrinsic') return !['object', 'null', 'undefined', 'void', 'unknown'].includes(source.name);
  return ['object', 'intersection', 'literal', 'templateLiteral', 'stringMapping'].includes(source.kind);
}

function isWeakStructure(structure: Structure): boolean {
  return (
    structure.properties.size > 0 &&
    [...structure.properties.values()].every((property) => property.optional) &&
    !hasSignatures(structure) &&
    !hasIndexSignature(structure)
  );
}

function hasSignatures(structure: Structure): boolean {
  return structure.callSignatures.length > 0 || structure.constructSignatures.length > 0;
}

function isLeaf(type: Type): boolean {
  return type.kind === 'intrinsic' || type.kind === 'literal';
}

function isPrimitiveComparisonTarget(type: Type): boolean {
  return (
    type === booleanType || isPrimitive(type) || ['literal', 'templateLiteral', 'stringMapping'].includes(type.kind)
  );
}

function referencesForComparison(type: Type): Type {
  return type.kind === 'object' ? (type.resolveReference?.() ?? type) : type;
}

function isOptionalMappedType(type: Type): boolean {
  return type.kind === 'object' && (type.mappedOptional === true || type.mapped?.optionalModifier === '+');
}

/** What instantiations of the same declared type share, as TypeScript's `getRecursionIdentity` returns. */
function recursionIdentity(type: Type): unknown {
  switch (type.kind) {
    case 'object': {
      if (type.objectKind === 'reference') return type.target;
      if (type.objectKind === 'mapped') return type.mapped?.typeParameter;
      if (type.tuple) return tupleIdentity(type.tuple);
      return type.origin ?? type;
    }
    case 'indexedAccess': {
      return recursionIdentity(type.objectType);
    }
    case 'conditional': {
      return type.root ?? type;
    }
    default: {
      return type;
    }
  }
}

/** A tuple's shape, which TypeScript's tuple target, its recursion identity, stands for. */
function tupleIdentity(tuple: TupleInfo): string {
  const shape = tuple.elements.map((element) => {
    if (element.rest) return '.';
    return element.optional ? '?' : '!';
  });
  return `tuple:${tuple.readonly}:${shape.join('')}`;
}
