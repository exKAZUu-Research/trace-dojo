import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';

/** Syntax this interpreter does not run yet, by node type, named as learners know it. */
const unsupportedNodes: Record<string, string> = {
  import_statement: 'import や export',
  import: 'import や export',
  using_declaration: 'using 宣言',
  decorator: 'デコレータ',
  await_expression: 'await',
  asserts: 'asserts による型の表明',
  asserts_annotation: 'asserts による型の表明',
};

const functionTypes = new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition']);

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

/** A feature that a node of a supported type spells with a keyword or a form this interpreter does not run. */
function unsupportedForm(node: TreeNode): string | undefined {
  const tokens = new Set(node.children.filter((child) => child !== null && !child.isNamed).map((child) => child?.type));
  if (node.type === 'type_parameter' && ['in', 'out'].some((token) => tokens.has(token)))
    return '型パラメーターの in / out による分散指定';
  if (node.type === 'predefined_type' && tokens.has('unique symbol')) return 'unique symbol';
  if (node.type === 'export_statement' && !isInNamespace(node)) return 'import や export';
  if (node.type === 'meta_property' && node.text.replaceAll(/\s/g, '') === 'import.meta') return 'import.meta';
  if (functionTypes.has(node.type) && tokens.has('async')) return 'async 関数';
  if (node.type === 'for_in_statement' && tokens.has('await')) return 'for await';
  if (node.type === 'field_definition' && tokens.has('accessor')) return 'accessor フィールド';
  return undefined;
}

function isInNamespace(node: TreeNode): boolean {
  for (let current = node.parent; current; current = current.parent)
    if (current.type === 'internal_module' || current.type === 'module') return true;
  return false;
}
