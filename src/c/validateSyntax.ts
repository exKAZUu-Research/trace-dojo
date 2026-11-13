import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { TranslationUnit } from './ast';
import { CSyntaxError } from './syntaxDiagnostics';

const RESTRICTED_OPERANDS: Record<string, readonly string[]> = {
  binary_expression: ['left', 'right'],
  unary_expression: ['argument'],
  pointer_expression: ['argument'],
  update_expression: ['argument'],
  sizeof_expression: ['value'],
  conditional_expression: ['condition', 'alternative'],
};

const C17_KEYWORDS = new Set(
  `auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local`.split(
    ' '
  )
);
// code-gauge-allow functionCognitiveComplexity 18 -- Grammar recovery forms need position-specific C17 checks during one syntax-tree walk.
export function validateSyntax(root: Node): void {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === 'macro_specifier') fail(node, `「${node.text}」は型や指定子として宣言されていません。`);
    for (const name of RESTRICTED_OPERANDS[node.type] ?? []) {
      const operand = node.childForFieldName(name);
      if (operand?.type === 'assignment_expression')
        throw new CSyntaxError(operand, '代入する左側には、変数や配列の要素などを書いてください。');
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

const NAME_FIELDS = new Set(['name', 'tag', 'label', 'field', 'member']);

export function validateNames(root: TranslationUnit): void {
  const pending: object[] = [root];
  while (pending.length > 0) {
    const item = pending.pop()!;
    const row = 'row' in item && typeof item.row === 'number' ? item.row : 0;
    for (const [key, value] of Object.entries(item)) {
      if (NAME_FIELDS.has(key) && typeof value === 'string' && C17_KEYWORDS.has(value)) {
        throw new CompileError([{ row, message: `「${value}」は予約語なので名前には使えません。` }]);
      }
      if (value && typeof value === 'object') pending.push(value);
    }
  }
}
