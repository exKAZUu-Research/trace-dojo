import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isNumericName } from './syntax';
import { type Type, undefinedType, unionOf } from './types';

/**
 * The type at a numeric name no element of a tuple has, in a type or a value lookup: past a rest element, the values
 * from the rest on, and otherwise `undefined` after reporting the position at `node`. A negative position past a rest
 * element is left to the number index signature, as is any name for an object other than a tuple.
 */
export function tupleElementBeyond(
  c: Checker,
  object: Type,
  name: string,
  node: TreeNode | undefined
): Type | undefined {
  if (object.kind !== 'object' || object.objectKind !== 'tuple' || !isNumericName(name)) return undefined;
  const elements = object.tuple?.elements ?? [];
  const restIndex = elements.findIndex((element) => element.rest);
  if (restIndex !== -1)
    return Number(name) < 0
      ? undefined
      : unionOf(
          elements.slice(restIndex).map((element) => (element.rest ? c.restElementType(element.type) : element.type))
        );
  if (node)
    c.error(
      node,
      Number(name) < 0
        ? 'タプル型は負の値でインデックス指定できません。'
        : `長さ ${elements.length} のタプル型 '${c.print(object)}' には、インデックス ${name} の要素がありません。`
    );
  return undefinedType;
}
