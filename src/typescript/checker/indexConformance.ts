import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import {
  applicableIndex,
  isIndexKeyOf,
  isPropertyKeyOf,
  isSameKeyType,
  isSamePattern,
  keyedIndexes,
} from './indexInfos';
import { printedPropertyName } from './print';
import { hasToken, isWithin, named } from './syntax';
import {
  type KeyedIndexInfo,
  type Property,
  stringType,
  type Structure,
  symbolType,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/** The declarations of a type whose index signatures are checked: its bodies and, for an interface, its name and bases. */
export interface IndexOwner {
  bodies: TreeNode[];
  name?: TreeNode;
  bases?: Type[];
  isStatic?: boolean;
}

/**
 * Reports properties that an index signature of the same type does not allow, and an index signature that does not fit
 * another applying to its keys, as a number index must fit the string index. As TypeScript's `checkIndexConstraints`
 * does, a conflict is reported at a member `owner` declares, or else at an interface's name when no single base carries
 * both members, as a base that does reports the conflict itself.
 */
export function checkIndexConformance(c: Checker, structure: Structure, owner?: IndexOwner): void {
  const indexes = keyedIndexes(structure);
  for (const property of structure.properties.values()) checkPropertyConformance(c, property, indexes, owner);
  if (!owner) return;
  for (const index of indexes) checkIndexFitsOthers(c, index, indexes, owner);
}

function checkPropertyConformance(c: Checker, property: Property, indexes: KeyedIndexInfo[], owner?: IndexOwner): void {
  const { declaration } = property;
  const nameNode = declaration?.childForFieldName('name');
  if (!nameNode || !declaration || c.isLibrary(declaration)) return;
  const type = property.optional ? unionOf([property.type(), undefinedType]) : property.type();
  const local = !owner || owner.bodies.some((body) => isWithin(declaration, body));
  for (const index of indexes) {
    if (!isPropertyKeyOf(c, property, index.keyType) || c.relations.isAssignable(type, index.type)) continue;
    const node =
      local || !owner
        ? nameNode
        : (indexSignatureNode(c, owner, index.keyType) ??
          inheritedConflictNode(
            c,
            owner,
            (base) => base.properties.has(property.name) && hasIndexFor(base, index.keyType)
          ));
    if (!node) continue;
    c.error(
      node,
      `型 '${c.print(type)}' のプロパティ '${messagePropertyName(c, property)}' は、'${c.print(index.keyType)}' のインデックスの型 '${c.print(index.type)}' に代入できません。`
    );
  }
}

/** A property name as TypeScript writes it in this message, a symbol in brackets as `[key]`. */
function messagePropertyName(c: Checker, property: Property): string {
  const key = c.typeOperators.propertyKeyType(property);
  return isIndexKeyOf(c, key, symbolType) ? printedPropertyName(property.name, key) : property.name;
}

/** Reports an index signature whose value type does not fit another applying to its keys. */
function checkIndexFitsOthers(c: Checker, index: KeyedIndexInfo, indexes: KeyedIndexInfo[], owner: IndexOwner): void {
  for (const other of indexes) {
    if (other === index || !isIndexKeyOf(c, index.keyType, other.keyType)) continue;
    if (c.relations.isAssignable(index.type, other.type)) continue;
    const node =
      indexSignatureNode(c, owner, index.keyType) ??
      indexSignatureNode(c, owner, other.keyType) ??
      inheritedConflictNode(c, owner, (base) => hasIndexFor(base, index.keyType) && hasIndexFor(base, other.keyType));
    if (!node) continue;
    c.error(
      node,
      `'${c.print(index.keyType)}' のインデックスの型 '${c.print(index.type)}' は、'${c.print(other.keyType)}' のインデックスの型 '${c.print(other.type)}' に代入できません。`
    );
  }
}

/**
 * Why the index signatures of an interface do not fit those of a base, or `undefined` when they do: as TypeScript relates
 * the interface to each base, every index signature of the base must hold the signatures of the interface applying to
 * its keys, whether the interface declares them or inherits them from any base.
 */
export function baseIndexMismatch(c: Checker, structure: Structure, base: Structure): string | undefined {
  for (const baseIndex of keyedIndexes(base)) {
    const index = applicableIndex(c, structure, baseIndex.keyType);
    if (index && !c.relations.isAssignable(index.type, baseIndex.type))
      return `'${c.print(baseIndex.keyType)}' のインデックス シグネチャの型が合いません。`;
  }
  return undefined;
}

/** The name of an interface whose two conflicting inherited members no single base carries together. */
function inheritedConflictNode(
  c: Checker,
  owner: IndexOwner,
  carriesBoth: (base: Structure) => boolean
): TreeNode | undefined {
  if (!owner.name || owner.bases?.some((base) => carriesBoth(c.structureOf(base)))) return undefined;
  return owner.name;
}

function hasIndexFor(structure: Structure, keyType: Type): boolean {
  return keyedIndexes(structure).some((index) => isSameKeyType(index.keyType, keyType));
}

/** Reports each of the index signatures among `members` that declare the same key type, at every one of them. */
export function checkDuplicateIndexSignatures(c: Checker, members: TreeNode[]): void {
  for (const { keyType, declarations } of indexSignaturesByKeyType(c, members)) {
    if (declarations.length < 2) continue;
    for (const declaration of declarations)
      c.error(declaration, `型 '${c.print(keyType)}' のインデックス シグネチャが重複しています。`);
  }
}

function indexSignaturesByKeyType(c: Checker, members: TreeNode[]): { keyType: Type; declarations: TreeNode[] }[] {
  const groups: { keyType: Type; declarations: TreeNode[] }[] = [];
  for (const member of members) {
    if (member.type !== 'index_signature' || member.namedChildren.some((child) => child?.type === 'mapped_type_clause'))
      continue;
    const declared = declaredKeyType(c, member);
    for (const keyType of declared.kind === 'union' ? declared.types : [declared]) {
      const group = groups.find((existing) => isSameKeyType(existing.keyType, keyType));
      if (group) group.declarations.push(member);
      else groups.push({ keyType, declarations: [member] });
    }
  }
  return groups;
}

function declaredKeyType(c: Checker, member: TreeNode): Type {
  const indexType = member.childForFieldName('index_type');
  return indexType ? c.silently(() => c.typeNodes.typeFromNode(indexType)) : stringType;
}

/** The index signature the bodies of `owner` declare for a key type. */
function indexSignatureNode(c: Checker, owner: IndexOwner, keyType: Type): TreeNode | undefined {
  return owner.bodies
    .flatMap((body) => named(body))
    .find((member) => {
      if (member.type !== 'index_signature') return false;
      if (owner.isStatic !== undefined && hasToken(member, 'static') !== owner.isStatic) return false;
      const declared = declaredKeyType(c, member);
      return (declared.kind === 'union' ? declared.types : [declared]).some(
        (key) => key === keyType || isSamePattern(c, key, keyType)
      );
    });
}
