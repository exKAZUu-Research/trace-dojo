import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';

/** Syntax this interpreter does not run yet, by node type, named as learners know it. */
const unsupportedNodes: Record<string, string> = {
  hash_bang_line: '#! の行',
  html_comment: 'HTML 形式のコメント',
  labeled_statement: 'ラベル付きの文',
  debugger_statement: 'debugger 文',
  with_statement: 'with 文',
  generator_function_declaration: 'ジェネレータ関数',
  generator_function: 'ジェネレータ関数',
  yield_expression: 'yield',
  override_modifier: 'override 修飾子',
  enum_declaration: 'enum',
  ambient_declaration: 'declare による宣言',
  internal_module: 'namespace',
  module: 'module による宣言',
  import_statement: 'import や export',
  export_statement: 'import や export',
  import_alias: 'import や export',
  import: 'import や export',
  using_declaration: 'using 宣言',
  decorator: 'デコレータ',
  sequence_expression: 'カンマ演算子',
  await_expression: 'await',
  meta_property: 'new.target や import.meta',
  satisfies_expression: 'satisfies 演算子',
  instantiation_expression: '型引数だけを指定した関数の参照',
  asserts: 'asserts による型の表明',
  asserts_annotation: 'asserts による型の表明',
  unique_type: 'unique symbol',
  non_nullable_type: 'JSDoc の型の書き方',
  existential_type: 'JSDoc の型の書き方',
  flow_maybe_type: 'JSDoc の型の書き方',
  jsdoc_unknown_type: 'JSDoc の型の書き方',
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
    const feature = unsupportedNodes[node.type] as string | undefined;
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
  if (functionTypes.has(node.type) && tokens.has('async')) return 'async 関数';
  if (node.type === 'method_definition' && tokens.has('*')) return 'ジェネレータ関数';
  if (node.type === 'for_in_statement' && tokens.has('await')) return 'for await';
  if (node.type === 'public_field_definition' && tokens.has('accessor')) return 'accessor フィールド';
  if (node.type === 'call_expression' && node.childForFieldName('arguments')?.type === 'template_string')
    return 'タグ付きテンプレート';
  return undefined;
}
