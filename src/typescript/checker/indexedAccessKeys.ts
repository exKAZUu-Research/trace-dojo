import type { Checker } from './checker';
import { applicablePatternIndexes, isNumericStringKey } from './indexInfos';
import {
  type ConditionalType,
  intersectionOf,
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

/** The indexed type parameter and what stands for it along the path to a key. */
interface KeyContext {
  object: TypeParameter;
  constraints: Type[];
  extendsTypes: ExtendsTypes;
  visited: Set<number>;
}

/** Decides which keys may index a type parameter, as TypeScript's TS2536 does for an indexed access type. */
export class IndexedAccessKeys {
  constructor(private readonly c: Checker) {}

  /**
   * Whether `key` may name a key that none of the types `object` stands for has: its constraint, where `T extends any`
   * is as unconstrained as `T`, and the types conditional types narrow it to.
   */
  isInvalid(object: TypeParameter, key: Type, extendsTypes: ExtendsTypes): boolean {
    const context = {
      object,
      constraints: constraintsOf(this.c, object, extendsTypes),
      extendsTypes,
      visited: new Set<number>(),
    };
    return this.isInvalidKey(context, key, true);
  }

  /**
   * A type parameter key is valid when one of its constraints is, and `keyof X` when `object` stands for a subtype of `X`.
   * Only a key written as a union member of the index, not one a constraint gives, indexes a number index signature by
   * a numeric string, as TypeScript tests only the index's own members for that.
   */
  private isInvalidKey(context: KeyContext, key: Type, written: boolean): boolean {
    const next = (member: Type): boolean => this.isInvalidKey(context, member, written);
    const isMissing = (): boolean => !context.constraints.some((constraint) => this.hasKey(constraint, key, written));
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
        const constraint = this.stringKeyConstraint(key, context.extendsTypes);
        return constraint === key ? isMissing() : this.isInvalidKey(context, constraint, false);
      }
      case 'conditional': {
        return this.isInvalidConditional(context, key);
      }
      case 'object': {
        return true;
      }
      case 'keyof': {
        return (
          key.type.id !== context.object.id &&
          !context.constraints.some((constraint) => this.c.relations.isAssignable(constraint, key.type))
        );
      }
      case 'typeParameter': {
        return this.isInvalidParameterKey(context, key);
      }
      default: {
        return false;
      }
    }
  }

  /** A type parameter key is invalid when each of its constraints is; one met again on the same path adds nothing. */
  private isInvalidParameterKey(context: KeyContext, key: TypeParameter): boolean {
    const { visited } = context;
    if (visited.has(key.id)) return false;
    visited.add(key.id);
    try {
      return constraintsOf(this.c, key, context.extendsTypes).every((member) =>
        this.isInvalidKey(context, member, false)
      );
    } finally {
      visited.delete(key.id);
    }
  }

  /**
   * A conditional key is valid when both branches are, the true one seeing its check type narrowed to the extends type,
   * or else, when it distributes, when it is valid for each type its check type's constraint may stand for.
   */
  private isInvalidConditional(context: KeyContext, key: ConditionalType): boolean {
    const { checkType } = key;
    const trueExtendsTypes: ExtendsTypes = (parameter) =>
      parameter.id === checkType.id
        ? [...context.extendsTypes(parameter), key.extendsType]
        : context.extendsTypes(parameter);
    if (
      !this.isInvalidKey({ ...context, extendsTypes: trueExtendsTypes }, key.trueType, false) &&
      !this.isInvalidKey(context, key.falseType, false)
    )
      return false;
    const checkConstraint = checkType.kind === 'typeParameter' ? this.c.constraintOf(checkType) : undefined;
    if (!key.distributive || !checkConstraint) return true;
    const distributed = this.c.instantiate(key, new Map([[checkType.id, checkConstraint]]));
    return (
      isIntrinsic(distributed, 'never') ||
      distributed.kind === 'conditional' ||
      this.isInvalidKey(context, distributed, false) ||
      this.subtypeTrueBranches(key, checkConstraint).some((branch) => this.isInvalidKey(context, branch, false))
    );
  }

  /**
   * The true branches a conditional takes for subtypes of a member of its check type's constraint that it does not
   * take for the member itself, as for `K extends "b" ? K : "a"` with `K extends string`, where `K` may be `"b"`.
   */
  private subtypeTrueBranches(key: ConditionalType, checkConstraint: Type): Type[] {
    const members = checkConstraint.kind === 'union' ? checkConstraint.types : [checkConstraint];
    return members.flatMap((member) => {
      const mapper = new Map([[key.checkType.id, member]]);
      const extendsType = this.c.instantiate(key.extendsType, mapper);
      const extendsMembers = extendsType.kind === 'union' ? extendsType.types : [extendsType];
      return !this.c.relations.isAssignable(member, extendsType) &&
        extendsMembers.some((extendsMember) => this.c.relations.isAssignable(extendsMember, member))
        ? [this.c.instantiate(key.trueType, mapper)]
        : [];
    });
  }

  /**
   * A template literal or string mapping key with its type parameters replaced by their constraints, narrowed by the
   * conditional types around it.
   */
  private stringKeyConstraint(key: Type, extendsTypes: ExtendsTypes): Type {
    const mapper = new Map<number, Type>();
    const collect = (type: Type): void => {
      if (type.kind === 'typeParameter')
        mapper.set(type.id, intersectionOf([this.c.baseConstraint(type), ...extendsTypes(type)], this.c));
      else if (type.kind === 'templateLiteral') for (const member of type.types) collect(member);
      else if (type.kind === 'stringMapping') collect(type.type);
    };
    collect(key);
    return this.c.instantiate(key, mapper);
  }

  /**
   * Whether `key`, a literal, a primitive key type, or a template literal or string mapping without type parameters, is
   * assignable to `keyof type`, or, when `written`, indexes its number index signature. Visited types are tracked per
   * path, so a member shared by sibling alternatives keeps its answer, which one lookup remembers for every path.
   */
  private hasKey(
    type: Type,
    key: Type,
    written: boolean,
    path = new Set<number>(),
    answers = new Map<number, boolean>()
  ): boolean {
    if (isAnyLike(type) || isIntrinsic(type, 'never')) return true;
    const known = answers.get(type.id);
    if (known !== undefined) return known;
    if (path.has(type.id)) return false;
    this.c.budget.spend();
    path.add(type.id);
    try {
      const result = this.hasKeyOnPath(type, key, written, path, answers);
      answers.set(type.id, result);
      return result;
    } finally {
      path.delete(type.id);
    }
  }

  private hasKeyOnPath(
    type: Type,
    key: Type,
    written: boolean,
    path: Set<number>,
    answers: Map<number, boolean>
  ): boolean {
    const next = (member: Type): boolean => this.hasKey(member, key, written, path, answers);
    if (type.kind === 'union') return type.types.every(next);
    if (type.kind === 'intersection') return type.types.some(next);
    if (type.kind !== 'object') {
      if (type.kind === 'intrinsic' && ['unknown', 'null', 'undefined', 'void', 'object'].includes(type.name))
        return false;
      const constraint = this.c.relations.isGeneric(type) ? this.c.baseConstraint(type) : this.c.apparentType(type);
      return constraint !== type && next(constraint);
    }
    return this.structureHasKey(type, key, written);
  }

  private structureHasKey(type: Type, key: Type, written: boolean): boolean {
    const structure = this.c.structureOf(type);
    const name = key.kind === 'literal' ? key.value : undefined;
    if (isIntrinsic(key, 'symbol') || typeof name === 'symbol')
      return structure.symbolIndex !== undefined || (key.kind === 'literal' && this.propertyHasKey(structure, key));
    if (structure.stringIndex || applicablePatternIndexes(this.c, structure, key).length > 0) return true;
    if (structure.numberIndex && (isIntrinsic(key, 'number') || typeof name === 'number')) return true;
    if (structure.numberIndex && written && isNumericStringKey(key)) return true;
    return key.kind === 'literal' && this.propertyHasKey(structure, key);
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
