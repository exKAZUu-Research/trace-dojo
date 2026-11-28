import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { erasedClassMembers, erasedStatementTypes, erasedTypeNodes } from './erasedSyntax';

const nonRuntimeTypeContainers = new Set([
  ...erasedStatementTypes,
  ...erasedTypeNodes,
  ...erasedClassMembers,
  'opting_type_annotation',
  'omitting_type_annotation',
  'adding_type_annotation',
  'implements_clause',
  'extends_type_clause',
]);

const initializerOwners = new Set([
  'variable_declarator',
  'field_definition',
  'required_parameter',
  'optional_parameter',
]);

/** The modules a program may import, which are the Node.js modules this interpreter provides. */
export const importableModules = new Set(['fs', 'node:fs']);

/** The message for a feature this interpreter does not run, with a space after a name ending in ASCII. */
export function unsupportedMessage(feature: string): string {
  return `${feature}${/[\u0021-\u007E]$/.test(feature) ? ' ' : ''}は、この採点環境では使えません。`;
}

/** Rejects the syntax this interpreter does not run, as `〜は、この採点環境では使えません。`. */
export function rejectUnsupportedSyntax(root: TreeNode): void {
  const diagnostics: SourceDiagnostic[] = [];
  const reject = (node: TreeNode, feature: string): void => {
    if (diagnostics.length < 5) diagnostics.push({ row: node.startPosition.row, message: unsupportedMessage(feature) });
  };
  const visit = (node: TreeNode): void => {
    if (node.isNamed && node.type === 'import' && !isTypePositionImport(node)) {
      reject(node, 'import や export');
      return;
    }
    const feature2 = unsupportedForm(node);
    if (feature2) reject(node, feature2);
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  if (diagnostics.length > 0) throw new CompileError(diagnostics);
}

function isTypePositionImport(node: TreeNode): boolean {
  const call = node.parent;
  if (call?.type !== 'call_expression' || call.childForFieldName('function')?.id !== node.id) return false;
  let child: TreeNode = call;
  for (let parent = call.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === 'computed_property_name' || parent.type === 'decorator') return false;
    if (initializerOwners.has(parent.type) && parent.childForFieldName('value')?.id === child.id) return false;
    if (parent.type === 'as_expression' || parent.type === 'satisfies_expression') {
      return parent.namedChildren.find((part) => part?.type !== 'comment')?.id !== child.id;
    }
    if (nonRuntimeTypeContainers.has(parent.type)) return true;
  }
  return false;
}

/** A feature that a node of a supported type spells in a form this interpreter does not run. */
function unsupportedForm(node: TreeNode): string | undefined {
  if (node.type === 'meta_property' && node.text.replaceAll(/\s/g, '') === 'import.meta') return 'import.meta';
  if (node.type !== 'import_statement' && node.type !== 'export_statement') return undefined;
  if (isInAmbientDeclaration(node)) return undefined;
  if (node.type === 'export_statement' && isExportedNamespaceDestructuring(node)) {
    return '名前空間の export 変数宣言での分割代入';
  }
  const source = node.childForFieldName('source') ?? node.namedChildren.at(-1)?.childForFieldName('source');
  // An export without `from` loads no other module.
  if (node.type === 'export_statement' && !source) return undefined;
  const module = source?.text.slice(1, -1) ?? '';
  if (importableModules.has(module)) return undefined;
  return `モジュール '${module}' の ${node.type === 'import_statement' ? 'import' : 'export'}`;
}

function isExportedNamespaceDestructuring(node: TreeNode): boolean {
  const owner = node.parent?.type === 'statement_block' ? node.parent.parent : undefined;
  if (
    (owner?.type !== 'internal_module' && owner?.type !== 'module') ||
    owner.childForFieldName('name')?.type === 'string'
  ) {
    return false;
  }
  const declaration = node.childForFieldName('declaration');
  if (declaration?.type !== 'lexical_declaration' && declaration?.type !== 'variable_declaration') return false;
  return declaration.namedChildren.some((declarator) => {
    const name = declarator?.childForFieldName('name');
    return Boolean(name && name.type !== 'identifier');
  });
}

function isInAmbientDeclaration(node: TreeNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'ambient_declaration') return true;
  }
  return false;
}
