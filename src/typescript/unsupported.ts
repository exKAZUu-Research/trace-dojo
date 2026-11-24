import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';

/** Syntax this interpreter does not run yet, by node type, named as learners know it. */
const unsupportedNodes: Record<string, string> = {
  import: 'import や export',
};

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
    const feature = node.isNamed ? (unsupportedNodes[node.type] as string | undefined) : undefined;
    if (feature) {
      reject(node, feature);
      return;
    }
    const feature2 = unsupportedForm(node);
    if (feature2) reject(node, feature2);
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  if (diagnostics.length > 0) throw new CompileError(diagnostics);
}

/** A feature that a node of a supported type spells in a form this interpreter does not run. */
function unsupportedForm(node: TreeNode): string | undefined {
  if (node.type === 'meta_property' && node.text.replaceAll(/\s/g, '') === 'import.meta') return 'import.meta';
  if (node.type !== 'import_statement' && node.type !== 'export_statement') return undefined;
  const source = node.childForFieldName('source') ?? node.namedChildren.at(-1)?.childForFieldName('source');
  // An export without `from` loads no other module.
  if (node.type === 'export_statement' && !source) return undefined;
  const module = source?.text.slice(1, -1) ?? '';
  if (importableModules.has(module)) return undefined;
  return `モジュール '${module}' の ${node.type === 'import_statement' ? 'import' : 'export'}`;
}
