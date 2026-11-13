import type { Node } from '@willbooster/web-tree-sitter';

import { CSyntaxError } from './syntaxDiagnostics';
import { unsupported } from './unsupported';

const DECLARATOR_FIELDS: Record<string, readonly string[]> = {
  pointer_declarator: ['declarator'],
  abstract_pointer_declarator: ['declarator'],
  array_declarator: ['declarator', 'size'],
  abstract_array_declarator: ['declarator', 'size'],
  function_declarator: ['declarator', 'parameters'],
  abstract_function_declarator: ['declarator', 'parameters'],
  parenthesized_declarator: ['declarator'],
  abstract_parenthesized_declarator: ['declarator'],
};

export function validateDeclarationChildren(node: Node, types: Node[], checkFeature: (node: Node) => void): void {
  const consumed = consumedChildren(node, ['type', 'declarator', 'body'], types);
  const allowed = new Set(['comment', 'storage_class_specifier', 'type_qualifier']);
  if (node.type === 'field_declaration') allowed.add('bitfield_clause');
  validateChildren(node, consumed, allowed, checkFeature);
}

export function validateDeclaratorChildren(node: Node, checkFeature: (node: Node) => void): void {
  const fields = DECLARATOR_FIELDS[node.type];
  if (!fields) return;
  const allowed = new Set(['comment']);
  if (node.type.includes('pointer_declarator') || node.type.includes('array_declarator')) allowed.add('type_qualifier');
  validateChildren(node, consumedChildren(node, fields), allowed, checkFeature);
}

function consumedChildren(node: Node, fields: readonly string[], extra: Node[] = []): ReadonlySet<number> {
  return new Set([...extra, ...fields.flatMap((name) => node.childrenForFieldName(name))].map((child) => child.id));
}

function validateChildren(
  node: Node,
  consumed: ReadonlySet<number>,
  allowed: ReadonlySet<string>,
  checkFeature: (node: Node) => void
): void {
  for (const child of node.namedChildren) {
    checkFeature(child);
    if (consumed.has(child.id) || allowed.has(child.type)) continue;
    if (node.type === 'function_definition' && child.type === 'declaration')
      unsupported(child.startPosition.row, '古い形式の関数の定義');
    throw new CSyntaxError(child, '宣言の書き方に誤りがあります。');
  }
}
