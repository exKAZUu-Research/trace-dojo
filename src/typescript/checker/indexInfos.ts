import type { Checker } from './checker';
import { isNumericName } from './syntax';
import {
  type IndexInfo,
  intersectionOf,
  isAnyLike,
  type KeyedIndexInfo,
  literalType,
  numberType,
  stringType,
  type Structure,
  symbolType,
  type Type,
} from './types';

/** Whether a key type declares a pattern index signature, as `` `a${string}` `` and `Uppercase<string>` do. */
export function isPatternKey(type: Type): boolean {
  return type.kind === 'templateLiteral' || type.kind === 'stringMapping';
}

/**
 * The index signature of a structure that applies to a key, as TypeScript's `findApplicableIndexInfo` finds it: the
 * symbol index for a symbol key, the number index for a numeric key, and every pattern index whose pattern holds the
 * key, as one of the intersection of their value types, read-only only when all are; else the string index for a string
 * or numeric key.
 */
export function applicableIndex(c: Checker, structure: Structure, key: Type): IndexInfo | undefined {
  const { relations } = c;
  if (!isAnyLike(key) && relations.isAssignable(key, symbolType)) return structure.symbolIndex;
  const numeric =
    isAnyLike(key) ||
    relations.isAssignable(key, numberType) ||
    (key.kind === 'literal' && typeof key.value === 'string' && isNumericName(key.value));
  const applicable = [
    ...(numeric && structure.numberIndex ? [structure.numberIndex] : []),
    ...applicablePatternIndexes(c, structure, key),
  ];
  if (applicable.length > 0) return combinedIndex(c, applicable);
  return numeric || relations.isAssignable(key, stringType) ? structure.stringIndex : undefined;
}

/** The pattern index signatures whose patterns hold a key, which a number literal names by its text. */
export function applicablePatternIndexes(c: Checker, structure: Structure, key: Type): KeyedIndexInfo[] {
  if (!structure.patternIndexes || isAnyLike(key)) return [];
  const stringKey = key.kind === 'literal' && typeof key.value === 'number' ? literalType(String(key.value)) : key;
  return structure.patternIndexes.filter((info) => c.relations.isAssignable(stringKey, info.keyType));
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
    (target === numberType &&
      source.kind === 'literal' &&
      typeof source.value === 'string' &&
      isNumericName(source.value))
  );
}
