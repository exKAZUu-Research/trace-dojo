import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { named, skipParentheses } from './syntax';
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
    readonly assignedFields = new Set<string>()
  ) {}

  clone(): FlowState {
    return new FlowState(new Map(this.entries), new Set(this.assignedFields));
  }
}

export type State = FlowState | undefined;

/** The flow of a program's control, which narrows its references and tracks its assignments. */
export class Flow {
  current: State = new FlowState();
  /** `{}`, what `unknown` narrows to where it is neither `null` nor `undefined`. */
  private readonly emptyObject = anonymousObject(() => emptyStructure());

  constructor(private readonly c: Checker) {}

  merge(states: State[]): State {
    const reachable = states.filter((state): state is FlowState => state !== undefined);
    if (reachable.length === 0) return undefined;
    if (reachable.length === 1) return reachable[0].clone();
    const merged = new FlowState();
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
        type: unionOf(defined.map((entry) => entry.type)),
        assigned: defined.every((entry) => entry.assigned),
        evolving: defined.some((entry) => entry.evolving),
        constraint: defined.every((entry) => entry.constraint)
          ? unionOf(defined.map((entry) => entry.constraint as Type))
          : undefined,
      });
    }
    return merged;
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
    this.current.entries.set(key, entry);
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
  private constantIndexName(index: TreeNode): string | undefined {
    if (index.type === 'string') return named(index)[0]?.text ?? '';
    if (index.type === 'number') return index.text;
    if (index.type !== 'identifier') return undefined;
    const symbol = this.c.scopeOf(index).lookupValue(index.text);
    if (symbol?.valueKind !== 'const') return undefined;
    const type = this.c.silently(() => this.c.expressions.check(index));
    return type.kind === 'literal' && typeof type.value !== 'boolean' ? String(type.value) : undefined;
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
        return base ? `${base}.${property.text}` : undefined;
      }
      case 'subscript_expression': {
        const object = expression.childForFieldName('object');
        const index = expression.childForFieldName('index');
        const name = index ? this.constantIndexName(index) : undefined;
        const base = object && name !== undefined ? this.referenceKey(object) : undefined;
        return base ? `${base}.${name}` : undefined;
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
    const narrowed = typeofTypes[name];
    if (narrowed) return narrowed();
    if (name === 'function') return member;
    return member;
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
      const filtered = filterType(type, (member) => this.c.relations.isAssignable(member, instance));
      if (filtered.kind !== 'intrinsic' || filtered.name !== 'never') return filtered;
      const candidates = filterType(type, (member) => this.c.relations.isAssignable(instance, member));
      if (!isIntrinsic(candidates, 'never')) return mapType(candidates, () => instance);
      return instance;
    }
    return filterType(type, (member) => !this.c.relations.isAssignable(member, instance) || isAnyLike(member));
  }

  /** The part of a type that `"name" in value` keeps. */
  narrowByIn(type: Type, name: string, assumeTrue: boolean): Type {
    if (isAnyLike(type)) return type;
    // A type that does not declare the property gains it as `unknown`, as `object` becomes `object & Record<"a", unknown>`.
    if (
      assumeTrue &&
      type.kind !== 'union' &&
      !this.c.propertyOf(type, name) &&
      !this.c.structureOf(type).stringIndex
    ) {
      return intersectionOf([
        type,
        anonymousObject(() => ({
          ...emptyStructure(),
          properties: new Map([[name, simpleProperty(name, unknownType)]]),
        })),
      ]);
    }
    return filterType(type, (member) => {
      if (member.kind !== 'object' && member.kind !== 'intersection') return assumeTrue;
      const property = this.c.propertyOf(member, name);
      if (!property) {
        const structure = this.c.structureOf(member);
        if (structure.stringIndex) return true;
        return !assumeTrue;
      }
      return assumeTrue || property.optional;
    });
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
