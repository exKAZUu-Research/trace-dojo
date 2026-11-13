import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';

const RESTRICTED_OPERANDS: Record<string, readonly string[]> = {
  binary_expression: ['left', 'right'],
  unary_expression: ['argument'],
  pointer_expression: ['argument'],
  update_expression: ['argument'],
  cast_expression: ['value'],
  sizeof_expression: ['value'],
  conditional_expression: ['condition', 'alternative'],
};

// code-gauge-allow functionCognitiveComplexity 18 -- Grammar recovery forms need position-specific C17 checks during one syntax-tree walk.
export function validateSyntax(root: Node): void {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === 'macro_specifier') fail(node, `「${node.text}」は型や指定子として宣言されていません。`);
    for (const name of RESTRICTED_OPERANDS[node.type] ?? []) {
      const operand = node.childForFieldName(name);
      if (operand?.type === 'assignment_expression')
        fail(operand, '代入する左側には、変数や配列の要素などを書いてください。');
    }
    if (node.type === 'argument_list') {
      const children = node.children.filter((child) => child?.type !== 'comment');
      if (children.at(-2)?.type === ',') fail(node, '引数の最後のコンマの後には式が必要です。');
    }
    for (const child of node.namedChildren) if (child) pending.push(child);
  }
}

function fail(node: Node, message: string): never {
  throw new CompileError([{ row: node.startPosition.row, message }]);
}
