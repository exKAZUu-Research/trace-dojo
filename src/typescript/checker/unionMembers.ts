import type { Checker } from './checker';
import { applicableIndex, isSameKeyType } from './indexInfos';
import { tupleElementBeyond } from './tupleIndexes';
import {
  type IndexInfo,
  isPropertyKeyLiteral,
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
    patternIndexes: structures[0]?.patternIndexes?.flatMap((pattern) => {
      const index = unitedIndex(
        structures.map((structure) =>
          structure.patternIndexes?.find((other) => isSameKeyType(pattern.keyType, other.keyType))
        )
      );
      return index ? [{ ...index, keyType: pattern.keyType }] : [];
    }),
  };
}

/**
 * A property every member of a union has, by its own declaration or an index signature, as TypeScript's
 * `createUnionOrIntersectionProperty` makes it: optional or read-only if it is in any member.
 */
export function unionProperty(c: Checker, types: Type[], name: string): Property | undefined {
  const declared = types.map((member) => c.propertyOf(member, name));
  const first = declared.find((property) => property !== undefined);
  if (!first) return undefined;
  const key = first.nameType;
  const isSymbol = key && isPropertyKeyLiteral(key) && typeof key.value === 'symbol';
  const properties: Property[] = [];
  for (const [position, member] of types.entries()) {
    const property = declared[position] ?? (isSymbol ? undefined : indexProperty(c, member, name));
    if (!property) return undefined;
    properties.push(property);
  }
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
    exactOptionalType: properties.every((property) => !property.optional || property.exactOptionalType)
      ? true
      : undefined,
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
  if (!index) return undefined;
  const type = tupleElementBeyond(c, member, name, undefined) ?? index.type;
  return simpleProperty(name, type, { readonly: index.readonly });
}

function unitedIndex(indexes: (IndexInfo | undefined)[]): IndexInfo | undefined {
  const present = indexes.filter((index) => index !== undefined);
  if (present.length < indexes.length) return undefined;
  return {
    type: unionOf(present.map((index) => index.type)),
    readonly: present.some((index) => index.readonly),
  };
}
