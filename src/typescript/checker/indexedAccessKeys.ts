import type { Checker, Mapper } from './checker';
import { conditionalBranch, typeParametersIn } from './genericTypes';
import { applicablePatternIndexes, isNumericStringKey } from './indexInfos';
import {
  type ConditionalType,
  errorType,
  type IndexedAccessType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  type LiteralType,
  type MappedInfo,
  type ObjectType,
  type Structure,
  type Type,
  typeMembers,
  type TypeParameter,
  unionOf,
  unknownType,
} from './types';

/** The types an enclosing conditional establishes for a receiver or a key. */
type ExtendsTypes = (type: Type) => Type[];

/** The indexed type parameter and what stands for it along the path to a key. */
interface KeyContext {
  object: Type;
  constraints: Type[];
  extendsTypes: ExtendsTypes;
  visited: Set<number>;
}

export function narrowIndexedOperands(
  c: Checker,
  parameters: Mapper,
  checked: readonly (readonly [Type, Type])[]
): (type: Type) => Type {
  const cache = new Map<Type, Type>();
  const narrow = (type: Type): Type => {
    const existing = cache.get(type);
    if (existing) return existing;
    c.budget.spend();
    cache.set(type, type);
    const selected = narrowOperand(c, type, narrow, parameters);
    const bounds = checked.flatMap(([test, bound]) =>
      test.kind === type.kind && c.relations.identical(test, type) ? [c.instantiate(bound, parameters)] : []
    );
    if (selected !== type) bounds.push(selected);
    const narrowed = bounds.length > 0 ? intersectionOf(bounds, c) : type;
    cache.set(type, narrowed);
    return narrowed;
  };
  return narrow;
}

export function narrowKeyConstraints(c: Checker, narrow: (type: Type) => Type): (type: Type) => Type {
  const cache = new Map<Type, Type>();
  const project = (type: Type): Type => {
    if (type.kind === 'keyof' || type.kind === 'templateLiteral') return narrow(type);
    if (type.kind !== 'union' && type.kind !== 'intersection') return type;
    const existing = cache.get(type);
    if (existing) return existing;
    c.budget.spend();
    cache.set(type, type);
    const bound = narrowComposite(c, type, project);
    cache.set(type, bound);
    return bound;
  };
  return project;
}

function narrowOperand(c: Checker, type: Type, narrow: (type: Type) => Type, parameters: Mapper): Type {
  switch (type.kind) {
    case 'typeParameter': {
      return parameters.get(type.id) ?? type;
    }
    case 'object': {
      return type.mapped ? narrowMappedOperand(c, type, type.mapped, narrow) : type;
    }
    case 'keyof': {
      const object = narrow(type.type);
      return object === type.type ? type : c.typeOperators.keyofType(object);
    }
    case 'indexedAccess': {
      return narrowIndexedProjection(c, type, narrow);
    }
    case 'conditional': {
      const trueType = type.trueType;
      const falseType = type.falseType;
      const yes = narrow(trueType);
      const no = narrow(falseType);
      return yes === trueType && no === falseType ? type : unionOf([yes, no]);
    }
    case 'templateLiteral': {
      const members = type.types.map(narrow);
      return members.every((member, index) => member === type.types[index])
        ? type
        : c.typeOperators.templateLiteral(type.texts, members);
    }
    case 'union':
    case 'intersection': {
      return narrowComposite(c, type, narrow);
    }
    default: {
      return type;
    }
  }
}

function narrowComposite(
  c: Checker,
  type: Extract<Type, { kind: 'union' | 'intersection' }>,
  narrow: (type: Type) => Type
): Type {
  const members = type.types.map(narrow);
  if (members.every((member, index) => member === type.types[index])) return type;
  return type.kind === 'union' ? unionOf(members) : intersectionOf(members, c);
}

function narrowIndexedProjection(c: Checker, access: IndexedAccessType, narrow: (type: Type) => Type): Type {
  const { objectType, indexType } = access;
  const object = narrow(objectType);
  const key = narrow(indexType);
  if (object === objectType && key === indexType) return access;
  const selected = c.typeOperators.indexedAccess(object, key);
  return selected === errorType ? access : selected;
}

