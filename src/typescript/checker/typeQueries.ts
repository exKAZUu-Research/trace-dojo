import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { functionLikeTypes } from './binder';
import type { Checker } from './checker';
import type { FlowEntry } from './flow';
import { isImportTypeCall } from './namespaces';
import type { Sym } from './scopes';
import { errorType, type Type } from './types';

type QueryTarget = (node: TreeNode) => Type;

export function checkTypeQuery(c: Checker, node: TreeNode, identifier: QueryTarget, expression: QueryTarget): Type {
  const flow = queryFlowContext(node);
  const read = (): Type => readQueryTarget(c, node, identifier, expression);
  const active = c.functions.contexts.at(-1);
  if (active?.initializer && active.node.id === flow?.owner.id) return read();
  return flow ? c.functions.withInitializerFlow(flow.owner, flow.kind, read) : read();
}

export function queryVariableEntry(c: Checker, node: TreeNode, symbol: Sym, key: string): FlowEntry | undefined {
  const capture =
    symbol.valueKind === 'const' ||
    (symbol.scope !== c.binder.moduleScope &&
      ['let', 'parameter', 'catch'].includes(symbol.valueKind ?? '') &&
      symbol.lastAssignment < node.startIndex);
  return queryEntry(c, key, capture);
}

function readQueryTarget(c: Checker, node: TreeNode, identifier: QueryTarget, expression: QueryTarget): Type {
  if (node.type === 'identifier') return identifier(node);
  if (isImportTypeCall(node)) return c.namespaces.importTypeQuery(node);
  if (node.type !== 'member_expression') return expression(node);
  const object = node.childForFieldName('object') as TreeNode;
  const property = node.childForFieldName('property') as TreeNode;
  if (isImportTypeCall(object)) {
    const module = c.namespaces.resolveImportTypeModule(object);
    if (!module) return errorType;
    const receiver = c.namespaces.objectType(module);
    if (!c.propertyOf(receiver, property.text)) {
      c.error(property, `名前空間 '"${module.name}"' にエクスポートされたメンバー '${property.text}' がありません。`);
      return errorType;
    }
    return c.members.propertyAccess(node, object, property, receiver, property.text);
  }
  const receiver = readQueryTarget(c, object, identifier, expression);
  const type = c.members.propertyAccess(node, object, property, receiver, property.text);
  const key = c.flow.referenceKey(node);
  return key ? (queryEntry(c, key, true)?.type ?? type) : type;
}

function queryEntry(c: Checker, key: string, capture: boolean): FlowEntry | undefined {
  const local = c.flow.entry(key);
  if (local || !capture) return local;
  for (let index = c.functions.contexts.length - 1; index >= 0; index--) {
    const context = c.functions.contexts[index];
    if (context.inlined) continue;
    if (!capturesEnclosingFlow(context.node)) break;
    const outer = context.enclosingFlow?.entries.get(key);
    if (outer?.assigned) return outer;
  }
  return undefined;
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
