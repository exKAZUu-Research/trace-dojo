import type { Node } from '@willbooster/web-tree-sitter';

import { isComment } from './convertSyntax';
import { writtenName } from './macroHygiene';
import { isStringLiteral } from './macroRules';

/**
 * The text `stringify!` gives tokens: with one space where spaces or newlines separate them, but none around the
 * insides of brackets, before `,` and `;`, or before a call's `(`; `spacedOperators` puts a binary operator between
 * single spaces, as `assert!`'s message does.
 */
// code-gauge-allow functionCognitiveComplexity -- One walk over the tokens skips comments and expr variables' marks.
export function tokenText(tokens: Node[], spacedOperators = false): string {
  let text = '';
  let end: number | undefined;
  let previous = '';
  const visit = (token: Node): void => {
    if (isComment(token)) return;
    // An `expr` variable's marked parentheses do not show (`assert!($e)` says `x == 6`).
    const fragment = fragmentInner(token);
    if (fragment) return visit(fragment);
    if (token.childCount > 0 && !token.type.endsWith('_literal')) {
      for (const child of token.children) visit(child);
      return;
    }
    // `assert!` prints its condition as rustc's pretty printer does: a binary operator between single spaces.
    const operator =
      spacedOperators &&
      token.parent?.type === 'binary_expression' &&
      token.parent.childForFieldName('operator')?.id === token.id;
    const spaced = (end !== undefined && token.startIndex > end) || (operator && end !== undefined);
    if (spaced && joinsAfter(previous, token.text)) text += ' ';
    text += token.type === 'identifier' ? writtenName(token.text) : token.text;
    if (operator) text += ' ';
    end = operator ? Number.POSITIVE_INFINITY : token.endIndex;
    previous = operator ? ' ' : token.text;
  };
  for (const token of tokens) visit(token);
  return text;
}

/** Whether rustc's token printing keeps a space between two tokens: not around brackets' insides, `,`, `;`, or a call's `(`. */
function joinsAfter(previous: string, next: string): boolean {
  if (previous === ' ' || previous === '(' || previous === '[') return false;
  if ([',', ';', ')', ']'].includes(next)) return false;
  if (next === '(' || next === '[') return !/^[\p{L}\p{N}_)\]]/u.test(previous.at(-1) ?? '');
  return true;
}

/**
 * A string literal or macro call that a macro's `expr` variable passed on (`println!($fmt)`), which keeps it in marked
 * parentheses.
 */
export function fragmentLiteral(node: Node): Node {
  const inner = fragmentInner(node);
  if (!inner) return node;
  const literal = fragmentLiteral(inner);
  return isStringLiteral(literal.type) || literal.type === 'macro_invocation' ? literal : node;
}

/** The expression in the marked parentheses an `expr` variable keeps its operand in, if `node` is those. */
function fragmentInner(node: Node): Node | undefined {
  const [open, mark, inner] = node.children;
  const marked = node.type === 'parenthesized_expression' && open?.type === '(' && mark?.text === '/*expr*/';
  return marked ? inner : undefined;
}
