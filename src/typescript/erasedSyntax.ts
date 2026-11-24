import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { named } from './checker/syntax';

export const erasedStatementTypes = new Set([
  'interface_declaration',
  'type_alias_declaration',
  'function_signature',
  'ambient_declaration',
]);

export const erasedTypeNodes = new Set([
  'type_annotation',
  'type_parameters',
  'type_arguments',
  'type_predicate_annotation',
  'asserts_annotation',
  'type_query',
]);

export const erasedClassMembers = new Set(['method_signature', 'abstract_method_signature', 'index_signature']);

export const assertionTypes = new Set([
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
  'type_assertion',
]);

export function assertedExpression(node: TreeNode): TreeNode | undefined {
  const children = named(node);
  return node.type === 'type_assertion' ? children.at(-1) : children[0];
}

export function isErasedTypeSyntax(type: string): boolean {
  return erasedTypeNodes.has(type) || erasedStatementTypes.has(type) || erasedClassMembers.has(type);
}
