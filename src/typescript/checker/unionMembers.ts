import type { Checker } from './checker';
import { applicableIndex } from './indexInfos';
import {
  type IndexInfo,
  literalType,
  type Property,
  simpleProperty,
  type Structure,
  type Type,
  unionOf,
} from './types';

/**
 * The members a generic type whose apparent type is a union reads, as TypeScript's `getPropertiesOfUnionOrIntersectionType`
 * gives them: each property and index signature every member has, of the union of their types.
 */
export function unionStructure(c: Checker, types: Type[]): Structure {
  const structures = types.map((member) => c.structureOf(member));
  const properties = new Map<string, Property>();
  for (const name of structures[0]?.properties.keys() ?? []) {
    const property = unionProperty(c, types, name);
    if (property) properties.set(name, property);
  }
  return {
    properties,
    callSignatures: [],
    constructSignatures: [],
    stringIndex: unitedIndex(structures.map((structure) => structure.stringIndex)),
    numberIndex: unitedIndex(structures.map((structure) => structure.numberIndex)),
    symbolIndex: unitedIndex(structures.map((structure) => structure.symbolIndex)),
  };
}

/**
 * A property every member of a union has, by its own declaration or an index signature, as TypeScript's
 * `createUnionOrIntersectionProperty` makes it: optional or read-only if it is in any member.
 */
export function unionProperty(c: Checker, types: Type[], name: string): Property | undefined {
  const properties: Property[] = [];
  for (const member of types) {
    const property = c.propertyOf(member, name) ?? indexProperty(c, member, name);
    if (!property) return undefined;
    properties.push(property);
  }
  const [first] = properties;
  // A private or protected property exists on a union only when every member has that same declaration.
  if (
    properties.some((property) => property.visibility !== 'public') &&
    properties.some((property) => !property.declaration || property.declaration.id !== first.declaration?.id)
  )
    return undefined;
  const hasWriteType = properties.some((property) => property.writeType !== undefined);
  return {
    ...first,
    optional: properties.some((property) => property.optional),
    readonly: properties.some((property) => property.readonly),
    isMethod: properties.every((property) => property.isMethod),
    type: () => unionOf(properties.map((property) => property.type())),
    writeType: hasWriteType
      ? () => unionOf(properties.map((property) => (property.writeType ?? property.type)()))
      : undefined,
  };
}

function indexProperty(c: Checker, member: Type, name: string): Property | undefined {
  const index = applicableIndex(c, c.structureOf(member), literalType(name));
  return index && simpleProperty(name, index.type, { readonly: index.readonly });
}

function unitedIndex(indexes: (IndexInfo | undefined)[]): IndexInfo | undefined {
  const present = indexes.filter((index) => index !== undefined);
  if (present.length < indexes.length) return undefined;
  return {
    type: unionOf(present.map((index) => index.type)),
    readonly: present.some((index) => index.readonly),
  };
}
