import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { hasToken, named } from './syntax';
import { createMapper, newTypeId, type ObjectType, type Type, type TypeParameter } from './types';

const varianceOwners = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'class',
  'interface_declaration',
  'type_alias_declaration',
]);
const varianceAliasValues = new Set(['object_type', 'function_type', 'constructor_type']);

/**
 * Checks the `in` and `out` annotations of a declaration's type parameters as tsc does: only classes, interfaces, and
 * aliases of object, function, constructor, and mapped types take them, and the declaration must be assignable from a
 * subtype to a supertype of the parameter for `out`, and the other way for `in`.
 */
export function checkVarianceAnnotations(c: Checker, node: TreeNode): void {
  const parametersNode = node.childForFieldName('type_parameters');
  if (!parametersNode) return;
  const annotated = named(parametersNode).filter(
    (parameter) => hasToken(parameter, 'in') || hasToken(parameter, 'out')
  );
  if (annotated.length === 0) return;
  // tsc checks the order only where annotations may appear, and reports their misplacement alone elsewhere.
  if (varianceOwners.has(node.type)) for (const parameter of annotated) checkModifierOrder(c, parameter);
  if (!checkAnnotationPlaces(c, node, annotated)) return;
  const parameters = c.signatures.typeParametersOf(node);
  const all = named(parametersNode);
  // `in out` declares the parameter invariant, which tsc takes as written.
  for (const parameterNode of annotated) {
    if (hasToken(parameterNode, 'in') && hasToken(parameterNode, 'out')) continue;
    const parameter = parameters[all.findIndex((each) => each.id === parameterNode.id)];
    if (parameter) checkVariance(c, node, parameterNode, parameters, parameter);
  }
}

/** Reports `out in`, where tsc requires `in` to come first. */
function checkModifierOrder(c: Checker, parameter: TreeNode): void {
  const tokens = parameter.children.filter((child) => child !== null && !child.isNamed);
  const outIndex = tokens.findIndex((token) => token?.type === 'out');
  const inToken = tokens.find((token, index) => token?.type === 'in' && outIndex !== -1 && index > outIndex);
  if (inToken) c.error(inToken, "'in' 修飾子は、'out' 修飾子の前に書かなければいけません。");
}

/** Reports annotations where tsc allows none, and tells whether the declaration may have them. */
function checkAnnotationPlaces(c: Checker, node: TreeNode, annotated: TreeNode[]): boolean {
  if (!varianceOwners.has(node.type)) {
    for (const parameter of annotated) {
      const modifier = hasToken(parameter, 'in') ? 'in' : 'out';
      c.error(
        parameter,
        `'${modifier}' 修飾子は、クラス・インターフェース・型エイリアスの型パラメーターにしか付けられません。`
      );
    }
    return false;
  }
  let value = node.type === 'type_alias_declaration' ? node.childForFieldName('value') : undefined;
  while (value?.type === 'parenthesized_type') value = named(value)[0];
  if (!value || varianceAliasValues.has(value.type)) return true;
  for (const parameter of annotated)
    c.error(parameter, '分散の注釈は、オブジェクト・関数・コンストラクター・マップ型の型エイリアスでしか使えません。');
  return false;
}

/** `out T` needs the type with a subtype of `T` assignable to that with a supertype, and `in T` the other way. */
function checkVariance(
  c: Checker,
  node: TreeNode,
  parameterNode: TreeNode,
  parameters: TypeParameter[],
  parameter: TypeParameter
): void {
  const supertype: TypeParameter = { kind: 'typeParameter', id: newTypeId(), name: `super-${parameter.name}` };
  const subtype: TypeParameter = {
    kind: 'typeParameter',
    id: newTypeId(),
    name: `sub-${parameter.name}`,
    constraint: () => supertype,
  };
  const withSuper = instantiated(c, node, parameters, parameter, supertype);
  const withSub = instantiated(c, node, parameters, parameter, subtype);
  if (!withSuper || !withSub) return;
  const [source, target] = hasToken(parameterNode, 'out') ? [withSub, withSuper] : [withSuper, withSub];
  if (!c.relations.structurally(() => c.relations.isAssignable(source, target)))
    c.error(
      parameterNode,
      `分散の注釈が示すとおりには、型 '${c.print(source)}' を型 '${c.print(target)}' に代入できません。`
    );
}

/** The declaration's type with one of its type parameters replaced. */
function instantiated(
  c: Checker,
  node: TreeNode,
  parameters: TypeParameter[],
  parameter: TypeParameter,
  marker: TypeParameter
): Type | undefined {
  const name = node.childForFieldName('name');
  const symbol = name ? c.scopeOf(node).lookupType(name.text) : undefined;
  if (!symbol) return undefined;
  const declared = c.typeNodes.declaredTypeOf(symbol);
  const args = parameters.map((each) => (each.id === parameter.id ? marker : each));
  if (node.type !== 'type_alias_declaration') return c.reference(declared as ObjectType, args);
  return c.instantiate(declared, createMapper([[parameter.id, marker]]));
}
