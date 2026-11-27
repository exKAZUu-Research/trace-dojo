import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Sym } from './checker/scopes';

const typeOnlyStatementTypes = new Set(['interface_declaration', 'type_alias_declaration', 'comment']);

/**
 * Whether a namespace has an object: a block of it declares a value or statement rather than only types, as tsc's
 * `getModuleInstanceState` decides for both ambient and non-ambient namespaces. The checker and the JavaScript view
 * both ask this, so a namespace has an object in the types when a non-ambient block of it compiles to one at run time.
 */
export function isInstantiatedNamespace(symbol: Sym): boolean {
  return symbol.valueDeclarations.some((declaration) => {
    if (declaration.type !== 'internal_module' && declaration.type !== 'module') return false;
    const body = declaration.childForFieldName('body');
    return body !== null && blockHasRuntimeCode(body);
  });
}

/** Whether a namespace block's body declares values or statements, rather than only types and type-only namespaces. */
export function blockHasRuntimeCode(body: TreeNode): boolean {
  return body.namedChildren.some((child) => child !== null && statementHasRuntimeCode(child));
}

function statementHasRuntimeCode(statement: TreeNode): boolean {
  if (typeOnlyStatementTypes.has(statement.type)) return false;
  if (statement.type === 'ambient_declaration')
    return statement.namedChildren.some((child) => child !== null && statementHasRuntimeCode(child));
  const declaration = statement.type === 'export_statement' ? statement.childForFieldName('declaration') : statement;
  if (!declaration || typeOnlyStatementTypes.has(declaration.type)) return false;
  if (declaration.type === 'ambient_declaration')
    return declaration.namedChildren.some((child) => child !== null && statementHasRuntimeCode(child));
  // tsc counts an import alias only when it is exported.
  if (declaration.type === 'import_alias') return statement.type === 'export_statement';
  const inner = declaration.type === 'expression_statement' ? declaration.namedChildren[0] : declaration;
  if (inner?.type !== 'internal_module' && inner?.type !== 'module') return true;
  const innerBody = inner.childForFieldName('body');
  return innerBody !== null && blockHasRuntimeCode(innerBody);
}

/** Whether a declaration is in an ambient context, as in `declare namespace`, which declares without code to run. */
export function isAmbient(node: TreeNode): boolean {
  for (let current: TreeNode | null = node; current; current = current.parent)
    if (current.type === 'ambient_declaration') return true;
  return false;
}

const checkedAmbientDeclarationTypes = new Set([
  'internal_module',
  'module',
  'lexical_declaration',
  'variable_declaration',
  'enum_declaration',
  'function_signature',
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
]);

/**
 * Whether the checker checks a declaration under `declare`: namespaces, variables, enums, functions, and classes,
 * including invalid ambient implementations and initializers.
 */
export function isCheckedAmbientDeclaration(node: TreeNode): boolean {
  const declaration = ['export_statement', 'expression_statement'].includes(node.type) ? node.namedChildren[0] : node;
  return checkedAmbientDeclarationTypes.has(declaration?.type ?? '');
}