function narrowMappedOperand(c: Checker, type: Type, mapped: MappedInfo, narrow: (type: Type) => Type): Type {
  const source = mapped.source && narrow(mapped.source);
  const constraint = narrow(mapped.constraint);
  const nameType = mapped.nameType && narrow(mapped.nameType);
  if (source === mapped.source && constraint === mapped.constraint && nameType === mapped.nameType) return type;
  return c.typeOperators.mappedType({
    typeParameter: mapped.typeParameter,
    homomorphic: mapped.homomorphic,
    readonlyModifier: mapped.readonlyModifier,
    optionalModifier: mapped.optionalModifier,
    source,
    constraint,
    nameType,
    get template() {
      return narrow(mapped.template);
    },
  });
}

export class IndexedAccessKeys {
  constructor(private readonly c: Checker) {}

  hasUnresolvedMappedKeys(info: MappedInfo): boolean {
    const { nameType, source, typeParameter } = info;
    const knownReference =
      info.homomorphic && source?.kind === 'object' && source.resolveReference && !this.c.isArrayOrTuple(source);
    if (knownReference) return !!nameType && typeParametersIn(nameType, [typeParameter], this.c.budget).length > 0;
    if (this.c.relations.isGeneric(info.constraint)) return true;
    if (!nameType || !this.c.relations.isGeneric(nameType)) return false;
    return typeMembers(info.constraint).some((key) =>
      this.c.relations.isGeneric(this.c.instantiate(nameType, new Map([[typeParameter.id, key]])))
    );
  }

  isInvalidWrittenKey(object: Type, key: Type, narrow: (type: Type) => Type): boolean {
    return this.isInvalid(object, key, (type) => {
      const bound = narrow(type);
      return bound === type ? [] : [bound];
    });
  }

  isVariadicTupleKey(object: ObjectType, index: Type, narrow?: (type: Type) => Type): boolean {
    const keys = this.c.typeOperators.keyofType(object);
    const matches = (type: Type): boolean =>
      typeMembers(type).every((key) => isNumericStringKey(key) || this.c.relations.isAssignable(key, keys));
    return matches(index) || (!!narrow && matches(narrow(index)));
  }

  isMappedKey(index: Type, keys: Type, narrow?: (type: Type) => Type): boolean {
    return this.matchesMappedKey(index, keys) || (!!narrow && this.matchesMappedKey(narrow(index), narrow(keys)));
  }

  private matchesMappedKey(index: Type, keys: Type): boolean {
    if (this.c.relations.isAssignable(index, keys)) return true;
    if (index.kind === 'union') return index.types.every((member) => this.matchesMappedKey(member, keys));
    if (keys.kind === 'union') return keys.types.some((member) => this.matchesMappedKey(index, member));
    if (keys.kind === 'keyof' && keys.type.kind === 'typeParameter') return !this.isInvalid(keys.type, index, () => []);
    return (
      keys.kind === 'conditional' &&
      !this.c.relations.isGeneric(keys.extendsType) &&
      isIntrinsic(keys.trueType, 'never') &&
      this.c.relations.identical(keys.checkType, keys.falseType) &&
      conditionalBranch(this.c, index, keys.extendsType) === 'false' &&
      this.matchesMappedKey(index, keys.checkType)
    );
  }

  /**
   * Whether `key` may name a key that none of the types `object` stands for has: its constraint, where `T extends any`
   * is as unconstrained as `T`, and the types conditional types narrow it to.
   */
  private isInvalid(object: Type, key: Type, extendsTypes: ExtendsTypes): boolean {
    if (
      object.kind === 'object' &&
      object.mapped &&
      this.c.relations.isAssignable(key, this.c.typeOperators.keyofType(object))
    )
      return false;
    const context = {
      object,
      constraints:
        object.kind === 'typeParameter'
          ? constraintsOf(this.c, object, extendsTypes)
          : [object, ...extendsTypes(object)],
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
      case 'indexedAccess': {
        return this.isInvalidIndexedKey(context, key);
      }
      default: {
        return false;
      }
    }
  }

  private isInvalidIndexedKey(context: KeyContext, key: IndexedAccessType): boolean {
    if (context.visited.has(key.id)) return true;
    context.visited.add(key.id);
    try {
      if (context.extendsTypes(key).some((bound) => !this.isInvalidKey(context, bound, false))) return false;
      const constraint = this.c.baseConstraint(key);
      if (constraint !== key) return this.isInvalidKey(context, constraint, false);
      return context.constraints.every(
        (object) => !this.c.relations.isAssignable(key, this.c.typeOperators.keyofType(object))
      );
    } finally {
      context.visited.delete(key.id);
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
    return (
      this.structureHasKey(type, key, written) ||
      (!!type.mapped && this.c.relations.isAssignable(key, this.c.typeOperators.guaranteedKeys(type)))
    );
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
