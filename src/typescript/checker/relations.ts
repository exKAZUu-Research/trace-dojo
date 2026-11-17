// code-gauge-allow-file fileNcss 446 -- Decides assignability and comparability for every kind of type, as TypeScript's checker does in one place.
import type { Checker } from './checker';
import { isUnit } from './flow';
import { isNumericName } from './syntax';
import {
  anonymousObject,
  booleanType,
  errorType,
  filterType,
  isAnyLike,
  isIntrinsic,
  type ObjectType,
  type Property,
  regularOf,
  type Signature,
  type Structure,
  type TupleElement,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  type UnionType,
  unknownType,
} from './types';

type Relation = 'assignable' | 'comparable';

/** Whether one type is assignable to, or comparable with, another, as TypeScript decides it. */
export class Relations {
  /** Pairs assumed related while comparing their members, which recursive types revisit. */
  private readonly assumed = new Set<string>();
  private readonly cache = new Map<string, boolean>();

  constructor(private readonly c: Checker) {}

  isAssignable(source: Type, target: Type): boolean {
    return this.isRelated(source, target, 'assignable');
  }

  /** Whether `===` may find two values of these types equal: one is comparable to the other. */
  isComparable(a: Type, b: Type): boolean {
    return this.isRelated(a, b, 'comparable') || this.isRelated(b, a, 'comparable');
  }

