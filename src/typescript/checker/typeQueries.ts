import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { functionLikeTypes } from './binder';
import type { Checker } from './checker';
import type { Type } from './types';

type QueryTarget = (node: TreeNode) => Type;

export function checkTypeQuery(c: Checker, node: TreeNode, identifier: QueryTarget, expression: QueryTarget): Type {
  const flow = queryFlowContext(node);
  const read = (): Type => readQueryTarget(c, node, identifier, expression);
  return flow ? c.functions.withInitializerFlow(flow.owner, flow.kind, read) : read();
}

function readQueryTarget(c: Checker, node: TreeNode, identifier: QueryTarget, expression: QueryTarget): Type {
  if (node.type === 'identifier') return identifier(node);
  if (node.type !== 'member_expression') return expression(node);
  const object = node.childForFieldName('object') as TreeNode;
  const property = node.childForFieldName('property') as TreeNode;
  const receiver = readQueryTarget(c, object, identifier, expression);
  const type = c.members.propertyAccess(node, object, property, receiver, property.text);
  const key = c.flow.referenceKey(node);
  return key ? (c.flow.entry(key)?.type ?? type) : type;
}

type QueryFlow = 'parameters' | 'field';

function queryFlowContext(node: TreeNode): { owner: TreeNode; kind: QueryFlow } | undefined {
  let child = node;
  for (let owner = node.parent; owner; child = owner, owner = owner.parent) {
    const kind = boundaryFlow(owner, child);
    if (kind === 'inherit') return undefined;
    if (kind) return { owner, kind };
  }
  return undefined;
}

function boundaryFlow(owner: TreeNode, child: TreeNode): QueryFlow | 'inherit' | undefined {
  if (owner.type === 'class_static_block') return 'inherit';
  if (
    (owner.type === 'required_parameter' || owner.type === 'optional_parameter') &&
    owner.childForFieldName('value')?.id === child.id
  )
    return 'inherit';
  if (owner.type === 'field_definition') {
    return owner.childForFieldName('value') && owner.childForFieldName('type')?.id === child.id ? 'field' : 'inherit';
  }
  if (!isSignatureBoundary(owner)) return undefined;
  if (owner.childForFieldName('body')?.id === child.id || owner.childForFieldName('name')?.id === child.id)
    return 'inherit';
  return capturesEnclosingFlow(owner) ? 'parameters' : 'field';
}

function isSignatureBoundary(node: TreeNode): boolean {
  return (
    functionLikeTypes.has(node.type) || ['generator_function', 'generator_function_declaration'].includes(node.type)
  );
}

function capturesEnclosingFlow(node: TreeNode): boolean {
  if (['arrow_function', 'function_expression', 'generator_function'].includes(node.type)) return true;
  if (node.type !== 'method_definition') return false;
  return node.parent?.type !== 'class_body' || node.parent.parent?.type === 'class';
}
