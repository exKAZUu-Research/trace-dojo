// code-gauge-allow-file fileNcss 671 -- Decides assignability and comparability for every kind of type, as TypeScript's checker does in one place.
import type { Checker } from './checker';
import { isUnit } from './flow';
import { childTypes, isGenericObjectOrIndexType } from './genericTypes';
import { isNumericName } from './syntax';
import {
  anonymousObject,
  anyType,
  booleanType,
  type ConditionalType,
  errorType,
  filterType,
  type IndexedAccessType,
  type IndexInfo,
  type IntersectionType,
  isAnyLike,
  isIntrinsic,
  isSymbolName,
  numberType,
  type ObjectType,
  type Property,
  regularOf,
  type Signature,
  stringType,
  type Structure,
  type TupleElement,
  type TupleInfo,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  type UnionType,
  unknownType,
} from './types';

type Relation = 'assignable' | 'comparable';
type SignatureMode = 'signature' | 'strictCallback' | 'bivariantCallback';
type KeyKind = 'string' | 'number' | 'symbol';

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
  isRelated(source: Type, target: Type, relation: Relation, state = 0): boolean {
    if (source === target) return true;
    this.c.budget.spend();
    const key = `${relation}-${state}:${source.id}:${target.id}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (this.assumed.has(key) || this.provisionalKeys.has(key)) return true;
    if (isLeaf(source) && isLeaf(target)) return this.structuredRelated(source, target, relation, state);
    // TypeScript gives up here with "Excessive stack depth comparing types" (TS2321).
    if (this.sourceStack.length >= MAX_RELATION_DEPTH) return false;
    // An outermost comparison that an exception ended left its provisional pairs undecided.
    if (this.assumed.size === 0) this.dropProvisional(0);
    const start = this.provisional.length;
    this.assumed.add(key);
    let result: boolean;
    try {
      result = this.nestedRelated(source, target, relation, state);
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
  private nestedRelated(source: Type, target: Type, relation: Relation, state: number): boolean {
    const saved = this.expanding;
    this.sourceStack.push(source);
    this.targetStack.push(target);
    try {
      if (!(saved & EXPANDING_SOURCE) && this.isDeeplyNested(source, this.sourceStack))
        this.expanding |= EXPANDING_SOURCE;
      if (!(saved & EXPANDING_TARGET) && this.isDeeplyNested(target, this.targetStack))
        this.expanding |= EXPANDING_TARGET;
      // Both sides keep expanding the same recursive types, so TypeScript assumes the relation holds.
      return (
        this.expanding === (EXPANDING_SOURCE | EXPANDING_TARGET) ||
        this.structuredRelated(source, target, relation, state)
      );
    } finally {
      this.sourceStack.pop();
      this.targetStack.pop();
      this.expanding = saved;
    }
  }

  /** Whether a stack ending in `type` has expanded its recursive type too often, as TypeScript's `isDeeplyNestedType` decides. */
  private isDeeplyNested(type: Type, stack: Type[]): boolean {
    if (stack.length < MAX_RECURSION_IDENTITY_COUNT) return false;
    if (type.kind === 'intersection') return type.types.some((member) => this.isDeeplyNested(member, stack));
    const identity = this.recursionIdentity(type);
    let count = 0;
    let lastId = 0;
    for (const member of stack) {
      if (!this.hasRecursionIdentity(member, identity)) continue;
      // Only a type created later than the previous match, as by an expanding instantiation, counts.
      if (member.id >= lastId && ++count >= MAX_RECURSION_IDENTITY_COUNT) return true;
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

  // code-gauge-allow functionCognitiveComplexity 24 -- Follows TypeScript's order of checks for each kind of type.
  // code-gauge-allow functionNcss 32 -- Follows TypeScript's order of checks for each kind of type.
  private structuredRelated(source: Type, target: Type, relation: Relation, state: number): boolean {
    const s = regularOf(source);
    const t = regularOf(target);
    const trivial = this.trivialRelation(s, t);
    if (trivial !== undefined) return trivial;
    if (s.kind === 'union') return this.unionSourceRelated(s, t, relation, state);
    if (!(state & INTERSECTION_TARGET) && this.lacksWeakTypeProperty(s, t, relation)) return false;
    if (t.kind === 'union') return this.relatedToUnion(s, t, relation);
    // TypeScript checks a weak intersection as a whole, so a member whose properties are all optional need not share one.
    if (t.kind === 'intersection')
      return t.types.every((member) => this.isRelated(s, member, relation, state | INTERSECTION_TARGET));
    if (this.relatedToGenericTarget(s, t, relation)) return true;
    if (s.kind === 'intersection') return this.intersectionSourceRelated(s, t, relation, state);
    if (s.kind === 'typeParameter') return this.typeParameterRelated(s, t, relation);
    if (s.kind === 'indexedAccess' || s.kind === 'keyof' || s.kind === 'conditional') {
      if (this.genericSourceRelated(s, t, relation)) return true;
      if (t.kind !== 'typeParameter') return false;
    }
    if (t.kind === 'typeParameter') return relation === 'comparable' && this.constraintAdmits(s, t);
    if (t.kind === 'indexedAccess') return this.relatedToIndexedAccess(s, t, relation);
    if (t.kind === 'keyof' || t.kind === 'conditional') return false;
    return this.relatedToConcrete(s, t, relation, state);
  }

  private intersectionSourceRelated(s: IntersectionType, t: Type, relation: Relation, state: number): boolean {
    if (s.types.some((member) => this.isRelated(member, t, relation, state | INTERSECTION_SOURCE))) return true;
    return t.kind === 'object' && this.objectRelated(s, t, relation, state);
  }

  private typeParameterRelated(s: TypeParameter, t: Type, relation: Relation): boolean {
    if ((t.kind === 'typeParameter' && s.id === t.id) || this.constraintRelated(s, t, relation)) return true;
    return t.kind === 'indexedAccess' && this.relatedToIndexedAccess(s, t, relation);
  }

  /**
   * Writing `o[k]` must suit the property, or the index signature, of every key the constraint of `k` allows in the
   * constraint of `o`. As in TypeScript, the constraint of `o` offers only its number index signature, since a type
   * argument may lack the others.
   */
  private relatedToIndexedAccess(s: Type, t: IndexedAccessType, relation: Relation): boolean {
    const object = this.constraintForWriting(t.objectType);
    const keys = this.constraintForWriting(t.indexType);
    if (isGenericObjectOrIndexType(object) || isGenericObjectOrIndexType(keys)) return false;
    const numberIndexOnly = object !== t.objectType;
    return (keys.kind === 'union' ? keys.types : [keys]).every((key) => {
      const writeType = this.writeTypeOf(object, key, numberIndexOnly);
      return writeType !== undefined && this.isRelated(s, writeType, relation);
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
    const { stringIndex, numberIndex, symbolIndex } = this.c.structureOf(object);
    if (key.kind === 'literal') {
      const indexed = typeof key.value === 'number' && numberIndex !== undefined;
      if (numberIndexOnly && !indexed && !this.hasProperty(object, String(key.value))) return undefined;
      return this.c.typeOperators.indexedAccess(object, key);
    }
    if (isIntrinsic(key, 'number')) return (numberIndex ?? (numberIndexOnly ? undefined : stringIndex))?.type;
    if (numberIndexOnly) return undefined;
    if (isIntrinsic(key, 'string') || key.kind === 'templateLiteral' || key.kind === 'stringMapping')
      return stringIndex?.type;
    if (isIntrinsic(key, 'symbol')) return symbolIndex?.type;
    return undefined;
  }

  private hasProperty(object: Type, name: string): boolean {
    return object.kind === 'union'
      ? object.types.every((member) => this.hasProperty(member, name))
      : this.c.propertyOf(object, name) !== undefined;
  }

  private genericSourceRelated(s: Type, t: Type, relation: Relation): boolean {
    if (t.kind === s.kind && this.sameGeneric(s, t)) return true;
    if (s.kind === 'conditional' && t.kind === 'conditional' && this.conditionalsRelated(s, t, relation)) return true;
    // TypeScript tries a conditional type's branches before their constraints, so `Exclude<keyof T, K>` fits `keyof T`.
    if (s.kind === 'conditional' && this.isRelated(unionOf([s.trueType, s.falseType]), t, relation)) return true;
    const constraint = this.c.baseConstraint(s);
    return constraint !== s && this.isRelated(constraint, t, relation);
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
    if (s === t || s === errorType || t === errorType) return true;
    if (isAnyLike(t) || isIntrinsic(t, 'unknown')) return true;
    if (isAnyLike(s)) return !isIntrinsic(t, 'never');
    if (isIntrinsic(s, 'never')) return true;
    return undefined;
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
        if (s.kind === 'templateLiteral' && t.kind === 'templateLiteral') {
          // `id-${number}` fits `id-${string}`: the same texts around types that each fit.
          const sameTexts =
            s.texts.length === t.texts.length && s.texts.every((text, index) => text === t.texts[index]);
          return (
            this.sameGeneric(s, t) ||
            (sameTexts &&
              s.types.every(
                // A `${string}` placeholder takes any value spelled into a template.
                (type, index) => isIntrinsic(t.types[index], 'string') || this.isRelated(type, t.types[index], relation)
              ))
          );
        }
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
    return t.kind === 'typeParameter' && s.kind === 'object' && this.mappedRelatedToParameter(s, t, relation);
  }

  /**
   * `{ [P in K]: S[P] }` with its optionality kept holds what `S` does, and `{ [P in keyof S]: S[P] }` what is related to
   * `S` too, as TypeScript's rules for a generic mapped target relate `T` to `Partial<T>` and `Readonly<Partial<T>>`.
   */
  private relatedToHomomorphicMapped(s: Type, t: ObjectType, relation: Relation): boolean {
    const mapped = t.objectKind === 'mapped' ? t.mapped : undefined;
    if (!mapped || mapped.optionalModifier === '-' || mapped.nameType) return false;
    const { template, typeParameter, constraint } = mapped;
    if (template.kind !== 'indexedAccess' || template.indexType !== typeParameter) return false;
    if (this.identical(template.objectType, s)) return true;
    // Only over the keys of `S` does a type related to `S` have every key, as `Pick<S, K>` need not.
    return (
      constraint.kind === 'keyof' &&
      this.identical(constraint.type, template.objectType) &&
      this.isRelated(s, template.objectType, relation)
    );
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
    if (a.kind === 'conditional' && b.kind === 'conditional')
      return (
        this.identical(a.checkType, b.checkType) &&
        this.identical(a.extendsType, b.extendsType) &&
        this.identical(a.trueType, b.trueType) &&
        this.identical(a.falseType, b.falseType)
      );
    if (a.kind === 'templateLiteral' && b.kind === 'templateLiteral')
      return (
        a.texts.join('\0') === b.texts.join('\0') &&
        a.types.every((type, index) => this.identical(type, b.types[index]))
      );
    return false;
  }

  identical(a: Type, b: Type): boolean {
    if (a === b) return true;
    return this.isAssignable(a, b) && this.isAssignable(b, a);
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
          return s.types.some((member) =>
            this.isRelated(member, { ...s, kind: 'intrinsic', name: 'object' } as Type, relation)
          );
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
      const mapped = this.c.typeOperators.stringMapping(target.mapping, {
        kind: 'literal',
        value,
        fresh: false,
      } as Type);
      if (mapped.kind !== 'literal' || mapped.value !== value) return false;
      return isIntrinsic(inner, 'string') || this.isAssignable({ kind: 'literal', value } as Type, inner);
    }
    if (target.kind !== 'templateLiteral') return false;
    const parts = templatePlaceholderTexts(value, target.texts);
    return parts?.every((text, index) => this.matchesPlaceholder(text, target.types[index])) ?? false;
  }

  private matchesPlaceholder(text: string, type: Type): boolean {
    if (isIntrinsic(type, 'string') || isAnyLike(type)) return true;
    if (isIntrinsic(type, 'number')) return text !== '' && Number.isFinite(Number(text));
    // TypeScript accepts what scans as a bigint literal, so radix prefixes but no leading zero, sign, or separator.
    if (isIntrinsic(type, 'bigint')) return /^-?(?:0|[1-9]\d*|0[xX][\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+)$/.test(text);
    if (type.kind === 'literal') return String(type.value) === text;
    if (type.kind === 'union') return type.types.some((member) => this.matchesPlaceholder(text, member));
    if (type.kind === 'templateLiteral' || type.kind === 'stringMapping') return this.matchesTemplate(text, type);
    return false;
  }

  /** Whether an object type has no members, as `{}` does, which every non-nullish value is assignable to. */
  isEmptyObjectType(type: Type): boolean {
    if (type.kind !== 'object') return false;
    return (type.objectKind === 'interface' && type.name === 'Object') || this.hasNoMembers(type);
  }

  /**
   * What reading an object with only a string index signature by a generic string or number key gives: tsc reads it
   * by `string`, as `r[k]` with `K extends string` on a `Record<string, number[]>` is `number[]`.
   */
  stringIndexReadByGenericKey(object: Type, key: Type): Type | undefined {
    if (!this.isGeneric(key)) return undefined;
    const type = this.stringIndexOnlyType(object);
    return type && this.isAssignable(key, unionOf([stringType, numberType])) ? type : undefined;
  }

  /** The type of the string index signature of an object, or of each union member, that has no other members. */
  private stringIndexOnlyType(object: Type): Type | undefined {
    if (object.kind === 'union') {
      const types = object.types.map((member) => this.stringIndexOnlyType(member));
      return types.every((type) => type !== undefined) ? unionOf(types) : undefined;
    }
    if (object.kind !== 'object' || object.objectKind === 'mapped') return undefined;
    const { properties, stringIndex, numberIndex, symbolIndex } = this.c.structureOf(object);
    return properties.size === 0 && !numberIndex && !symbolIndex ? stringIndex?.type : undefined;
  }

  private hasNoMembers(type: ObjectType): boolean {
    if (type.objectKind === 'mapped') return false;
    const structure = type.resolve();
    return (
      structure.properties.size === 0 &&
      structure.callSignatures.length === 0 &&
      structure.constructSignatures.length === 0 &&
      !structure.stringIndex &&
      !structure.numberIndex &&
      !structure.symbolIndex
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
    if (target.objectKind === 'mapped') {
      // Every property of a mapped type that adds `?` is optional, so an object without members holds what it does.
      if (isOptionalMappedType(target) && source.kind === 'object' && this.hasNoMembers(source)) return true;
      return source.kind === 'object' && this.sameMapped(source, target, relation);
    }
    const byElements = this.elementsRelated(source, target, relation);
    if (byElements !== undefined) return byElements;
    const sourceStructure = this.c.structureOf(source);
    const targetStructure = this.c.structureOf(target);
    const { stringIndex, numberIndex, symbolIndex } = targetStructure;
    return (
      this.propertiesRelated(source, sourceStructure, targetStructure, relation) &&
      this.signaturesRelated(sourceStructure.callSignatures, targetStructure.callSignatures, relation) &&
      this.signaturesRelated(sourceStructure.constructSignatures, targetStructure.constructSignatures, relation) &&
      (!stringIndex || this.indexRelated(sourceStructure, source, stringIndex.type, 'string', relation, state)) &&
      (!numberIndex || this.indexRelated(sourceStructure, source, numberIndex.type, 'number', relation, state)) &&
      (!symbolIndex || this.indexRelated(sourceStructure, source, symbolIndex.type, 'symbol', relation, state))
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
    // References to the same generic type compare their type arguments, as arrays do.
    if (source.objectKind === 'reference' && target.objectKind === 'reference' && source.target === target.target) {
      const sourceArguments = source.typeArguments ?? [];
      const targetArguments = target.typeArguments ?? [];
      const covariant = sourceArguments.every((argument, index) =>
        this.isRelated(argument, targetArguments[index], relation)
      );
      // The library's collections are covariant; another generic type may use a type argument where it is
      // contravariant, as a function-typed property does, so its structures decide.
      if (covariantLibraryTypes.has(source.target?.name ?? '')) return covariant;
      if (!covariant) return undefined;
    }
    if (source.objectKind === 'tuple' && target.objectKind === 'tuple')
      return this.tupleRelated(source, target, relation);
    // An array or a tuple is a read-only array, an iterable, and an array-like of its elements.
    if (
      this.c.isArrayOrTuple(source) &&
      target.objectKind === 'reference' &&
      ['ReadonlyArray', 'Iterable', 'ArrayLike', 'Array'].includes(target.target?.name ?? '')
    ) {
      if (target.target?.name === 'Array' && (this.c.isReadonlyArrayType(source) || source.tuple?.readonly))
        return false;
      return this.isRelated(this.c.elementTypeOf(source), target.typeArguments?.[0] ?? unknownType, relation);
    }
    return undefined;
  }

  private propertiesRelated(
    source: Type,
    sourceStructure: Structure,
    targetStructure: Structure,
    relation: Relation
  ): boolean {
    for (const [name, targetProperty] of targetStructure.properties) {
      this.c.budget.spend();
      const sourceProperty =
        source.kind === 'object' || source.kind === 'intersection'
          ? (sourceStructure.properties.get(name) ?? this.c.propertyOf(source, name))
          : this.c.propertyOf(source, name);
      if (!sourceProperty) {
        if (targetProperty.optional) continue;
        return false;
      }
      if (!this.propertyRelated(sourceProperty, targetProperty, relation)) return false;
    }
    return true;
  }

  /**
   * Whether the target is a weak type, whose properties are all optional (an intersection when every member is), and
   * the source has properties but shares none of them.
   */
  private lacksWeakTypeProperty(source: Type, target: Type, relation: Relation): boolean {
    if (relation !== 'assignable' || !isWeakCheckedSource(source)) return false;
    // An intersection drops its empty object members, as `Config & {}` is `Config`.
    const members =
      target.kind === 'intersection' ? target.types.filter((member) => !this.isEmptyObjectType(member)) : [target];
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
    } else if (target.visibility === 'protected' || source.visibility === 'protected') {
      // A protected member is compatible with one a derived class redeclares.
      if (source.visibility !== target.visibility || !source.declaringClass || !target.declaringClass) return false;
      if (!this.c.classes.derivesFrom(source.declaringClass, target.declaringClass)) return false;
    }
    if (source.optional && !target.optional && relation === 'assignable') return false;
    const sourceType = source.type();
    const targetType = target.optional ? unionOf([target.type(), undefinedType]) : target.type();
    return this.isRelated(sourceType, targetType, relation);
  }

  private indexRelated(
    structure: Structure,
    source: Type,
    target: Type,
    keyKind: KeyKind,
    relation: Relation,
    state: number
  ): boolean {
    const sourceIndex = applicableIndex(structure, keyKind);
    if (sourceIndex) return this.isRelated(sourceIndex.type, target, relation);
    // TypeScript infers no index signature for a member of an intersection, only for the intersection as a whole.
    if (state & INTERSECTION_SOURCE || !this.hasInferableIndex(source, structure)) return false;
    for (const [name, property] of structure.properties) {
      if (!isNameOfKind(name, keyKind)) continue;
      if (property.isMethod && source.kind === 'object' && source.objectKind !== 'anonymous') continue;
      const type = property.optional ? unionOf([property.type(), undefinedType]) : property.type();
      if (!this.isRelated(type, target, relation)) return false;
    }
    return true;
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
    if (source.kind !== 'object') return false;
    return (source.objectKind !== 'interface' && source.objectKind !== 'reference') || !!source.isLiteral;
  }

  /**
   * Whether a tuple is related to another as TypeScript relates them: each source element is compared with the
   * target element at the same position from the start, or from the end, or else with the target's rest element.
   */
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
    return sourceElements.every((element, index) => {
      const fromEnd = sourceElements.length - 1 - index;
      const targetIndex =
        index < startCount ? index : fromEnd < endCount ? targetElements.length - 1 - fromEnd : targetRest;
      return this.tupleElementRelated(element, targetElements[targetIndex], relation);
    });
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
      // A generic source is instantiated to fit the target, as the target's parameters infer its type arguments.
      sourceSignature = this.c.inference.instantiateToFit(source, target);
    }
    if (target.isAbstract === false && source.isAbstract) return false;
    const sourceRequired = sourceSignature.parameters.filter(
      (parameter) => !parameter.optional && !parameter.rest
    ).length;
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
    const count = Math.max(source.parameters.length, target.parameters.length);
    for (let index = 0; index < count; index++) {
      const sourceType = this.parameterTypeAt(source, index);
      const targetType = this.parameterTypeAt(target, index);
      if (sourceType && targetType && !this.parameterRelated(sourceType, targetType, relation, bivariant, inCallback))
        return false;
    }
    return true;
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
    return this.containsTypeParameter(type, except, new Set());
  }

  private containsTypeParameter(type: Type, except: TypeParameter[], seen: Set<number>): boolean {
    if (seen.has(type.id)) return false;
    seen.add(type.id);
    if (type.kind === 'typeParameter') return !except.some((parameter) => parameter.id === type.id);
    if (type.kind === 'conditional' || (type.kind === 'object' && type.objectKind === 'mapped')) return true;
    return childTypes(type).some((child) => this.containsTypeParameter(child, except, seen));
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
  'Iterable',
  'IterableIterator',
  'Iterator',
  'ArrayIterator',
  'MapIterator',
  'SetIterator',
  'StringIterator',
  'RegExpStringIterator',
  'ArrayLike',
  'ReadonlyMap',
  'ReadonlySet',
]);

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

/** The index signature of a structure that applies to keys of a kind, as a string index does to numeric keys. */
function applicableIndex(structure: Structure, keyKind: KeyKind): IndexInfo | undefined {
  if (keyKind === 'symbol') return structure.symbolIndex;
  return keyKind === 'number' ? (structure.numberIndex ?? structure.stringIndex) : structure.stringIndex;
}

/** Whether a property name is a key of a kind, as `"0"` is both a string and a numeric key. */
function isNameOfKind(name: string, keyKind: KeyKind): boolean {
  if (isSymbolName(name)) return keyKind === 'symbol';
  return keyKind === 'string' || (keyKind === 'number' && isNumericName(name));
}

function isWeakStructure(structure: Structure): boolean {
  return (
    structure.properties.size > 0 &&
    [...structure.properties.values()].every((property) => property.optional) &&
    !hasSignatures(structure) &&
    !structure.stringIndex &&
    !structure.numberIndex &&
    !structure.symbolIndex
  );
}

function hasSignatures(structure: Structure): boolean {
  return structure.callSignatures.length > 0 || structure.constructSignatures.length > 0;
}

function isLeaf(type: Type): boolean {
  return type.kind === 'intrinsic' || type.kind === 'literal';
}

function isOptionalMappedType(type: Type): boolean {
  return type.kind === 'object' && type.objectKind === 'mapped' && type.mapped?.optionalModifier === '+';
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

/** Whether a mapped type adds (1) or removes (-1) optionality, as TypeScript's `getCombinedMappedTypeOptionality` decides. */
function mappedOptionality(type: Type | undefined): number {
  if (type?.kind === 'intersection') {
    const [first, ...rest] = type.types.map((member) => mappedOptionality(member));
    return rest.every((optionality) => optionality === first) ? (first ?? 0) : 0;
  }
  if (type?.kind !== 'object' || !type.mapped) return 0;
  const { optionalModifier, source } = type.mapped;
  if (optionalModifier) return optionalModifier === '+' ? 1 : -1;
  return mappedOptionality(source);
}

/** A tuple's shape, which TypeScript's tuple target, its recursion identity, stands for. */
function tupleIdentity(tuple: TupleInfo): string {
  const shape = tuple.elements.map((element) => {
    if (element.rest) return '.';
    return element.optional ? '?' : '!';
  });
  return `tuple:${tuple.readonly}:${shape.join('')}`;
}