  /** With `checkWeak` false, as for a member of an intersection target, skips the check of a weak target type. */
  isRelated(source: Type, target: Type, relation: Relation, checkWeak = true): boolean {
    if (source === target) return true;
    this.c.budget.spend();
    const key = `${relation}${checkWeak ? '' : '-member'}:${source.id}:${target.id}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (this.assumed.has(key) || this.assumed.size > 40) return true;
    this.assumed.add(key);
    let result: boolean;
    try {
      result = this.structuredRelated(source, target, relation, checkWeak);
    } finally {
      this.assumed.delete(key);
    }
    if (this.assumed.size === 0) this.cache.set(key, result);
    return result;
  }

  // code-gauge-allow functionCognitiveComplexity 29 -- Follows TypeScript's order of checks for each kind of type.
  // code-gauge-allow functionNcss 35 -- Follows TypeScript's order of checks for each kind of type.
  private structuredRelated(source: Type, target: Type, relation: Relation, checkWeak: boolean): boolean {
    const s = regularOf(source);
    const t = regularOf(target);
    const trivial = this.trivialRelation(s, t);
    if (trivial !== undefined) return trivial;
    if (s.kind === 'union') return this.unionSourceRelated(s, t, relation, checkWeak);
    if (checkWeak && this.lacksWeakTypeProperty(s, t, relation)) return false;
    if (t.kind === 'union') return this.relatedToUnion(s, t, relation);
    // TypeScript checks a weak intersection as a whole, so a member whose properties are all optional need not share one.
    if (t.kind === 'intersection') return t.types.every((member) => this.isRelated(s, member, relation, false));
    if (s.kind === 'intersection') {
      if (s.types.some((member) => this.isRelated(member, t, relation))) return true;
      return t.kind === 'object' && this.objectRelated(s, t, relation);
    }
    if (s.kind === 'typeParameter') {
      return (t.kind === 'typeParameter' && s.id === t.id) || this.constraintRelated(s, t, relation);
    }
    if (t.kind === 'typeParameter') return relation === 'comparable' && this.constraintAdmits(s, t);
    if (s.kind === 'indexedAccess' || s.kind === 'keyof' || s.kind === 'conditional') {
      if (t.kind === s.kind && this.sameGeneric(s, t)) return true;
      const constraint = this.c.baseConstraint(s);
      return constraint !== s && this.isRelated(constraint, t, relation);
    }
    if (t.kind === 'indexedAccess' && !this.isGeneric(t.objectType)) {
      // Writing `o[k]` with a generic key must suit the property of every key the constraint allows.
      const keys = this.c.baseConstraint(t.indexType);
      const members = keys.kind === 'union' ? keys.types : [keys];
      if (keys !== t.indexType && members.every((member) => member.kind === 'literal')) {
        return members.every((key) =>
          this.isRelated(s, this.c.typeOperators.indexedAccess(t.objectType, key), relation)
        );
      }
    }
    if (t.kind === 'indexedAccess' || t.kind === 'keyof' || t.kind === 'conditional') return false;
    return this.relatedToConcrete(s, t, relation);
  }

  private unionSourceRelated(s: UnionType, t: Type, relation: Relation, checkWeak: boolean): boolean {
    return relation === 'comparable'
      ? s.types.some((member) => this.isRelated(member, t, relation, checkWeak))
      : s.types.every((member) => this.isRelated(member, t, relation, checkWeak));
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

  private relatedToConcrete(s: Type, t: Type, relation: Relation): boolean {
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
        return this.relatedToObject(s, t, relation);
      }
      default: {
        return false;
      }
    }
  }

  private relatedToObject(s: Type, t: ObjectType, relation: Relation): boolean {
    if (s.kind === 'intrinsic') {
      if (['null', 'undefined', 'void', 'unknown'].includes(s.name)) return false;
      // `object` has the members of `Object`.
      if (s.name === 'object')
        return this.isEmptyObjectType(t) || this.objectRelated(this.c.globalType('Object'), t, relation);
    }
    if (s.kind === 'literal' || s.kind === 'intrinsic' || s.kind === 'templateLiteral' || s.kind === 'stringMapping') {
      // A primitive has the members of its boxing interface.
      return this.isEmptyObjectType(t) || this.objectRelated(s, t, relation);
    }
    return s.kind === 'object' && this.objectRelated(s, t, relation);
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
    if (isIntrinsic(type, 'bigint')) return /^-?\d+$/.test(text);
    if (type.kind === 'literal') return String(type.value) === text;
    if (type.kind === 'union') return type.types.some((member) => this.matchesPlaceholder(text, member));
    return false;
  }

  /** Whether an object type has no members, as `{}` does, which every non-nullish value is assignable to. */
  isEmptyObjectType(type: Type): boolean {
    if (type.kind !== 'object') return false;
    if (type.objectKind === 'interface' && type.name === 'Object') return true;
    const structure = type.resolve();
    return (
      structure.properties.size === 0 &&
      structure.callSignatures.length === 0 &&
      structure.constructSignatures.length === 0 &&
      !structure.stringIndex &&
      !structure.numberIndex
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

  private objectRelated(source: Type, target: ObjectType, relation: Relation): boolean {
    if (target.objectKind === 'mapped') return source.kind === 'object' && this.sameMapped(source, target, relation);
    const byElements = this.elementsRelated(source, target, relation);
    if (byElements !== undefined) return byElements;
    const sourceStructure = this.c.structureOf(source);
    const targetStructure = target.resolve();
    const { stringIndex, numberIndex } = targetStructure;
    return (
      this.propertiesRelated(source, sourceStructure, targetStructure, relation) &&
      this.signaturesRelated(sourceStructure.callSignatures, targetStructure.callSignatures, relation) &&
      this.signaturesRelated(sourceStructure.constructSignatures, targetStructure.constructSignatures, relation) &&
      (!stringIndex || this.indexRelated(sourceStructure, source, stringIndex.type, false, relation)) &&
      (!numberIndex || this.indexRelated(sourceStructure, source, numberIndex.type, true, relation))
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
    if (sourceStructure.properties.size === 0 && sourceStructure.callSignatures.length === 0) return false;
    return !targetStructures.some((structure) =>
      [...structure.properties.keys()].some((name) => sourceStructure.properties.has(name))
    );
  }

  /** Whether two generic mapped types map the same keys to related templates. */
  private sameMapped(source: ObjectType, target: ObjectType, relation: Relation): boolean {
    const a = source.mapped;
    const b = target.mapped;
    if (!a || !b || source.objectKind !== 'mapped') return false;
    if (!this.identical(a.constraint, b.constraint) || Boolean(a.nameType) !== Boolean(b.nameType)) return false;
    const template = this.c.instantiate(a.template, new Map([[a.typeParameter.id, b.typeParameter]]));
    return this.isRelated(template, b.template, relation);
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

  // code-gauge-allow functionCognitiveComplexity 18 -- Follows TypeScript's rules for which members satisfy an index signature.
  private indexRelated(
    structure: Structure,
    source: Type,
    target: Type,
    numeric: boolean,
    relation: Relation
  ): boolean {
    const sourceIndex = numeric ? (structure.numberIndex ?? structure.stringIndex) : structure.stringIndex;
    if (sourceIndex) return this.isRelated(sourceIndex.type, target, relation);
    // An object literal's or a type literal's properties satisfy an index signature; a class's or interface's do not.
    if (
      source.kind === 'object' &&
      (source.objectKind === 'interface' || source.objectKind === 'reference') &&
      !source.isLiteral
    ) {
      if (source.classInfo) return false;
      return false;
    }
    for (const [name, property] of structure.properties) {
      if (numeric && !isNumericName(name)) continue;
      if (property.isMethod && source.kind === 'object' && source.objectKind !== 'anonymous') continue;
      const type = property.optional ? unionOf([property.type(), undefinedType]) : property.type();
      if (!this.isRelated(type, target, relation)) return false;
    }
    return true;
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
    for (const target of targets) {
      if (!sources.some((source) => this.signatureRelated(source, target, relation))) return false;
    }
    return true;
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Compares parameters and return types as TypeScript does.
  signatureRelated(source: Signature, target: Signature, relation: Relation): boolean {
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
    const count = Math.max(sourceSignature.parameters.length, target.parameters.length);
    const bivariant = source.isMethod === true || target.isMethod === true;
    for (let index = 0; index < count; index++) {
      const sourceType = this.parameterTypeAt(sourceSignature, index);
      const targetType = this.parameterTypeAt(target, index);
      if (!sourceType || !targetType) continue;
      const related =
        this.isRelated(targetType, sourceType, relation) ||
        (bivariant && this.isRelated(sourceType, targetType, relation));
      if (!related) return false;
    }
    const targetReturn = target.returnType();
    if (isIntrinsic(targetReturn, 'void')) return true;
    const sourceReturn = sourceSignature.returnType();
    if (target.predicate && !sourceSignature.predicate) return false;
    if (target.predicate && sourceSignature.predicate) {
      return (
        target.predicate.index === sourceSignature.predicate.index &&
        this.isRelated(sourceSignature.predicate.type, target.predicate.type, relation)
      );
    }
    return this.isRelated(sourceReturn, targetReturn, relation);
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
    switch (type.kind) {
      case 'typeParameter': {
        return !except.some((parameter) => parameter.id === type.id);
      }
      case 'union':
      case 'intersection': {
        return type.types.some((member) => this.containsTypeParameter(member, except, seen));
      }
      case 'object': {
        if (type.objectKind === 'mapped') return true;
        if (type.objectKind === 'reference')
          return (type.typeArguments ?? []).some((argument) => this.containsTypeParameter(argument, except, seen));
        if (type.objectKind === 'tuple')
          return (type.tuple?.elements ?? []).some((element) => this.containsTypeParameter(element.type, except, seen));
        return false;
      }
      case 'indexedAccess': {
        return (
          this.containsTypeParameter(type.objectType, except, seen) ||
          this.containsTypeParameter(type.indexType, except, seen)
        );
      }
      case 'keyof': {
        return this.containsTypeParameter(type.type, except, seen);
      }
      case 'conditional': {
        return true;
      }
      case 'templateLiteral': {
        return type.types.some((member) => this.containsTypeParameter(member, except, seen));
      }
      case 'stringMapping': {
        return this.containsTypeParameter(type.type, except, seen);
      }
      default: {
        return false;
      }
    }
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

function isWeakStructure(structure: Structure): boolean {
  return (
    structure.properties.size > 0 &&
    [...structure.properties.values()].every((property) => property.optional) &&
    structure.callSignatures.length === 0 &&
    !structure.stringIndex &&
    !structure.numberIndex
  );
}
