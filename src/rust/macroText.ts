import type { Node } from '@willbooster/web-tree-sitter';

import { isComment } from './convertSyntax';
import { writtenName } from './macroHygiene';
import { isStringLiteral, spacedBeforeParen } from './macroRules';

/**
 * The text `stringify!` gives tokens: with one space where spaces or newlines separate them and `joinsAfter` keeps
 * it; `spacedOperators` prints an expression as `assert!`'s message does, a binary operator between single spaces.
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
    if (spaced && joinsAfter(previous, token.text, spacedOperators)) text += ' ';
    text += token.type === 'identifier' ? writtenName(token.text) : token.text;
    if (operator) text += ' ';
    end = operator ? Number.POSITIVE_INFINITY : token.endIndex;
    previous = operator ? ' ' : token.text;
  };
  for (const token of tokens) visit(token);
  return text;
}

/**
 * Whether rustc keeps a space between two tokens: never inside brackets, around `.`, or before `,` and `;`. Its token
 * printing (`stringify!`) keeps the source's space before `[` and before the `(` of a keyword; its expression printing
 * (`assert!`'s message) drops it before a call's `(` and an index's `[`.
 */
function joinsAfter(previous: string, next: string, expression: boolean): boolean {
  if ([' ', '(', '[', '.'].includes(previous)) return false;
  if ([',', ';', ')', ']', '.'].includes(next)) return false;
  if (!expression) return next !== '(' || spacedBeforeParen(previous);
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
