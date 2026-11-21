import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { BROWSER_ONLY_GLOBALS, SHARED_HOST_GLOBALS } from './domGlobals';
import type { Sym } from './scopes';
import { named } from './syntax';

export function nativeGlobalRedeclaration(c: Checker, symbol: Sym, declaration: TreeNode): boolean | undefined {
  const first = symbol.valueDeclaration;
  const native = BROWSER_ONLY_GLOBALS[symbol.name] ?? SHARED_HOST_GLOBALS[symbol.name];
  if (!first || !c.isLibrary(first) || !native || /^(any|void|string|number|boolean)$/.test(native[1]))
    return undefined;
  const expected = first.childForFieldName('type');
  if (!expected) return undefined;
  const actual = declaration.childForFieldName('type') ?? declaration.childForFieldName('value');
  return actual !== null && typeIdentity(c, actual) === typeIdentity(c, expected);
}

function typeIdentity(c: Checker, node: TreeNode, seen = new Set<number>()): string {
  c.budget.spend();
  if (seen.has(node.id)) return node.text.replaceAll(/\s+/g, '');
  seen.add(node.id);
  try {
    if (node.type === 'type_annotation' || node.type === 'parenthesized_type')
      return typeIdentity(c, named(node)[0], seen);
    if (node.type === 'parenthesized_expression') return typeIdentity(c, named(node)[0], seen);
    if (node.type === 'as_expression') return typeIdentity(c, named(node)[1], seen);
    if (node.type === 'type_assertion') return typeIdentity(c, named(named(node)[0])[0], seen);
    if (node.type === 'union_type' || node.type === 'intersection_type')
      return named(node)
        .map((child) => typeIdentity(c, child, seen))
        .toSorted()
        .join(node.type === 'union_type' ? '|' : '&');
    const resolved = referencedDeclaration(c, node);
    if (resolved) return typeIdentity(c, resolved, seen);
    return node.text.replaceAll(/\s+/g, '');
  } finally {
    seen.delete(node.id);
  }
}

function referencedDeclaration(c: Checker, node: TreeNode): TreeNode | undefined {
  if (node.type === 'type_identifier') {
    const declaration = c.scopeOf(node).lookupType(node.text)?.typeDeclarations[0];
    const value = declaration?.type === 'type_alias_declaration' ? declaration.childForFieldName('value') : undefined;
    if (value && (!c.isLibrary(declaration!) || value.text !== 'any')) return value;
  }
  if (c.isLibrary(node)) return undefined;
  const reference = node.type === 'type_query' ? named(node)[0] : node;
  if (reference.type !== 'identifier') return undefined;
  const symbol = c.scopeOf(reference).lookupValue(reference.text);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || declaration.type !== 'variable_declarator') return undefined;
  return declaration.childForFieldName('type') ?? declaration.childForFieldName('value') ?? undefined;
}
