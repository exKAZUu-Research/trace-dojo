import type { Checker } from './checker';
import { isNumericName } from './syntax';
import {
  type ConditionalType,
  isAnyLike,
  isIntrinsic,
  type LiteralType,
  type Structure,
  type Type,
  type TypeParameter,
  unknownType,
} from './types';

/** The types that the conditional types around an indexed access check a type parameter against. */
type ExtendsTypes = (parameter: TypeParameter) => Type[];

/** Decides which keys may index a type parameter, as TypeScript's TS2536 does for an indexed access type. */
export class IndexedAccessKeys {
  constructor(private readonly c: Checker) {}

  /**
   * Whether `key` may name a key that none of the types `object` stands for has: its constraint, where `T extends any`
   * is as unconstrained as `T`, and the types conditional types narrow it to.
   */
  isInvalid(object: TypeParameter, key: Type, extendsTypes: ExtendsTypes): boolean {
    return this.isInvalidKey(object, constraintsOf(this.c, object, extendsTypes), key, extendsTypes, new Set());
  }

  /** A type parameter key is valid when one of its constraints is, and `keyof X` when `object` stands for a subtype of `X`. */
  private isInvalidKey(
    object: TypeParameter,
    constraints: Type[],
    key: Type,
    extendsTypes: ExtendsTypes,
    visited: Set<number>
  ): boolean {
    const next = (member: Type): boolean => this.isInvalidKey(object, constraints, member, extendsTypes, visited);
    const isMissing = (): boolean => !constraints.some((constraint) => this.hasKey(constraint, key));
    switch (key.kind) {
      case 'union': {
        return key.types.some(next);
      }
      case 'intersection': {
        return key.types.every(next);
      }
      case 'literal': {
        return !['string', 'number', 'symbol'].includes(typeof key.value) || isMissing();
      }
      case 'intrinsic': {
        if (key.name === 'any' || key.name === 'never') return false;
        return !['string', 'number', 'symbol'].includes(key.name) || isMissing();
      }
      case 'templateLiteral':
      case 'stringMapping': {
        const constraint = this.stringKeyConstraint(key);
        return constraint === key ? isMissing() : next(constraint);
      }
      case 'conditional': {
        return this.isInvalidConditional(object, constraints, key, extendsTypes, visited);
      }
      case 'object': {
        return true;
      }
      case 'keyof': {
        return (
          key.type.id !== object.id &&
          !constraints.some((constraint) => this.c.relations.isAssignable(constraint, key.type))
        );
      }
      case 'typeParameter': {
        return this.isInvalidParameterKey(key, extendsTypes, visited, next);
      }
      default: {
        return false;
      }
    }
  }

  /** A type parameter key is invalid when each of its constraints is; one met again on the same path adds nothing. */
  private isInvalidParameterKey(
    key: TypeParameter,
    extendsTypes: ExtendsTypes,
    visited: Set<number>,
    next: (member: Type) => boolean
  ): boolean {
    if (visited.has(key.id)) return false;
    visited.add(key.id);
    try {
      return constraintsOf(this.c, key, extendsTypes).every(next);
    } finally {
      visited.delete(key.id);
    }
  }

  /**
   * A conditional key is valid when both branches are, the true one seeing its check type narrowed to the extends type,
   * or else, when it distributes, when it is valid for the constraint of its check type.
   */
  private isInvalidConditional(
    object: TypeParameter,
    constraints: Type[],
    key: ConditionalType,
    extendsTypes: ExtendsTypes,
    visited: Set<number>
  ): boolean {
    const { checkType } = key;
    const trueExtendsTypes: ExtendsTypes = (parameter) =>
      parameter.id === checkType.id ? [...extendsTypes(parameter), key.extendsType] : extendsTypes(parameter);
    if (
      !this.isInvalidKey(object, constraints, key.trueType, trueExtendsTypes, visited) &&
      !this.isInvalidKey(object, constraints, key.falseType, extendsTypes, visited)
    )
      return false;
    const checkConstraint = checkType.kind === 'typeParameter' ? this.c.constraintOf(checkType) : undefined;
    if (!key.distributive || !checkConstraint) return true;
    const distributed = this.c.instantiate(key, new Map([[checkType.id, checkConstraint]]));
    return (
      isIntrinsic(distributed, 'never') ||
      distributed.kind === 'conditional' ||
      this.isInvalidKey(object, constraints, distributed, extendsTypes, visited)
    );
  }

