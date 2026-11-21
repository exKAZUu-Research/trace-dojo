import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { ExecutionLimitError, LIMITS } from '../../interpreter/limits';
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
  if (element && (firstRest === -1 || index.value < firstRest)) return tupleElementReadType(c, element);
  return tupleElementBeyond(c, type, String(index.value), undefined) ?? c.elementTypeOf(type);
}

export function tupleSliceReadType(c: Checker, elements: TupleElement[], start = 0): Type {
  return unionOf(elements.slice(start).map((element) => tupleElementReadType(c, element)));
}

export function tupleElementReadType(c: Checker, element: TupleElement): Type {
  const type = element.rest ? c.restElementType(element.type) : element.type;
  return element.optional ? unionOf([type, undefinedType]) : type;
}

/** Substitute array and non-variadic tuple bounds for rests whose complete shape is known. */
export function constrainedTuple(c: Checker, type: ObjectType): Type {
  return resolveTupleConstraint(c, type, new Map(), 0);
}

function resolveTupleConstraint(
  c: Checker,
  type: ObjectType,
  bounds: Map<Type, Type | undefined>,
  depth: number
): Type {
  if (!type.tuple || !hasVariadicRest(type)) return type;
  const { elements, readonly } = type.tuple;
  const resolved = elements.map((element) => {
    const bound =
      element.rest && element.type.kind === 'typeParameter'
        ? restConstraint(c, element.type, bounds, depth + 1)
        : undefined;
    return bound ? { ...element, type: bound } : element;
  });
  if (resolved.every((member, position) => member === elements[position])) return type;
  return c.tupleType(resolved, readonly);
}

function restConstraint(c: Checker, type: Type, bounds: Map<Type, Type | undefined>, depth: number): Type | undefined {
  if (bounds.has(type)) return bounds.get(type);
  c.budget.spend();
  if (depth >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
  bounds.set(type, undefined);
  const bound = computeRestConstraint(c, type, bounds, depth);
  bounds.set(type, bound);
  return bound;
}

function computeRestConstraint(
  c: Checker,
  type: Type,
  bounds: Map<Type, Type | undefined>,
  depth: number
): Type | undefined {
  if (type.kind === 'union') {
    const members = type.types
      .map((member) => restConstraint(c, member, bounds, depth + 1))
      .filter((bound) => bound !== undefined);
    return members.length === type.types.length ? unionOf(members) : undefined;
  }
  if (type.kind === 'object' && c.isArrayOrTuple(type)) {
    if (!hasVariadicRest(type)) return type;
    const bound = resolveTupleConstraint(c, type, bounds, depth + 1);
    return bound === type ? undefined : restConstraint(c, bound, bounds, depth + 1);
  }
  const bound = c.baseConstraint(type);
  return bound === type ? undefined : restConstraint(c, bound, bounds, depth + 1);
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
  if (restIndex !== -1) return Number(name) < 0 ? undefined : tupleSliceReadType(c, elements, restIndex);
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
