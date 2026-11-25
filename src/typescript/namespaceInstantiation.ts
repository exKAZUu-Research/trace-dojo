import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Sym } from './checker/scopes';
import { erasedStatementTypes } from './erasedSyntax';

/**
 * Whether a namespace has an object: a block of it has code to run, or it is declared in an ambient context, as tsc's
 * module instance state decides. The checker and the JavaScript view both ask this, so a namespace has an object in the
 * types exactly when it has one at run time.
 */
export function isInstantiatedNamespace(symbol: Sym): boolean {
  return symbol.valueDeclarations.some((declaration) => {
    if (declaration.type !== 'internal_module' && declaration.type !== 'module') return false;
    const body = declaration.childForFieldName('body');
    return isAmbient(declaration) || (body !== null && blockHasRuntimeCode(body));
  });
}

/** Whether a namespace block's body has code to run, rather than only types and namespaces of types. */
export function blockHasRuntimeCode(body: TreeNode): boolean {
  return body.namedChildren.some((child) => {
    if (!child || child.type === 'comment') return false;
    const declaration = child.type === 'export_statement' ? child.childForFieldName('declaration') : child;
    if (!declaration || erasedStatementTypes.has(declaration.type)) return false;
    const inner = declaration.type === 'expression_statement' ? declaration.namedChildren[0] : declaration;
    if (inner?.type !== 'internal_module' && inner?.type !== 'module') return true;
    const innerBody = inner.childForFieldName('body');
    return innerBody !== null && blockHasRuntimeCode(innerBody);
  });
}

/** Whether a declaration is in an ambient context, as in `declare namespace`, which declares without code to run. */
export function isAmbient(node: TreeNode): boolean {
  for (let current: TreeNode | null = node; current; current = current.parent)
    if (current.type === 'ambient_declaration') return true;
  return false;
}

/**
 * Whether the checker checks a declaration under `declare`, which has no code to check except a namespace's and the
 * implicit types of its variables.
 */
export function isCheckedAmbientDeclaration(node: TreeNode): boolean {
  const declaration = ['export_statement', 'expression_statement'].includes(node.type) ? node.namedChildren[0] : node;
  return ['internal_module', 'module', 'lexical_declaration', 'variable_declaration'].includes(declaration?.type ?? '');
}