  /** A template literal or string mapping key with its type parameters replaced by their constraints. */
  private stringKeyConstraint(key: Type): Type {
    const mapper = new Map<number, Type>();
    const collect = (type: Type): void => {
      if (type.kind === 'typeParameter') mapper.set(type.id, this.c.baseConstraint(type));
      else if (type.kind === 'templateLiteral') for (const member of type.types) collect(member);
      else if (type.kind === 'stringMapping') collect(type.type);
    };
    collect(key);
    return this.c.instantiate(key, mapper);
  }

  /**
   * Whether `key`, a literal, a primitive key type, or a template literal or string mapping without type parameters, is
   * assignable to `keyof type`. Visited types are tracked per path, so a member shared by sibling alternatives keeps its
   * answer, which one lookup remembers for every path.
   */
  private hasKey(type: Type, key: Type, path = new Set<number>(), answers = new Map<number, boolean>()): boolean {
    if (isAnyLike(type) || isIntrinsic(type, 'never')) return true;
    const known = answers.get(type.id);
    if (known !== undefined) return known;
    if (path.has(type.id)) return false;
    this.c.budget.spend();
    path.add(type.id);
    try {
      const result = this.hasKeyOnPath(type, key, path, answers);
      answers.set(type.id, result);
      return result;
    } finally {
      path.delete(type.id);
    }
  }

  private hasKeyOnPath(type: Type, key: Type, path: Set<number>, answers: Map<number, boolean>): boolean {
    const next = (member: Type): boolean => this.hasKey(member, key, path, answers);
    if (type.kind === 'union') return type.types.every(next);
    if (type.kind === 'intersection') return type.types.some(next);
    if (type.kind !== 'object') {
      if (type.kind === 'intrinsic' && ['unknown', 'null', 'undefined', 'void', 'object'].includes(type.name))
        return false;
      const constraint = this.c.relations.isGeneric(type) ? this.c.baseConstraint(type) : this.c.apparentType(type);
      return constraint !== type && next(constraint);
    }
    return this.structureHasKey(type, key);
  }

  private structureHasKey(type: Type, key: Type): boolean {
    const structure = this.c.structureOf(type);
    const name = key.kind === 'literal' ? key.value : undefined;
    if (isIntrinsic(key, 'symbol') || typeof name === 'symbol')
      return structure.symbolIndex !== undefined || (key.kind === 'literal' && this.propertyHasKey(structure, key));
    if (structure.stringIndex) return true;
    if (key.kind !== 'literal') return isNumberLikeKey(key) && structure.numberIndex !== undefined;
    if (typeof name !== 'string' && typeof name !== 'number') return false;
    if (structure.numberIndex && (typeof name === 'number' || isNumericName(name))) return true;
    return this.propertyHasKey(structure, key);
  }

  /**
   * Whether a property is named by a literal key: by its name type when a mapped type gives it one, which may hold
   * keys of both kinds, as `0 | "0"`, else by whether its name is written as a number.
   */
  private propertyHasKey(structure: Structure, key: LiteralType): boolean {
    const property = structure.properties.get(String(key.value));
    if (!property?.nameType)
      return property !== undefined && (typeof key.value === 'number') === this.c.typeOperators.isNumericKey(property);
    return (property.nameType.kind === 'union' ? property.nameType.types : [property.nameType]).some(
      (member) => member.kind === 'literal' && member.value === key.value
    );
  }
}

function constraintsOf(c: Checker, parameter: TypeParameter, extendsTypes: ExtendsTypes): Type[] {
  const constraint = c.constraintOf(parameter);
  return [constraint && !isIntrinsic(constraint, 'any') ? constraint : unknownType, ...extendsTypes(parameter)];
}

/** Whether a key may index a number index signature: `number` or `` `${number}` ``. */
function isNumberLikeKey(key: Type): boolean {
  return (
    isIntrinsic(key, 'number') ||
    (key.kind === 'templateLiteral' && key.texts.every((text) => text === '') && isIntrinsic(key.types[0], 'number'))
  );
}
