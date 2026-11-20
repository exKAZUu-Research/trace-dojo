import type { Checker } from './checker';
import {
  intersectionOf,
  type IntersectionType,
  isDiscriminantLiteral,
  isIntrinsic,
  neverType,
  type Property,
  propertyAccessType,
  type Type,
  unionOf,
} from './types';

export class ReducedTypes {
  private readonly cache = new WeakMap<Type, Type>();

  constructor(private readonly c: Checker) {}

  of(type: Type): Type {
    if (type.kind !== 'union' && type.kind !== 'intersection') return type;
    const previous = this.cache.get(type);
    if (previous) return previous;
    this.cache.set(type, type);
    const reduced = type.kind === 'intersection' ? this.reduceIntersection(type) : this.reduceUnion(type);
    this.cache.set(type, reduced);
    return reduced;
  }

  private reduceUnion(type: Extract<Type, { kind: 'union' }>): Type {
    this.c.budget.spend(type.types.length);
    const members = type.types.map((member) => (member.kind === 'intersection' ? this.of(member) : member));
    return members.some((member, index) => member !== type.types[index]) ? unionOf(members) : type;
  }

  private reduceIntersection(type: IntersectionType): Type {
    const objects = type.types.filter((member) => member.kind === 'object');
    if (objects.length < 2) return type;
    const properties = new Map<string, Property[]>();
    for (const object of objects) {
      for (const [key, property] of object.resolve().properties) {
        this.c.budget.spend();
        const group = properties.get(key);
        if (group) group.push(property);
        else properties.set(key, [property]);
      }
    }
    for (const group of properties.values()) {
      if (group.length > 1 && this.hasConflictingDiscriminant(group)) return neverType;
    }
    return type;
  }

  private hasConflictingDiscriminant(properties: Property[]): boolean {
    if (properties.every((property) => property.optional)) return false;
    const types = properties.map((property) => propertyAccessType(property));
    return (
      types.some(isDiscriminantLiteral) &&
      !types.some((member) => isIntrinsic(member, 'never')) &&
      isIntrinsic(intersectionOf(types, this.c.budget), 'never')
    );
  }
}
