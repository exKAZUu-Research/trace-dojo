import type { Node } from '@willbooster/web-tree-sitter';

import { field, namedChildren } from './convertNodes';

/** Node types whose brackets enclose everything below them. */
const BRACKETED_TYPES = new Set([
  'parenthesized_expression',
  'tuple',
  'list',
  'set',
  'dictionary',
  'argument_list',
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
]);

/**
 * Whether a replacement field holds a lambda outside every bracket, whose colon CPython's tokenizer reads as the start
 * of the format specifier.
 */
export function hasUnbracketedLambda(node: Node): boolean {
  if (node.type === 'lambda') return true;
  if (BRACKETED_TYPES.has(node.type)) return false;
  // Only the subscripted value of `a[i]` lies outside its brackets.
  if (node.type === 'subscript') return hasUnbracketedLambda(field(node, 'value'));
  return namedChildren(node).some((child) => hasUnbracketedLambda(child));
}
