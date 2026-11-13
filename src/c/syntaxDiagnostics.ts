import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';

export function cSyntaxDiagnostics(root: Node, errors: SourceDiagnostic[]): SourceDiagnostic[] {
  if (errors.length === 0) return errors;
  const illegal = firstIllegalConstruct(root);
  if (illegal) return [{ row: illegal.startPosition.row, message: 'ここには関数の定義や文を書けません。' }];
  const recovered: SourceDiagnostic[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.isMissing) {
      const original = errors.find((error) => error.message === `「${node.type}」が足りません。`);
      if (original) recovered.push(missingDiagnostic(node, original, root.text));
    } else if (node.isError) recovered.push(errorDiagnostic(node));
    else if (node.hasError) pending.push(...node.children.toReversed());
  }
  return recovered.length > 0 ? recovered.slice(0, 5) : errors;
}

function firstIllegalConstruct(root: Node): Node | undefined {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === 'function_definition' && node.parent?.type === 'compound_statement') return node;
    if (node.parent?.type === 'translation_unit' && node.type.endsWith('_statement')) return node;
    pending.push(...node.namedChildren.toReversed());
  }
  return undefined;
}

function missingDiagnostic(node: Node, original: SourceDiagnostic, source: string): SourceDiagnostic {
  let row = original.row;
  if ([')', ']', 'while'].includes(node.type)) row = nextToken(node)?.startPosition.row ?? row;
  if (node.type === '}') {
    const newlines = source.split('\n').length - 1;
    row = source.endsWith('\n') ? newlines - 1 : newlines;
  }
  return { ...original, row };
}

function errorDiagnostic(node: Node): SourceDiagnostic {
  if (node.firstChild?.type === 'do') {
    const following = node.namedChildren.find((child) => child.type.endsWith('_statement'));
    if (following) return { row: following.startPosition.row, message: '「while」が足りません。' };
  }
  const previous = node.previousSibling;
  const endsExpression =
    previous &&
    ['call_expression', 'update_expression', 'assignment_expression', 'binary_expression'].includes(previous.type);
  if (endsExpression && previous.endPosition.row < node.startPosition.row) {
    return { row: previous.endPosition.row, message: '「;」が足りません。' };
  }
  return { row: node.startPosition.row, message: '書き方に誤りがあります。' };
}

function nextToken(missing: Node): Node | undefined {
  for (let node: Node | null = missing; node; node = node.parent) {
    let next = node.nextSibling;
    while (next?.type === 'comment' || next?.isMissing) next = next.nextSibling;
    if (next) return next;
  }
  return undefined;
}
