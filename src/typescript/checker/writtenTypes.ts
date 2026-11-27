import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { checkOverloadOptionality, checkTypeMemberDuplicates } from './declarations';
import { checkDuplicateIndexSignatures, checkIndexConformance } from './indexConformance';
import { importTypeMemberChain, isImportTypeCall } from './namespaces';
import { isStandaloneTypeReference, named } from './syntax';

/**
 * These types can report errors in unused declarations and uninstantiated conditional branches.
 */
const eagerTypeSyntaxes = new Set(['tuple_type', 'lookup_type', 'readonly_type']);

export function checkWrittenType(c: Checker, node: TreeNode | null): void {
  if (!node) return;
  c.budget.spend();
  if (node.type === 'type_query') {
    c.typeNodes.typeFromNode(node);
    for (const child of named(node)) if (child.type === 'type_arguments') checkWrittenType(c, child);
    return;
  }
  if (node.type === 'nested_type_identifier' || isImportTypeCall(node) || importTypeMemberChain(node)) {
    c.typeNodes.typeFromNode(node);
    return;
  }
  checkTypeNode(c, node);
  for (const child of named(node)) checkWrittenType(c, child);
}

function checkTypeNode(c: Checker, node: TreeNode): void {
  if (node.type === 'generic_type' || isStandaloneTypeReference(node) || eagerTypeSyntaxes.has(node.type))
    c.typeNodes.checkDeferredReferenceArguments(c.typeNodes.typeFromNode(node));
  if (node.type === 'infer_type') c.typeNodes.checkInferPlacement(node);
  if (node.type !== 'object_type') return;
  checkTypeMemberDuplicates(c, node);
  checkOverloadOptionality(c, node);
  checkDuplicateIndexSignatures(c, named(node));
  const type = c.typeNodes.typeFromNode(node);
  if (type.kind === 'object') checkIndexConformance(c, type.resolve(), { bodies: [node] });
}
