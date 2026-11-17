import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isNumericName, named, propertyNameText, skipParentheses } from './syntax';
import {
  anonymousObject,
  bigintType,
  booleanType,
  emptyStructure,
  falseType,
  filterType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  mapType,
  neverType,
  nonPrimitiveType,
  nullType,
  numberType,
  type ObjectType,
  simpleProperty,
  stringType,
  symbolType,
  trueType,
  type Type,
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
  /** While set, only the references it accepts narrow, and their keys are collected, as for an aliased condition. */
  narrowingScope?: { accepts: (node: TreeNode) => boolean; keys: Set<string> };
  /** `{}`, what `unknown` narrows to where it is neither `null` nor `undefined`. */
  private readonly emptyObject = anonymousObject(() => emptyStructure());

  constructor(private readonly c: Checker) {}

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
    const outer = this.current;
    this.current = state?.clone();
    try {
      run();
      return this.current;
    } finally {
      this.current = outer;
    }
  }

  get isReachable(): boolean {
    return this.current !== undefined;
  }

  entry(key: string): FlowEntry | undefined {
    return this.current?.entries.get(key);
  }

  set(key: string, entry: FlowEntry): void {
    if (!this.current) return;
    // tsc gives a reference assigned where no path reaches its declared type.
    if (this.current.dead && entry.assigned) this.current.entries.delete(key);
    else this.current.entries.set(key, entry);
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
    if (index.type === 'string' || index.type === 'number') return propertyNameText(index);
    if (index.type !== 'identifier') return undefined;
    const symbol = this.c.scopeOf(index).lookupValue(index.text);
    if (symbol?.valueKind !== 'const') return undefined;
    const type = this.c.silently(() => this.c.expressions.check(index));
    return type.kind === 'literal' && typeof type.value !== 'boolean' ? String(type.value) : undefined;
  }

  /** The key of a reference that narrowing applies to: a variable, `this`, or a property path of one. */
  // code-gauge-allow functionCognitiveComplexity 16 -- Builds distinct lexical, this, dotted, and literal-index references while preserving opaque property segments.
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
        return base ? propertyReferenceKey(base, property.text) : undefined;
      }
      case 'subscript_expression': {
        const object = expression.childForFieldName('object');
        const index = expression.childForFieldName('index');
        const name = index ? this.constantIndexName(index) : undefined;
        const base = object && name !== undefined ? this.referenceKey(object) : undefined;
        return base && name !== undefined ? propertyReferenceKey(base, name) : undefined;
      }
      default: {
        return undefined;
      }
    }
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
    // A value of a type parameter constrained to a union also narrows the constraint, which reading its members uses.
    const declaredConstraint = current.kind === 'typeParameter' ? this.c.constraintOf(current) : undefined;
    const constraint = entry?.constraint ?? (declaredConstraint?.kind === 'union' ? declaredConstraint : undefined);
    this.current.entries.set(key, {
      type: narrow(current),
      assigned: entry?.assigned ?? true,
      evolving: entry?.evolving,
      constraint: constraint && narrow(constraint),
    });
  }

  // Narrowing operations ----------------------------------------------------------------------------------------

  /** The part of a type that `typeof value === name` keeps (or, with `assumeTrue` false, that the opposite keeps). */
  // code-gauge-allow functionCognitiveComplexity 22 -- Follows TypeScript's narrowing of each kind of type by a `typeof` result.
  narrowByTypeof(type: Type, name: string, assumeTrue: boolean): Type {
    if (assumeTrue) {
      if (isAnyLike(type) || isIntrinsic(type, 'unknown')) {
        const narrowed = typeofTypes[name];
        if (narrowed) return narrowed();
        if (name === 'object') return unionOf([nonPrimitiveType, nullType]);
        if (name === 'function') return isAnyLike(type) ? type : this.c.globalType('Function');
        return type;
      }
      const kept = filterType(type, (member) => this.typeofMatches(member, name) !== false);
      return mapType(kept, (member) =>
        this.typeofMatches(member, name) === 'maybe' ? this.narrowMaybe(member, name) : member
      );
    }
    if (isAnyLike(type) || isIntrinsic(type, 'unknown')) return type;
    return filterType(type, (member) => this.typeofMatches(member, name) !== true);
  }

  private narrowMaybe(member: Type, name: string): Type {
    const narrowed =
      typeofTypes[name]?.() ??
      (name === 'function'
        ? this.c.globalType('Function')
        : name === 'object'
          ? unionOf([nonPrimitiveType, nullType])
          : undefined);
    if (!narrowed) return member;
    return member.kind === 'typeParameter' ? intersectionOf([member, narrowed], this.c.budget) : narrowed;
  }

  /** Whether `typeof` a value of the type gives `name`: always, never, or maybe. */
  // code-gauge-allow functionNcss 37 -- One case per `typeof` result.
  // code-gauge-allow functionCognitiveComplexity 16 -- One case per `typeof` result.
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
            return name === 'object' || name === 'function' ? 'maybe' : false;
          }
          default: {
            return 'maybe';
          }
        }
      }
      case 'object': {
        const isFunction =
          this.c.signaturesOf(type, 'call').length > 0 || this.c.signaturesOf(type, 'construct').length > 0;
        if (name === 'function') return isFunction;
        if (name === 'object') return !isFunction;
        return false;
      }
      case 'typeParameter': {
        const constraint = this.c.constraintOf(type);
        if (!constraint) return 'maybe';
        return this.typeofMatches(constraint, name) === false ? false : 'maybe';
      }
      default: {
        return 'maybe';
      }
    }
  }

  /** The part of a type that a truthy (or falsy) value has. */
  // code-gauge-allow functionCognitiveComplexity 28 -- Follows TypeScript's narrowing of each kind of type by truthiness.
  narrowByTruthiness(type: Type, assumeTrue: boolean): Type {
    if (assumeTrue) {
      if (isIntrinsic(type, 'unknown')) return this.emptyObject;
      return filterType(type, (member) => {
        if (isIntrinsic(member, 'null') || isIntrinsic(member, 'undefined') || isIntrinsic(member, 'void'))
          return false;
        if (member.kind === 'literal') return Boolean(member.value);
        return true;
      });
    }
    if (isAnyLike(type) || isIntrinsic(type, 'unknown')) return type;
    return mapType(type, (member) => {
      if (member.kind === 'literal') return member.value ? neverType : member;
      if (member.kind === 'object' || isIntrinsic(member, 'object') || isIntrinsic(member, 'symbol')) return neverType;
      if (member === booleanType) return falseType;
      return member;
    });
  }

  /** The part of a type that `value === other` (or `!==`) keeps, given the other operand's type. */
  narrowByEquality(type: Type, other: Type, assumeTrue: boolean, loose: boolean): Type {
    return assumeTrue ? this.narrowToEqual(type, other, loose) : this.narrowToUnequal(type, other, loose);
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Follows TypeScript's narrowing of each kind of type by equality.
  private narrowToEqual(type: Type, other: Type, loose: boolean): Type {
    const nullish = isIntrinsic(other, 'null') || isIntrinsic(other, 'undefined');
    if (loose && nullish) {
      return filterType(
        type,
        (member) =>
          isIntrinsic(member, 'null') ||
          isIntrinsic(member, 'undefined') ||
          isIntrinsic(member, 'void') ||
          isIntrinsic(member, 'unknown') ||
          isAnyLike(member)
      );
    }
    if (isAnyLike(type)) return type;
    if (isIntrinsic(type, 'unknown')) return isUnit(other) ? other : type;
    const filtered = filterType(type, (member) => this.c.relations.isComparable(member, other));
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
      if (loose) return this.emptyObject;
      return unionOf([this.emptyObject, isIntrinsic(other, 'null') ? undefinedType : nullType]);
    }
    if (loose && nullish) {
      return filterType(
        type,
        (member) => !isIntrinsic(member, 'null') && !isIntrinsic(member, 'undefined') && !isIntrinsic(member, 'void')
      );
    }
    return filterType(type, (member) => !(isUnit(member) && sameUnit(member, other)));
  }

  /** The part of a type that `value instanceof C` keeps, given the instance type of `C`. */
  narrowByInstanceof(type: Type, instance: Type, assumeTrue: boolean): Type {
    if (assumeTrue) {
      if (isAnyLike(type) || isIntrinsic(type, 'unknown')) return instance;
      const related = mapType(type, (member) =>
        this.isDerivedFrom(member, instance) ? member : this.isDerivedFrom(instance, member) ? instance : neverType
      );
      return isIntrinsic(related, 'never') ? instance : related;
    }
    return filterType(type, (member) => isAnyLike(member) || !this.isDerivedFrom(member, instance));
  }

  /**
   * Whether a type derives from a class's instance type, as TypeScript's `instanceof` narrowing decides by the base
   * classes, not by shape; a type that is not a class of the program, as a library one, is compared by its shape.
   */
  private isDerivedFrom(source: Type, target: Type): boolean {
    if (source.kind === 'union') return source.types.some((member) => this.isDerivedFrom(member, target));
    if (target.kind === 'union') return target.types.some((member) => this.isDerivedFrom(source, member));
    if (source.kind === 'typeParameter') {
      const constraint = this.c.constraintOf(source);
      return constraint !== undefined && this.isDerivedFrom(constraint, target);
    }
    const targetClass = target.kind === 'object' && !target.isClassStatic ? target.classInfo : undefined;
    if (!targetClass) return this.c.relations.isAssignable(source, target);
    let info = source.kind === 'object' && !source.isClassStatic ? source.classInfo : undefined;
    for (; info; info = this.c.classes.baseClassInfo(info))
      if (info.declaration.id === targetClass.declaration.id) return true;
    return false;
  }

  /** The part of a type that `name in value` keeps, as TypeScript's `narrowTypeByInKeyword` decides. */
  narrowByIn(type: Type, name: string, assumeTrue: boolean): Type {
    if (isAnyLike(type)) return type;
    const members = type.kind === 'union' ? type.types : [type];
    if (members.some((member) => this.isPresencePossible(member, name, true)))
      return filterType(type, (member) => this.isPresencePossible(member, name, assumeTrue));
    if (!assumeTrue) return type;
    // A type that no member declares the property in gains it as `unknown`, as `object` becomes `object & Record<"a", unknown>`.
    return intersectionOf(
      [
        type,
        anonymousObject(() => ({
          ...emptyStructure(),
          properties: new Map([[name, simpleProperty(name, unknownType)]]),
        })),
      ],
      this.c.budget
    );
  }

  /** Whether a value of a type may have (or, with `assumeTrue` false, lack) a property, as its members and index signatures say. */
  private isPresencePossible(type: Type, name: string, assumeTrue: boolean): boolean {
    const property = this.c.propertyOf(type, name);
    if (property) return property.optional || assumeTrue;
    const { stringIndex, numberIndex } = this.c.structureOf(type);
    return stringIndex !== undefined || (numberIndex !== undefined && isNumericName(name)) || !assumeTrue;
  }

  /** The members of a union whose property `name` may be `value`, as `x.kind === "a"` narrows `x`. */
  narrowByDiscriminant(type: Type, name: string, narrow: (propertyType: Type) => Type): Type {
    return filterType(type, (member) => {
      if (member.kind !== 'object' && member.kind !== 'intersection') return true;
      const property = this.c.propertyOf(member, name);
      if (!property) return true;
      const propertyType = property.optional ? unionOf([property.type(), undefinedType]) : property.type();
      return !isIntrinsic(narrow(propertyType), 'never');
    });
  }

  /** Whether a union's property is a discriminant: some member has a literal type for it. */
  isDiscriminant(type: Type, name: string): boolean {
    if (type.kind !== 'union') return false;
    return type.types.some((member) => {
      if (member.kind !== 'object') return false;
      const property = this.c.propertyOf(member, name);
      if (!property) return false;
      const propertyType = property.type();
      return (propertyType.kind === 'union' ? propertyType.types : [propertyType]).some((part) => isUnit(part));
    });
  }

  /** The type of a variable after assigning `assigned` to it when it is declared as `declared`. */
  assignmentReduced(declared: Type, assigned: Type): Type {
    if (declared.kind !== 'union') {
      return declared;
    }
    const reduced = filterType(declared, (member) => this.c.relations.isAssignable(assigned, member));
    if (isIntrinsic(reduced, 'never')) return declared;
    // A literal assigned to a union keeps its literal when the union lists literals, as `"a" | "b"` does.
    if (
      assigned.kind === 'literal' &&
      reduced.kind === 'union' &&
      reduced.types.some((member) => member.kind === 'literal')
    ) {
      return filterType(reduced, (member) => member.kind !== 'literal' || member.value === assigned.value);
    }
    if (assigned.kind === 'union') {
      return filterType(reduced, (member) =>
        assigned.types.some((part) => this.c.relations.isAssignable(part, member))
      );
    }
    return reduced;
  }

  objectTypeOf(type: Type): ObjectType | undefined {
    return type.kind === 'object' ? type : undefined;
  }
}

const typeofTypes: Record<string, () => Type> = {
  string: () => stringType,
  number: () => numberType,
  bigint: () => bigintType,
  boolean: () => booleanType,
  symbol: () => symbolType,
  undefined: () => undefinedType,
};

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
