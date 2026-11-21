// code-gauge-allow-file fileNcss 445 -- Keeps flow state, joins, and reference narrowing together.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isUnchangedVariable } from './constantReferences';
import { ExceptionFlow } from './exceptionFlow';
import { isGenericObjectOrIndexType } from './genericTypes';
import { applicableIndex } from './indexInfos';
import { nonNullableType, nullishConstraint, withoutNullishUnit } from './nullishConstraints';
import { named, propertyNameText, skipParentheses } from './syntax';
import {
  anonymousObject,
  bigintType,
  booleanType,
  emptyObjectType,
  emptyStructure,
  falseType,
  filterType,
  intersectionOf,
  type IntersectionType,
  isAnyLike,
  isDiscriminantLiteral,
  isIntrinsic,
  isPropertyKeyLiteral,
  type LiteralType,
  mapType,
  narrowedUnknownObjectType,
  neverType,
  nonPrimitiveType,
  nullType,
  numberType,
  type ObjectType,
  propertyAccessType,
  regularOf,
  simpleProperty,
  stringType,
  symbolType,
  trueType,
  type Type,
  typeMembers,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

export interface FlowEntry {
  type: Type;
  /** Whether every path to here assigned the variable. */
  assigned: boolean;
  /** For `const a = []`, the array type it has evolved to by the pushes so far. */
  evolving?: boolean;
  /** For a value of a type parameter constrained to a union, that constraint as narrowed so far. */
  constraint?: Type;
}

/** What the paths to a point in a program tell about its variables and references; undefined where none reach it. */
export class FlowState {
  constructor(
    readonly entries = new Map<string, FlowEntry>(),
    /** The fields of `this` (by reference key) that every path to here assigned, which a constructor must. */
    readonly assignedFields = new Set<string>(),
    public superCalled = false,
    /**
     * Set where no path reaches, though tsc narrows there as its binder lets the bypass of a `switch` whose cases cover
     * every value of its discriminant reach it: `'switchEnd'` right past that `switch`, which a merge ignores as tsc
     * ignores such a bypass, and `'after'` from the next statement on, which a merge joins.
     */
    public dead?: 'switchEnd' | 'after'
  ) {}

  clone(): FlowState {
    return new FlowState(new Map(this.entries), new Set(this.assignedFields), this.superCalled, this.dead);
  }

  /** Makes this state what `other` is, for holders of this state to see it. */
  copyFrom(other: FlowState): void {
    this.entries.clear();
    for (const [key, entry] of other.entries) this.entries.set(key, entry);
    this.assignedFields.clear();
    for (const field of other.assignedFields) this.assignedFields.add(field);
    this.superCalled = other.superCalled;
    this.dead = other.dead;
  }
}

export type State = FlowState | undefined;

/** The flow of a program's control, which narrows its references and tracks its assignments. */
export class Flow {
  current: State = new FlowState();
  probing = false;
  readonly exceptions: ExceptionFlow;
  /** While set, only the references it accepts narrow, and their keys are collected, as for an aliased condition. */
  narrowingScope?: { accepts: (node: TreeNode) => boolean; keys: Set<string>; reuseCallPredicates: boolean };
  constructor(private readonly c: Checker) {
    this.exceptions = new ExceptionFlow(c, this, (types) => this.joinTypes(types));
  }

  merge(states: State[]): State {
    const defined = states.filter((state): state is FlowState => state !== undefined);
    const joined = defined.filter((state) => state.dead !== 'switchEnd');
    const reachable = joined.length > 0 ? joined : defined;
    if (reachable.length === 0) return undefined;
    if (reachable.length === 1) return reachable[0].clone();
    const merged = new FlowState(
      undefined,
      undefined,
      reachable.every((state) => state.superCalled),
      reachable.some((state) => !state.dead) ? undefined : reachable[0].dead
    );
    const [first, ...others] = reachable;
    for (const field of first.assignedFields) {
      if (others.every((state) => state.assignedFields.has(field))) merged.assignedFields.add(field);
    }
    for (const [key] of first.entries) {
      const entries = reachable.map((state) => state.entries.get(key));
      // A path that does not narrow the reference leaves it with its declared type.
      if (entries.some((entry) => entry === undefined)) continue;
      const defined = entries as FlowEntry[];
      merged.entries.set(key, {
        type: this.joinTypes(defined.map((entry) => entry.type)),
        assigned: defined.every((entry) => entry.assigned),
        evolving: defined.some((entry) => entry.evolving),
        constraint: defined.every((entry) => entry.constraint)
          ? this.joinTypes(defined.map((entry) => entry.constraint as Type))
          : undefined,
      });
    }
    return merged;
  }

  /**
   * Joins `others` into the current state, which a check running from `start` ended in, keeping `start` as the
   * current state since callers that narrow may hold it.
   */
  rejoin(start: State, others: State[]): void {
    const merged = this.merge([this.current, ...others]);
    if (start && merged) {
      start.copyFrom(merged);
      this.current = start;
    } else {
      this.current = merged;
    }
  }

  private joinTypes(types: Type[]): Type {
    const first = types[0];
    if (first?.kind === 'literal' && typeof first.value === 'boolean' && types.every((type) => type === first))
      return first;
    const union = unionOf(types);
    if (union.kind !== 'union') return union;
    return unionOf(
      union.types.filter(
        (member, index) =>
          !union.types.some(
            (other, otherIndex) =>
              index !== otherIndex &&
              this.c.relations.isAssignable(member, other) &&
              (!this.c.relations.isAssignable(other, member) || otherIndex < index)
          )
      )
    );
  }

  readonly declaredTypes = new Map<string, Type>();

  /** Runs `run` from `state`, returning the state it ends in. */
  from(state: State, run: () => void): State {
    return this.withState(state, () => {
      run();
      return this.current;
    });
  }

  withState<T>(state: State, run: () => T): T {
    const outer = this.current;
    this.current = state?.clone();
    try {
      return run();
    } finally {
      this.current = outer;
    }
  }

  probe<T>(run: () => T, ...source: [] | [State]): T {
    const probing = this.probing;
    this.probing = true;
    try {
      return this.withState(source.length === 0 ? this.current : source[0], () => this.exceptions.isolate(run));
    } finally {
      this.probing = probing;
    }
  }

  get isReachable(): boolean {
    return this.current !== undefined;
  }

  entry(key: string): FlowEntry | undefined {
    return this.current?.entries.get(key);
  }

  set(key: string, entry: FlowEntry, assignment?: TreeNode): void {
    if (!this.current) return;
    // tsc gives a reference assigned where no path reaches its declared type.
    if (this.current.dead && entry.assigned) this.current.entries.delete(key);
    else this.current.entries.set(key, entry);
    if (!this.current.dead) this.exceptions.record(key, entry, assignment);
  }

  /** Forgets what was known about the properties of a reference that is assigned. */
  invalidate(key: string): void {
    if (!this.current) return;
    const { entries } = this.current;
    for (const other of entries.keys()) {
      if (other.startsWith(`${key}.`)) entries.delete(other);
    }
  }

  /** The property an element access always reads: a literal key, or a constant holding a literal. */
  constantIndexName(index: TreeNode): string | undefined {
    index = skipParentheses(index);
    if (index.type === 'string' || index.type === 'number') return propertyNameText(index);
    const template =
      index.type === 'template_string' && !named(index).some((child) => child.type === 'template_substitution');
    if (!template) {
      if (index.type !== 'identifier') return undefined;
      const symbol = this.c.scopeOf(index).lookupValue(index.text);
      if (symbol?.valueKind !== 'const') return undefined;
    }
    const type = this.c.silently(() => this.c.expressions.check(index));
    return isPropertyKeyLiteral(type) ? String(type.value) : undefined;
  }

  /** The key of a reference that narrowing applies to: a variable, `this`, or a property path of one. */
  referenceKey(node: TreeNode): string | undefined {
    const expression = skipParentheses(node);
    switch (expression.type) {
      case 'identifier':
      case 'shorthand_property_identifier':
      case 'shorthand_property_identifier_pattern': {
        const symbol = this.c.scopeOf(expression).lookupValue(expression.text);
        return symbol ? `s${symbol.id}` : undefined;
      }
      case 'this': {
        return `this${this.c.classes.thisOwnerId(expression)}`;
      }
      case 'non_null_expression': {
        return this.referenceKey(named(expression)[0]);
      }
      case 'member_expression': {
        const object = expression.childForFieldName('object');
        const property = expression.childForFieldName('property');
        if (!object || !property) return undefined;
        const base = this.referenceKey(object);
        return base ? propertyReferenceKey(base, this.c.classes.propertyKey(expression, property)) : undefined;
      }
      case 'subscript_expression': {
        const object = expression.childForFieldName('object');
        const index = expression.childForFieldName('index');
        const base = object && index ? this.referenceKey(object) : undefined;
        return base && index ? this.elementReferenceKey(base, index) : undefined;
      }
      default: {
        return undefined;
      }
    }
  }

  /**
   * The key of an element access: a property's for a literal key, or else one by the variable keying it, which
   * TypeScript's `isMatchingReference` lets narrow while the variable cannot change. `%` sets it apart from a property
   * name, which `propertyReferenceKey` escapes it in.
   */
  private elementReferenceKey(base: string, index: TreeNode): string | undefined {
    const name = this.constantIndexName(index);
    if (name !== undefined) return propertyReferenceKey(base, name);
    if (index.type !== 'identifier' || !isUnchangedVariable(this.c, index)) return undefined;
    const indexKey = this.referenceKey(index);
    return indexKey ? `${base}.%${indexKey}` : undefined;
  }

  /** Narrows the reference `node` to `narrow` of its current type. */
  narrowReference(node: TreeNode, narrow: (type: Type) => Type): void {
    const key = this.referenceKey(node);
    if (!key || !this.current) return;
    if (this.narrowingScope) {
      if (!this.narrowingScope.accepts(node)) return;
      this.narrowingScope.keys.add(key);
    }
    const current = this.c.expressions.checkReferenceSilently(node);
    const entry = this.current.entries.get(key);
    // A value of a type parameter or an indexed access constrained to a union also narrows the constraint, which
    // reading its members uses.
    const constraint = entry?.constraint ?? this.unionConstraint(current);
    const assigned = entry ? entry.assigned : !this.c.expressions.readsNeverInitialized(node);
    this.current.entries.set(key, {
      type: narrow(current),
      // A check that rules out `undefined` shows that the variable was assigned, as it narrows away tsc's `undefined`.
      assigned: assigned || !this.c.relations.isAssignable(undefinedType, narrow(unionOf([current, undefinedType]))),
      evolving: entry?.evolving,
      constraint: constraint && narrow(constraint),
    });
  }

  /** As TypeScript's `isGenericTypeWithUnionConstraint`, the base constraint of a type variable that may be a union. */
  private unionConstraint(type: Type): Type | undefined {
    if (type.kind !== 'typeParameter' && type.kind !== 'indexedAccess') return undefined;
    const constraint = this.c.baseConstraint(type);
    return constraint !== type && (constraint.kind === 'union' || this.c.relations.isNullable(constraint))
      ? constraint
      : undefined;
  }

  // Narrowing operations ----------------------------------------------------------------------------------------

  /**
   * The type a type predicate narrows `type` to, as TypeScript's `getNarrowedType` gives with assignability for its
   * subtype checks: the members each member of the predicate type relates to, or else the more specific of the two
   * types, or else their intersection.
   */
  narrowByPredicate(type: Type, predicateType: Type): Type {
    if (isAnyLike(type) || isIntrinsic(type, 'unknown') || type === predicateType) return predicateType;
    const narrowed = mapType(predicateType, (candidate) => this.narrowByPredicateMember(type, candidate));
    if (!isIntrinsic(narrowed, 'never')) return narrowed;
    if (this.c.relations.isAssignable(predicateType, type)) return predicateType;
    if (this.c.relations.isAssignable(type, predicateType)) return type;
    return intersectionOf([type, predicateType], this.c);
  }

  /**
   * For each member of `type` related to `candidate`, the more specific of the two; with none, each type parameter whose
   * constraint `candidate` fits, intersected with it.
   */
  private narrowByPredicateMember(type: Type, candidate: Type): Type {
    const assignable = (source: Type, target: Type): boolean => this.c.relations.isAssignable(source, target);
    const related = mapType(type, (member) =>
      assignable(member, candidate) ? member : assignable(candidate, member) ? candidate : neverType
    );
    if (!isIntrinsic(related, 'never')) return related;
    return mapType(type, (member) =>
      member.kind === 'typeParameter' && assignable(candidate, member.constraint?.() ?? unknownType)
        ? intersectionOf([member, candidate], this.c)
        : neverType
    );
  }

  /** The part of a type that `typeof value === name` keeps (or, with `assumeTrue` false, that the opposite keeps). */
  narrowByTypeof(type: Type, name: string, assumeTrue: boolean): Type {
    if (isAnyLike(type) || isIntrinsic(type, 'unknown')) {
      if (!assumeTrue) return type;
      const narrowed = typeofTypes.get(name);
      if (narrowed) return narrowed;
      if (isAnyLike(type)) return type;
      if (name === 'object') return unionOf([nonPrimitiveType, nullType]);
      return name === 'function' ? this.c.globalType('Function') : type;
    }
    if (!assumeTrue) return filterType(type, (member) => this.typeofMatches(member, name) !== true);
    return mapType(type, (member) => this.narrowTypeofMember(member, name));
  }

  private narrowTypeofMember(member: Type, name: string): Type {
    const matches = this.typeofMatches(member, name);
    if (matches === true) return member;
    if (matches === 'maybe') return this.narrowMaybe(member, name);
    if (member.kind === 'typeParameter') {
      const bound = nullishConstraint(this.c, member);
      if (bound.kind === 'union') return intersectionOf([member, this.narrowByTypeof(bound, name, true)], this.c);
      return neverType;
    }
    const shape = this.typeofStructuralShape(member);
    if (shape.kind !== 'object' && !isIntrinsic(shape, 'object')) return neverType;
    const implied = typeofTypes.get(name) ?? (name === 'function' ? this.c.globalType('Function') : undefined);
    return implied && this.c.relations.isAssignable(implied, shape) ? implied : neverType;
  }

  private typeofStructuralShape(type: Type): Type {
    if (type.kind !== 'intersection') return type;
    const members = type.types.filter(
      (member) =>
        member.kind !== 'object' ||
        this.c.isLibraryType(member, 'Object') ||
        !this.c.relations.isEmptyObjectType(member)
    );
    return members.length === 1 ? members[0] : type;
  }

  private narrowMaybe(member: Type, name: string): Type {
    const narrowed =
      typeofTypes.get(name) ??
      (name === 'function'
        ? this.c.globalType('Function')
        : name === 'object'
          ? this.typeofObjectType(member)
          : undefined);
    if (!narrowed) return member;
    return member.kind === 'typeParameter' || member.kind === 'intersection'
      ? intersectionOf([member, narrowed], this.c)
      : narrowed;
  }

  private typeofObjectType(type: Type): Type {
    const bound = nullishConstraint(this.c, type);
    return isIntrinsic(bound, 'unknown') || typeMembers(bound).some((member) => isIntrinsic(member, 'null'))
      ? unionOf([nonPrimitiveType, nullType])
      : nonPrimitiveType;
  }

  // code-gauge-allow functionNcss 37 -- One case per `typeof` result.
  /** Whether `typeof` a value of the type gives `name`: always, never, or maybe. */
  private typeofMatches(type: Type, name: string): boolean | 'maybe' {
    switch (type.kind) {
      case 'literal': {
        return typeof type.value === name;
      }
      case 'templateLiteral':
      case 'stringMapping': {
        return name === 'string';
      }
      case 'intrinsic': {
        switch (type.name) {
          case 'string':
          case 'number':
          case 'bigint':
          case 'symbol':
          case 'undefined': {
            return type.name === name;
          }
          case 'void': {
            return name === 'undefined';
          }
          case 'null': {
            return name === 'object';
          }
          case 'object': {
            return name === 'object';
          }
          case 'never': {
            return false;
          }
          default: {
            return 'maybe';
          }
        }
      }
      case 'object': {
        return this.objectTypeofMatches(type, name);
      }
      case 'typeParameter': {
        const constraint = this.c.constraintOf(type);
        return constraint ? this.typeofMatches(constraint, name) : 'maybe';
      }
      case 'union': {
        const matches = type.types.map((member) => this.typeofMatches(member, name));
        return matches.every((result) => result === matches[0]) ? matches[0] : 'maybe';
      }
      case 'intersection': {
        return this.intersectionTypeofMatches(type, name);
      }
      default: {
        return 'maybe';
      }
    }
  }

  /**
   * Whether `typeof` a value of an intersection gives `name`. As TypeScript decides, object members beside a primitive
   * are tags it ignores, and an intersection with other object members is an object, a function when it is callable.
   */
  private intersectionTypeofMatches(type: IntersectionType, name: string): boolean | 'maybe' {
    const bound = nullishConstraint(this.c, type);
    if (bound.kind !== 'intersection') return this.typeofMatches(bound, name);
    const tagged = bound.types.some(
      (member) =>
        member.kind === 'literal' ||
        member.kind === 'templateLiteral' ||
        member.kind === 'stringMapping' ||
        (member.kind === 'intrinsic' && member.name !== 'object')
    );
    if (!tagged && bound.types.some((member) => member.kind === 'object')) return this.objectTypeofMatches(bound, name);
    const results = bound.types
      .filter((member) => member.kind !== 'object')
      .map((member) => this.typeofMatches(member, name));
    if (results.includes(false)) return false;
    return results.every((result) => result === true) ? true : 'maybe';
  }

  private objectTypeofMatches(type: Type, name: string): boolean | 'maybe' {
    if (type === emptyObjectType || type === narrowedUnknownObjectType) return name === 'undefined' ? false : 'maybe';
    const isFunction =
      this.c.signaturesOf(type, 'call').length > 0 ||
      this.c.signaturesOf(type, 'construct').length > 0 ||
      this.c.relations.isAssignable(type, this.c.globalType('Function'));
    if (name === 'function') return isFunction;
    return name === 'object' && !isFunction;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Follows TypeScript's narrowing of each kind of type by truthiness.
  /** The part of a type that a truthy (or falsy) value has. */
  narrowByTruthiness(type: Type, assumeTrue: boolean): Type {
    if (assumeTrue)
      return nonNullableType(
        this.c,
        filterType(type, (member) => member.kind !== 'literal' || Boolean(member.value))
      );
    if (isAnyLike(type) || isIntrinsic(type, 'unknown')) return type;
    return mapType(type, (member) => {
      if (member.kind === 'literal') return member.value ? neverType : member;
      if (member === narrowedUnknownObjectType || member === emptyObjectType) return member;
      if (member.kind === 'object' || isIntrinsic(member, 'object') || isIntrinsic(member, 'symbol')) return neverType;
      if (member === booleanType) return falseType;
      return member;
    });
  }

  /**
   * The part of a type that `value == null` keeps, as TypeScript narrows it: its nullish members, and a generic one
   * that may be nullish, whole or with the nullish part of its constraint.
   */
  private nullishPart(type: Type): Type {
    return mapType(type, (member) => {
      if (
        isIntrinsic(member, 'null') ||
        isIntrinsic(member, 'undefined') ||
        isIntrinsic(member, 'void') ||
        isIntrinsic(member, 'unknown') ||
        isAnyLike(member)
      )
        return member;
      if (!this.c.relations.isGeneric(member)) return neverType;
      // An unconstrained one stays whole, and a constrained one keeps its identity with the nullish part of its
      // constraint, so it still fits where the type parameter does.
      const constraint = nullishConstraint(this.c, member);
      if (constraint === member || isIntrinsic(constraint, 'unknown')) return member;
      const nullish = this.nullishPart(constraint);
      return isIntrinsic(nullish, 'never') ? neverType : intersectionOf([member, nullish], this.c);
    });
  }

  /** The part of a type that `value === other` (or `!==`) keeps, given the other operand's type. */
  narrowByEquality(type: Type, other: Type, assumeTrue: boolean, loose: boolean): Type {
    return assumeTrue ? this.narrowToEqual(type, other, loose) : this.narrowToUnequal(type, other, loose);
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Preserves generic identity while comparing unit types and resolving nullish bounds during equality narrowing.
  private narrowToEqual(type: Type, other: Type, loose: boolean): Type {
    const nullish = isIntrinsic(other, 'null') || isIntrinsic(other, 'undefined');
    if (loose && nullish) return this.nullishPart(type);
    if (isAnyLike(type)) return type;
    if (isIntrinsic(type, 'unknown')) return isUnit(other) ? other : type;
    const filtered = filterType(type, (member) =>
      this.c.relations.isComparable(nullish ? nullishConstraint(this.c, member) : member, other)
    );
    if (isUnit(other)) {
      // A union's members that equal the unit become it, as `string` does for `"a"`.
      return mapType(filtered, (member) =>
        member.kind === 'literal' || isUnitIntrinsic(member)
          ? member
          : this.c.relations.isAssignable(other, member)
            ? other
            : member
      );
    }
    return filtered;
  }

  private narrowToUnequal(type: Type, other: Type, loose: boolean): Type {
    const nullish = isIntrinsic(other, 'null') || isIntrinsic(other, 'undefined');
    if (!isUnit(other)) return type;
    // `unknown` that is not `null` is `{} | undefined`, and not either is `{}`.
    if (isIntrinsic(type, 'unknown') && nullish) {
      if (loose) return narrowedUnknownObjectType;
      return unionOf([narrowedUnknownObjectType, isIntrinsic(other, 'null') ? undefinedType : nullType]);
    }
    if (loose && nullish) return nonNullableType(this.c, type);
    // An intersection with a unit, as `T & null`, is that unit or nothing.
    const unequal = filterType(type, (member) =>
      (member.kind === 'intersection' ? member.types : [member]).every(
        (part) => !isUnit(part) || !sameUnit(part, other)
      )
    );
    return nullish ? withoutNullishUnit(this.c, unequal, other) : unequal;
  }

  /** An instance brand follows inheritance, while a static brand is held only by the declaring constructor. */
  narrowByPrivateBrand(type: Type, brand: Type, assumeTrue: boolean): Type {
    if (brand.kind !== 'object' || !brand.isClassStatic) return this.narrowByInstanceof(type, brand, assumeTrue);
    if (type === brand) return assumeTrue ? type : neverType;
    if (!assumeTrue) return type;
    if (isAnyLike(type) || this.c.relations.isAssignable(brand, type)) return brand;
    if (this.c.relations.isAssignable(type, brand)) return type;
    return intersectionOf([type, brand], this.c);
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Preserves generic identity and filters concrete nominal alternatives.
  /** The part of a type that `value instanceof C` keeps, given the instance type of `C`. */
  narrowByInstanceof(type: Type, instance: Type, assumeTrue: boolean): Type {
    if (assumeTrue) {
      if (isAnyLike(type) || isIntrinsic(type, 'unknown')) return instance;
      const related = mapType(type, (member) => {
        if (isGenericObjectOrIndexType(member)) return intersectionOf([member, instance], this.c);
        if (this.isDerivedFrom(member, instance)) return member;
        return this.isDerivedFrom(instance, member) ? instance : neverType;
      });
      return isIntrinsic(related, 'never') ? instance : related;
    }
    return filterType(type, (member) => isAnyLike(member) || !this.isDerivedFrom(member, instance));
  }

  /**
   * Whether a type derives from a class's instance type, as TypeScript's `instanceof` narrowing decides by the base
   * classes, not by shape; a type that is not a class of the program, as a library one, is compared by its shape.
   */
  private isDerivedFrom(source: Type, target: Type): boolean {
    if (source.kind === 'union') return source.types.every((member) => this.isDerivedFrom(member, target));
    if (source.kind === 'intersection') return source.types.some((member) => this.isDerivedFrom(member, target));
    if (target.kind === 'union') return target.types.some((member) => this.isDerivedFrom(source, member));
    const constraint = this.c.baseConstraint(source);
    if (constraint !== source) return this.isDerivedFrom(constraint, target);
    const targetClass = target.kind === 'object' && !target.isClassStatic ? target.classInfo : undefined;
    if (!targetClass) return this.c.relations.isAssignable(source, target);
    const sourceClass = source.kind === 'object' && !source.isClassStatic ? source.classInfo : undefined;
    return sourceClass !== undefined && this.c.classes.derivesFrom(sourceClass, targetClass);
  }

  /** The part of a type that `name in value` keeps, as TypeScript's `narrowTypeByInKeyword` decides. */
  narrowByIn(type: Type, key: LiteralType, assumeTrue: boolean): Type {
    if (isAnyLike(type)) return type;
    const members = type.kind === 'union' ? type.types : [type];
    if (members.some((member) => this.isPresencePossible(member, key, true)))
      return filterType(type, (member) => this.isPresencePossible(member, key, assumeTrue));
    if (!assumeTrue) return type;
    const name = String(key.value);
    // A type that no member declares the property in gains it as `unknown`, as `object` becomes `object & Record<"a", unknown>`.
    return intersectionOf(
      [
        type,
        anonymousObject(() => ({
          ...emptyStructure(),
          properties: new Map([[name, simpleProperty(name, unknownType, { nameType: key })]]),
        })),
      ],
      this.c
    );
  }

  /** Whether a value of a type may have (or, with `assumeTrue` false, lack) a property, as its members and index signatures say. */
  private isPresencePossible(type: Type, key: LiteralType, assumeTrue: boolean): boolean {
    const property = this.c.propertyOf(type, String(key.value));
    if (property) return property.optional || assumeTrue;
    return applicableIndex(this.c, this.c.structureOf(type), key) !== undefined || !assumeTrue;
  }

  /** The members of a union whose property `name` may be `value`, as `x.kind === "a"` narrows `x`. */
  narrowByDiscriminant(type: Type, name: string, narrow: (propertyType: Type) => Type): Type {
    return filterType(type, (member) => {
      if (member.kind !== 'object' && member.kind !== 'intersection') return true;
      const property = this.c.propertyOf(member, name);
      if (!property) return true;
      return !isIntrinsic(narrow(propertyAccessType(property)), 'never');
    });
  }

  isDiscriminant(type: Type, name: string): boolean {
    if (type.kind !== 'union') return false;
    this.c.budget.spend(type.types.length);
    const propertyTypes = type.types.flatMap((member) => {
      if (member.kind !== 'object' && member.kind !== 'intersection') return [];
      const property = this.c.propertyOf(member, name);
      return property ? [regularOf(propertyAccessType(property))] : [];
    });
    return (
      propertyTypes.some(isDiscriminantLiteral) &&
      new Set(propertyTypes.map((propertyType) => propertyType.id)).size > 1 &&
      !isGenericObjectOrIndexType(unionOf(propertyTypes))
    );
  }

  /** The type of a variable after assigning `assigned` to it when it is declared as `declared`. */
  assignmentReduced(declared: Type, assigned: Type): Type {
    if (declared.kind === 'indexedAccess') {
      const constraint = this.c.baseConstraint(declared);
      if (constraint.kind === 'union') {
        const narrowed = this.assignmentReduced(constraint, assigned);
        if (narrowed !== constraint) return narrowed;
      }
    }
    if (declared.kind !== 'union') return declared;
    // As TypeScript's getAssignmentReducedType: the members any part of the assigned type may be, when the whole of it
    // fits them.
    const regular = regularOf(assigned);
    const parts = regular.kind === 'union' ? regular.types : [regular];
    const reduced = filterType(declared, (member) => parts.some((part) => this.c.relations.isAssignable(part, member)));
    if (isIntrinsic(reduced, 'never') || !this.c.relations.isAssignable(regular, reduced)) return declared;
    // A literal assigned to a union keeps its literal when the union lists literals, as `"a" | "b"` does.
    if (
      assigned.kind === 'literal' &&
      reduced.kind === 'union' &&
      reduced.types.some((member) => member.kind === 'literal')
    ) {
      return filterType(reduced, (member) => member.kind !== 'literal' || member.value === assigned.value);
    }
    return reduced === regular && assigned.kind === 'literal' && typeof assigned.value === 'boolean'
      ? assigned
      : reduced;
  }

  objectTypeOf(type: Type): ObjectType | undefined {
    return type.kind === 'object' ? type : undefined;
  }
}

const typeofTypes = new Map<string, Type>([
  ['string', stringType],
  ['number', numberType],
  ['bigint', bigintType],
  ['boolean', booleanType],
  ['symbol', symbolType],
  ['undefined', undefinedType],
]);

export function isUnit(type: Type): boolean {
  return type.kind === 'literal' || isUnitIntrinsic(type);
}

function isUnitIntrinsic(type: Type): boolean {
  return isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined') || isIntrinsic(type, 'void');
}

function sameUnit(a: Type, b: Type): boolean {
  if (a.kind === 'literal' && b.kind === 'literal') return a.value === b.value;
  if (isIntrinsic(a, 'void') || isIntrinsic(b, 'void'))
    return (
      isUnitIntrinsic(a) &&
      isUnitIntrinsic(b) &&
      (isIntrinsic(a, 'undefined') || isIntrinsic(b, 'undefined') || a === b)
    );
  return a === b;
}

export { trueType };

export function propertyReferenceKey(base: string, name: string): string {
  return `${base}.${name.replaceAll('%', '%25').replaceAll('.', '%2E')}`;
}
