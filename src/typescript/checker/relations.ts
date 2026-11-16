import type { Checker } from './checker';
import {
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
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
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

  isRelated(source: Type, target: Type, relation: Relation): boolean {
    if (source === target) return true;
    const key = `${relation}:${source.id}:${target.id}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (this.assumed.has(key) || this.assumed.size > 40) return true;
    this.assumed.add(key);
    let result: boolean;
    try {
      result = this.structuredRelated(source, target, relation);
    } finally {
      this.assumed.delete(key);
    }
    if (this.assumed.size === 0) this.cache.set(key, result);
    return result;
  }

  // code-gauge-allow functionCognitiveComplexity 60 -- Follows TypeScript's order of checks for each kind of type.
  private structuredRelated(source: Type, target: Type, relation: Relation): boolean {
    const s = regularOf(source);
    const t = regularOf(target);
    if (s === t) return true;
    if (s === errorType || t === errorType) return true;
    if (isAnyLike(t) || isIntrinsic(t, 'unknown')) return true;
    if (isAnyLike(s)) return !isIntrinsic(t, 'never');
    if (isIntrinsic(s, 'never')) return true;
    if (t.kind === 'union' && s.kind === 'union' && relation === 'assignable') {
      return s.types.every((member) => this.isRelated(member, t, relation));
    }
    if (s.kind === 'union') {
      return relation === 'comparable'
        ? s.types.some((member) => this.isRelated(member, t, relation))
        : s.types.every((member) => this.isRelated(member, t, relation));
    }
    // A type parameter is related to a union its constraint is related to as a whole.
    if (s.kind === 'typeParameter' && t.kind === 'union') {
      if (t.types.some((member) => member.kind === 'typeParameter' && member.id === s.id)) return true;
      if (this.constraintRelated(s, t, relation)) return true;
    }
    if (t.kind === 'union') {
      if (t === booleanType && s.kind === 'literal' && typeof s.value === 'boolean') return true;
      if (t.types.some((member) => this.isRelated(s, member, relation))) return true;
      // An object can be assignable to a union of objects only as a whole, as a discriminated one is.
      return s.kind === 'object' && this.isRelatedToDiscriminatedUnion(s, t.types, relation);
    }
    if (t.kind === 'intersection') return t.types.every((member) => this.isRelated(s, member, relation));
    if (s.kind === 'intersection') {
      if (s.types.some((member) => this.isRelated(member, t, relation))) return true;
      if (t.kind === 'object') return this.objectRelated(s, t, relation);
      return false;
    }
    if (s.kind === 'typeParameter') {
      if (t.kind === 'typeParameter') return s.id === t.id || this.constraintRelated(s, t, relation);
      return this.constraintRelated(s, t, relation);
    }
    if (t.kind === 'typeParameter') return false;
    if (s.kind === 'indexedAccess' || s.kind === 'keyof' || s.kind === 'conditional') {
      if (t.kind === s.kind && this.sameGeneric(s, t)) return true;
      const constraint = this.c.baseConstraint(s);
      return constraint !== s && this.isRelated(constraint, t, relation);
    }
    if (t.kind === 'indexedAccess' || t.kind === 'keyof' || t.kind === 'conditional') {
      if (t.kind === 'keyof' && s.kind === 'literal' && (typeof s.value === 'string' || typeof s.value === 'number')) {
        return false;
      }
      return false;
    }
    if (t.kind === 'intrinsic') return this.intrinsicTarget(s, t.name, relation);
    if (t.kind === 'literal') {
      if (s.kind === 'literal') return s.value === t.value;
      if (relation === 'comparable' && s.kind === 'intrinsic') return s.name === typeof t.value;
      return false;
    }
    if (t.kind === 'templateLiteral' || t.kind === 'stringMapping') {
      if (s.kind === 'literal' && typeof s.value === 'string') return this.matchesTemplate(s.value, t);
      if (s.kind === 'templateLiteral' && t.kind === 'templateLiteral') return this.sameGeneric(s, t);
      return relation === 'comparable' && isIntrinsic(s, 'string');
    }
    if (t.kind === 'object') {
      if (s.kind === 'intrinsic') {
        if (['null', 'undefined', 'void', 'unknown'].includes(s.name)) return false;
        if (s.name === 'object') return this.isEmptyObjectType(t);
      }
      if (
        s.kind === 'literal' ||
        s.kind === 'intrinsic' ||
        s.kind === 'templateLiteral' ||
        s.kind === 'stringMapping'
      ) {
        // A primitive has the members of its boxing interface.
        if (this.isEmptyObjectType(t)) return true;
        return this.objectRelated(s, t, relation);
      }
      if (s.kind === 'object') return this.objectRelated(s, t, relation);
    }
    return false;
  }

  private constraintRelated(source: TypeParameter, target: Type, relation: Relation): boolean {
    const constraint = this.c.constraintOf(source);
    if (!constraint) return this.isEmptyObjectType(target) && false;
    return this.isRelated(constraint, target, relation);
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
      const mapped = this.c.stringMapping(target.mapping, { kind: 'literal', value, fresh: false } as Type);
      if (mapped.kind !== 'literal' || mapped.value !== value) return false;
      return isIntrinsic(inner, 'string') || this.isAssignable({ kind: 'literal', value } as Type, inner);
    }
    if (target.kind !== 'templateLiteral') return false;
    const { texts, types } = target;
    const match = (position: number, index: number): boolean => {
      const prefix = texts[index];
      if (!value.startsWith(prefix, position)) return false;
      const start = position + prefix.length;
      if (index === types.length) return start === value.length;
      const nextText = texts[index + 1];
      for (let end = start; end <= value.length; end++) {
        if (nextText !== '' && !value.startsWith(nextText, end)) continue;
        if (index + 1 === types.length && nextText === '' && end !== value.length) continue;
        if (this.matchesPlaceholder(value.slice(start, end), types[index]) && match(end, index + 1)) return true;
      }
      return false;
    };
    return match(0, 0);
  }

  private matchesPlaceholder(text: string, type: Type): boolean {
    if (isIntrinsic(type, 'string') || isAnyLike(type)) return true;
    if (isIntrinsic(type, 'number')) return text !== '' && text.trim() === text && Number.isFinite(Number(text));
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

  private isRelatedToDiscriminatedUnion(source: ObjectType, targets: Type[], relation: Relation): boolean {
    void source;
    void targets;
    void relation;
    return false;
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- Compares each kind of member as TypeScript does.
  private objectRelated(source: Type, target: ObjectType, relation: Relation): boolean {
    if (target.objectKind === 'mapped') return false;
    // References to the same generic type compare their type arguments, as arrays do.
    if (
      source.kind === 'object' &&
      source.objectKind === 'reference' &&
      target.objectKind === 'reference' &&
      source.target === target.target
    ) {
      const sourceArguments = source.typeArguments ?? [];
      const targetArguments = target.typeArguments ?? [];
      if (sourceArguments.every((argument, index) => this.isRelated(argument, targetArguments[index], relation)))
        return true;
      if (source.target?.name === 'Array' || source.target?.name === 'ReadonlyArray') return false;
    }
    if (source.kind === 'object' && source.objectKind === 'tuple' && target.objectKind === 'tuple')
      return this.tupleRelated(source, target, relation);
    // An array or a tuple is a read-only array, an iterable, and an array-like of its elements.
    if (
      source.kind === 'object' &&
      this.c.isArrayOrTuple(source) &&
      target.objectKind === 'reference' &&
      ['ReadonlyArray', 'Iterable', 'ArrayLike', 'Array'].includes(target.target?.name ?? '')
    ) {
      if (target.target?.name === 'Array' && (this.c.isReadonlyArrayType(source) || source.tuple?.readonly))
        return false;
      return this.isRelated(this.c.elementTypeOf(source), target.typeArguments?.[0] ?? unknownType, relation);
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
    const sourceStructure = this.c.structureOf(source);
    const targetStructure = target.resolve();
    for (const [name, targetProperty] of targetStructure.properties) {
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
    if (!this.signaturesRelated(sourceStructure.callSignatures, targetStructure.callSignatures, relation)) return false;
    if (!this.signaturesRelated(sourceStructure.constructSignatures, targetStructure.constructSignatures, relation))
      return false;
    if (
      targetStructure.stringIndex &&
      !this.indexRelated(sourceStructure, source, targetStructure.stringIndex.type, false, relation)
    )
      return false;
    if (
      targetStructure.numberIndex &&
      !this.indexRelated(sourceStructure, source, targetStructure.numberIndex.type, true, relation)
    )
      return false;
    // A weak type, whose properties are all optional, needs a source sharing one of them.
    if (
      relation === 'assignable' &&
      targetStructure.properties.size > 0 &&
      [...targetStructure.properties.values()].every((property) => property.optional) &&
      targetStructure.callSignatures.length === 0 &&
      !targetStructure.stringIndex &&
      !targetStructure.numberIndex &&
      (sourceStructure.properties.size > 0 || sourceStructure.callSignatures.length > 0) &&
      ![...targetStructure.properties.keys()].some((name) => sourceStructure.properties.has(name))
    ) {
      return false;
    }
    return true;
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
      if (numeric && !/^\d+$/.test(name)) continue;
      if (property.isMethod && source.kind === 'object' && source.objectKind !== 'anonymous') continue;
      const type = property.optional ? unionOf([property.type(), undefinedType]) : property.type();
      if (!this.isRelated(type, target, relation)) return false;
    }
    return true;
  }

  private tupleRelated(source: ObjectType, target: ObjectType, relation: Relation): boolean {
    const sourceElements = source.tuple?.elements ?? [];
    const targetElements = target.tuple?.elements ?? [];
    if (source.tuple?.readonly && !target.tuple?.readonly) return false;
    const targetRest = targetElements.findIndex((element) => element.rest);
    const fixedTarget = targetRest === -1 ? targetElements : targetElements.slice(0, targetRest);
    const required = fixedTarget.filter((element) => !element.optional).length;
    const sourceRest = sourceElements.findIndex((element) => element.rest);
    if (sourceRest !== -1 && targetRest === -1) return false;
    const sourceFixed = sourceRest === -1 ? sourceElements : sourceElements.slice(0, sourceRest);
    if (sourceFixed.filter((element) => !element.optional).length < required) return false;
    if (targetRest === -1 && sourceFixed.length > targetElements.length) return false;
    for (const [index, element] of sourceFixed.entries()) {
      const targetElement = index < fixedTarget.length ? fixedTarget[index] : targetElements[targetRest];
      if (!targetElement) return false;
      const targetType = targetElement.rest ? this.c.restElementType(targetElement.type) : targetElement.type;
      if (element.optional && !targetElement.optional && !targetElement.rest) return false;
      if (!this.isRelated(element.type, targetType, relation)) return false;
    }
    if (sourceRest !== -1) {
      const restType = this.c.restElementType(sourceElements[sourceRest].type);
      const targetType = this.c.restElementType(targetElements[targetRest].type);
      if (!this.isRelated(restType, targetType, relation)) return false;
    }
    return true;
  }

  private signaturesRelated(sources: Signature[], targets: Signature[], relation: Relation): boolean {
    for (const target of targets) {
      if (!sources.some((source) => this.signatureRelated(source, target, relation))) return false;
    }
    return true;
  }

  signatureRelated(source: Signature, target: Signature, relation: Relation): boolean {
    let sourceSignature = source;
    if (source.typeParameters.length > 0) {
      // A generic source is instantiated to fit the target, as the target's parameters infer its type arguments.
      sourceSignature = this.c.expressions.calls.instantiateToFit(source, target);
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
    return this.isRelated(sourceReturn, targetReturn, relation);
  }

  private parameterTypeAt(signature: Signature, index: number): Type | undefined {
    const { parameters } = signature;
    if (index < parameters.length) {
      const parameter = parameters[index];
      return parameter.rest ? this.c.restElementType(parameter.type) : parameter.type;
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
