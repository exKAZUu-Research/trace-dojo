import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isGenericObjectOrIndexType } from './genericTypes';
import { isNumericName } from './syntax';
import {
  isIntrinsic,
  isPropertyKeyLiteral,
  type ObjectType,
  type TupleElement,
  type Type,
  typeMembers,
  undefinedType,
  unionOf,
  type UnionType,
} from './types';

export function hasVariadicRest(type: ObjectType): boolean {
  return type.tuple?.elements.some((element) => element.rest && isGenericObjectOrIndexType(element.type)) ?? false;
}

export function tupleTypesDefinitelyUnrelated(source: ObjectType, target: ObjectType): boolean {
  const sourceElements = source.tuple?.elements ?? [];
  const targetElements = target.tuple?.elements ?? [];
  if (!hasVariadicRest(target) && minimumTupleLength(targetElements) > minimumTupleLength(sourceElements)) return true;
  return (
    !targetElements.some((element) => element.rest) &&
    (sourceElements.some((element) => element.rest) || targetElements.length < sourceElements.length)
  );
}

function minimumTupleLength(elements: TupleElement[]): number {
  return elements.filter((element) => (element.rest ? isGenericObjectOrIndexType(element.type) : !element.optional))
    .length;
}

export function variadicTupleIndex(type: Type, index: Type): type is ObjectType {
  if (type.kind !== 'object' || !type.tuple || !hasVariadicRest(type)) return false;
  const fixed = type.tuple.elements.filter((element) => !element.rest).length;
  return typeMembers(index).some((key) => {
    if (!isPropertyKeyLiteral(key) || typeof key.value === 'symbol') return true;
    const name = String(key.value);
    return !isNumericName(name) || Number(name) < 0 || Number(name) >= fixed;
  });
}

/** Numeric types read all tuple elements, or the fixed prefix position and the possible values past it. */
export function numericTupleIndex(c: Checker, type: ObjectType, index: Type): Type | undefined {
  if (isIntrinsic(index, 'number')) return c.elementTypeOf(type);
  if (index.kind !== 'literal' || typeof index.value !== 'number') return undefined;
  const element = type.tuple?.elements[index.value];
  const firstRest = type.tuple?.elements.findIndex((member) => member.rest) ?? -1;
  if (element && (firstRest === -1 || index.value < firstRest))
    return element.optional ? unionOf([element.type, undefinedType]) : element.type;
  return tupleElementBeyond(c, type, String(index.value), undefined) ?? c.elementTypeOf(type);
}

/** Resolve type-parameter rests only when every alternative is an array or closed tuple. */
export function constrainedTuple(c: Checker, type: ObjectType): Type {
  if (!type.tuple || !hasVariadicRest(type)) return type;
  const { elements, readonly } = type.tuple;
  const options = elements.map((element) => {
    const bound = element.rest && element.type.kind === 'typeParameter' ? restConstraint(c, element.type) : undefined;
    return bound ? typeMembers(bound).map((member) => ({ ...element, type: member })) : [element];
  });
  if (options.every(([member], position) => member === elements[position])) return type;
  if (options.every((members) => members.length === 1))
    return c.tupleType(
      options.map(([member]) => member),
      readonly
    );
  let parts: TupleElement[][] = [[]];
  for (const alternatives of options) {
    parts = parts.flatMap((part) =>
      alternatives.map((alternative) => {
        c.budget.spend(part.length + 1);
        return [...part, alternative];
      })
    );
  }
  return unionOf(parts.map((part) => c.tupleType(part, readonly)));
}

function restConstraint(c: Checker, type: Type): Type | undefined {
  let bound = type;
  while (bound.kind === 'typeParameter') {
    c.budget.spend();
    const constraint = c.constraintOf(bound);
    if (!constraint) return undefined;
    bound = constraint;
  }
  if (
    typeMembers(bound).every(
      (member) => member.kind === 'object' && c.isArrayOrTuple(member) && !hasVariadicRest(member)
    )
  )
    return bound;
  return undefined;
}

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
  if (!isNumericName(name)) return undefined;
  if (object.kind === 'union') return tupleUnionElementBeyond(c, object, name, node);
  if (object.kind !== 'object' || object.objectKind !== 'tuple') return undefined;
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

function tupleUnionElementBeyond(
  c: Checker,
  object: UnionType,
  name: string,
  node: TreeNode | undefined
): Type | undefined {
  if (!object.types.every((type): type is ObjectType => type.kind === 'object' && type.objectKind === 'tuple'))
    return undefined;
  if (node && object.types.every((type) => type.tuple?.elements.every((element) => !element.rest)))
    c.error(node, `プロパティ '${name}' は型 '${c.print(object)}' にありません。`);
  if (Number(name) < 0) return undefined;
  return unionOf(object.types.map((type) => tupleElementBeyond(c, type, name, undefined) ?? undefinedType));
}
