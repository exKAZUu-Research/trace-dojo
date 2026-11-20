import type { Checker } from './checker';
import { isNumericName } from './syntax';
import {
  type IndexInfo,
  intersectionOf,
  isIntrinsic,
  type KeyedIndexInfo,
  literalType,
  numberType,
  type Property,
  stringType,
  type Structure,
  symbolType,
  type Type,
  unionOf,
} from './types';

/** Whether a key type declares a pattern index signature, as `` `a${string}` `` and `Uppercase<string>` do. */
export function isPatternKey(type: Type): boolean {
  return type.kind === 'templateLiteral' || type.kind === 'stringMapping';
}

/**
 * The index signature of a structure that applies to a key, as TypeScript's `findApplicableIndexInfo` finds it: every
 * index signature other than the string index whose key type holds the key, as one of the intersection of their value
 * types, read-only only when all are; else the string index for a string or numeric key. An `any` key fits them all.
 */
export function applicableIndex(c: Checker, structure: Structure, key: Type): IndexInfo | undefined {
  const applicable = [
    ...(structure.numberIndex && isIndexKeyOf(c, key, numberType) ? [structure.numberIndex] : []),
    ...(structure.symbolIndex && isIndexKeyOf(c, key, symbolType) ? [structure.symbolIndex] : []),
    ...applicablePatternIndexes(c, structure, key),
  ];
  if (applicable.length > 0) return combinedIndex(c, applicable);
  return isIndexKeyOf(c, key, stringType) ? structure.stringIndex : undefined;
}

/** The index reached by a declared name, which uses the string spelling of a numeric key. */
export function namedPropertyIndex(c: Checker, structure: Structure, name: string, key: Type): IndexInfo | undefined {
  return applicableIndex(
    c,
    structure,
    key.kind === 'literal' && typeof key.value === 'number' ? literalType(name) : key
  );
}

/** The pattern index signatures whose patterns hold a key, which a number key never fits. */
export function applicablePatternIndexes(c: Checker, structure: Structure, key: Type): KeyedIndexInfo[] {
  return (structure.patternIndexes ?? []).filter((info) => c.relations.isAssignable(key, info.keyType));
}

/** The index signature that several applying to one key act as. */
function combinedIndex(c: Checker, infos: IndexInfo[]): IndexInfo | undefined {
  if (infos.length <= 1) return infos[0];
  return {
    type: intersectionOf(
      infos.map((info) => info.type),
      c.budget
    ),
    readonly: infos.every((info) => info.readonly),
  };
}

/** Whether a structure has any index signature. */
export function hasIndexSignature(structure: Structure): boolean {
  return (
    !!structure.stringIndex ||
    !!structure.numberIndex ||
    !!structure.symbolIndex ||
    (structure.patternIndexes?.length ?? 0) > 0
  );
}

/**
 * The pattern index signatures of several structures, one for each pattern: the first one's, or with `intersect`, the
 * intersection of all, as an intersection type has.
 */
export function mergedPatternIndexes(
  c: Checker,
  lists: (KeyedIndexInfo[] | undefined)[],
  intersect = false
): KeyedIndexInfo[] | undefined {
  const groups: KeyedIndexInfo[][] = [];
  for (const info of lists.flatMap((list) => list ?? [])) {
    const group = groups.find(([first]) => isSamePattern(c, first.keyType, info.keyType));
    if (group) group.push(info);
    else groups.push([info]);
  }
  if (groups.length === 0) return undefined;
  return groups.map((group) => ({
    keyType: group[0].keyType,
    ...(intersect ? (combinedIndex(c, group) ?? group[0]) : group[0]),
  }));
}

export function addIndexInfo(structure: Structure, key: Type, info: IndexInfo, mapped = false): void {
  if (isIntrinsic(key, 'number')) structure.numberIndex = combineIndexedValues(structure.numberIndex, info, mapped);
  else if (isIntrinsic(key, 'symbol'))
    structure.symbolIndex = combineIndexedValues(structure.symbolIndex, info, mapped);
  else if (!isPatternKey(key)) structure.stringIndex = combineIndexedValues(structure.stringIndex, info, mapped);
  else {
    const existing = structure.patternIndexes?.find((index) => isSameKeyType(index.keyType, key));
    structure.patternIndexes = existing
      ? structure.patternIndexes?.map((index) =>
          index === existing ? { ...index, ...combineIndexedValues(index, info, mapped) } : index
        )
      : [...(structure.patternIndexes ?? []), { ...info, keyType: key }];
  }
}

function combineIndexedValues(previous: IndexInfo | undefined, info: IndexInfo, mapped: boolean): IndexInfo {
  if (!previous) return info;
  return {
    type: unionOf([previous.type, info.type]),
    readonly: mapped ? previous.readonly || info.readonly : previous.readonly && info.readonly,
  };
}

/** Whether two index signature key types are the same type, as TypeScript keeps one index signature for each. */
export function isSameKeyType(left: Type, right: Type): boolean {
  if (left === right) return true;
  if (left.kind === 'templateLiteral' && right.kind === 'templateLiteral')
    return (
      left.texts.length === right.texts.length &&
      left.texts.every((text, index) => text === right.texts[index]) &&
      left.types.every((type, index) => isSameKeyType(type, right.types[index]))
    );
  return (
    left.kind === 'stringMapping' &&
    right.kind === 'stringMapping' &&
    left.mapping === right.mapping &&
    isSameKeyType(left.type, right.type)
  );
}

/** Whether two patterns hold the same strings. */
export function isSamePattern(c: Checker, left: Type, right: Type): boolean {
  return c.relations.isAssignable(left, right) && c.relations.isAssignable(right, left);
}

/** The index signatures of a structure with their key types. */
export function keyedIndexes(structure: Structure): KeyedIndexInfo[] {
  return [
    ...(structure.stringIndex ? [{ ...structure.stringIndex, keyType: stringType }] : []),
    ...(structure.numberIndex ? [{ ...structure.numberIndex, keyType: numberType }] : []),
    ...(structure.symbolIndex ? [{ ...structure.symbolIndex, keyType: symbolType }] : []),
    ...(structure.patternIndexes ?? []),
  ];
}

/** Whether an index signature for one key type applies to keys of another, as TypeScript's `isApplicableIndexType` decides. */
export function isIndexKeyOf(c: Checker, source: Type, target: Type): boolean {
  return (
    c.relations.isAssignable(source, target) ||
    (target === stringType && c.relations.isAssignable(source, numberType)) ||
    (target === numberType && isNumericStringKey(source))
  );
}

/** Whether an index signature for `keyType` applies to a property, by the key type that names it. */
export function isPropertyKeyOf(c: Checker, property: Property, keyType: Type): boolean {
  return !property.isPrivateName && isIndexKeyOf(c, c.typeOperators.propertyKeyType(property), keyType);
}

/** Whether a key is a numeric string, as `"1"` and `` `${number}` `` are. */
export function isNumericStringKey(key: Type): boolean {
  if (key.kind === 'literal') return typeof key.value === 'string' && isNumericName(key.value);
  return (
    key.kind === 'templateLiteral' &&
    key.texts.length === 2 &&
    key.texts.every((text) => text === '') &&
    isIntrinsic(key.types[0], 'number')
  );
}
