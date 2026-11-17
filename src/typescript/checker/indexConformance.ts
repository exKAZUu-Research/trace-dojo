import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isIndexKeyOf, isPropertyKeyOf, isSamePattern, keyedIndexes } from './indexInfos';
import { isWithin, named } from './syntax';
import {
  isSymbolName,
  type KeyedIndexInfo,
  type Property,
  stringType,
  type Structure,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/**
 * Reports properties that an index signature of the same type does not allow, and an index signature that does not fit
 * another applying to its keys, as a number index must fit the string index. A property inherited from elsewhere is
 * reported at the index signature of `owner`, the body declaring the type.
 */
export function checkIndexConformance(c: Checker, structure: Structure, owner?: TreeNode): void {
  const indexes = keyedIndexes(structure);
  for (const property of structure.properties.values()) checkPropertyConformance(c, property, indexes, owner);
  if (!owner) return;
  for (const index of indexes) checkIndexFitsOthers(c, index, indexes, owner);
}

function checkPropertyConformance(c: Checker, property: Property, indexes: KeyedIndexInfo[], owner?: TreeNode): void {
  const nameNode = property.declaration?.childForFieldName('name');
  if (!nameNode || !property.declaration || c.isLibrary(property.declaration) || isSymbolName(property.name)) return;
  const type = property.optional ? unionOf([property.type(), undefinedType]) : property.type();
  const inherited = owner !== undefined && !isWithin(property.declaration, owner);
  for (const index of indexes) {
    if (!isPropertyKeyOf(c, property, index.keyType) || c.relations.isAssignable(type, index.type)) continue;
    c.error(
      (inherited && owner && indexSignatureNode(c, owner, index.keyType)) || nameNode,
      `型 '${c.print(type)}' のプロパティ '${property.name}' は、'${c.print(index.keyType)}' のインデックスの型 '${c.print(index.type)}' に代入できません。`
    );
  }
}

/** Reports an index signature `owner` declares whose value type does not fit another applying to its keys. */
function checkIndexFitsOthers(c: Checker, index: KeyedIndexInfo, indexes: KeyedIndexInfo[], owner: TreeNode): void {
  const node = indexSignatureNode(c, owner, index.keyType);
  if (!node) return;
  for (const other of indexes) {
    if (other === index || !isIndexKeyOf(c, index.keyType, other.keyType)) continue;
    if (c.relations.isAssignable(index.type, other.type)) continue;
    c.error(
      node,
      `'${c.print(index.keyType)}' のインデックスの型 '${c.print(index.type)}' は、'${c.print(other.keyType)}' のインデックスの型 '${c.print(other.type)}' に代入できません。`
    );
  }
}

/** The index signature `body` declares for a key type. */
function indexSignatureNode(c: Checker, body: TreeNode, keyType: Type): TreeNode | undefined {
  return named(body).find((member) => {
    if (member.type !== 'index_signature') return false;
    const indexType = member.childForFieldName('index_type');
    const declared = indexType ? c.silently(() => c.typeNodes.typeFromNode(indexType)) : stringType;
    return (declared.kind === 'union' ? declared.types : [declared]).some(
      (key) => key === keyType || isSamePattern(c, key, keyType)
    );
  });
}
