import type { Node, Parser } from '@willbooster/web-tree-sitter';

import { charactersOf } from './characters';

/**
 * The text of arithmetic expressions that the grammar cannot read, by the offset where each one's text starts. Bash
 * reads `$((...))`, `((...))`, and `$[...]` as text that it evaluates only when it runs them, so an invalid expression
 * is an error at run time, not a syntax error; the grammar parses them as expressions and fails on invalid ones.
 */
export type MaskedArithmetic = Map<number, string>;

const OPENERS = new Set(['$((', '((', '$[']);
const MAX_PASSES = 50;

/**
 * Blanks out the text of every arithmetic expression the grammar fails on, keeping its newlines (and, in `for ((`,
 * its semicolons) so that rows stay in place, until the program parses or no such expression remains.
 */
export function maskInvalidArithmetic(parser: Parser, source: string): { source: string; masked: MaskedArithmetic } {
  const masked: MaskedArithmetic = new Map();
  let text = source;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const tree = parser.parse(text);
    if (!tree) throw new Error('The parser returned no tree');
    try {
      if (!tree.rootNode.hasError) break;
      const region = firstFailingRegion(tree.rootNode, text);
      if (!region) break;
      masked.set(region.start, source.slice(region.start, region.end));
      const blank = charactersOf(text.slice(region.start, region.end))
        .map((c) => (c === '\n' || (region.keepsSemicolons && c === ';') ? c : ' '))
        .join('');
      text = text.slice(0, region.start) + blank + text.slice(region.end);
    } finally {
      tree.delete();
    }
  }
  return { source: text, masked };
}

interface Region {
  start: number;
  end: number;
  keepsSemicolons: boolean;
}

/** The text of the first arithmetic opener whose expression holds an error of the tree. */
// code-gauge-allow functionCognitiveComplexity -- Pairs the tree's errors with the arithmetic openers around them in one walk of the error nodes.
function firstFailingRegion(root: Node, text: string): Region | undefined {
  const errors: Node[] = [];
  const openers: Node[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as Node;
    if (node.isError || node.isMissing) errors.push(node);
    if (!node.isNamed && OPENERS.has(node.type)) openers.push(node);
    if (node.hasError || node.isError) for (const child of node.children) pending.push(child);
  }
  openers.sort((a, b) => a.startIndex - b.startIndex);
  for (const opener of openers) {
    const start = opener.endIndex;
    const end = opener.type === '$[' ? matchingBracket(text, start) : matchingParentheses(text, start);
    if (end === undefined) continue;
    const fails = errors.some((error) => error.startIndex < end + 2 && error.endIndex > opener.startIndex);
    if (!fails || end === start) continue;
    const keepsSemicolons = opener.type === '((' && opener.parent?.type === 'c_style_for_statement';
    return { start, end, keepsSemicolons };
  }
  return undefined;
}

/** The offset of the `))` that closes arithmetic text starting at `start`, as Bash counts the parentheses. */
// code-gauge-allow functionCognitiveComplexity -- Bash's scan for the end of arithmetic text, which quotes, escapes, and nesting all decide.
function matchingParentheses(text: string, start: number): number | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      if (close === -1) return undefined;
      i = close;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth > 0) depth--;
      else return text[i + 1] === ')' ? i : undefined;
    }
  }
  return undefined;
}

function matchingBracket(text: string, start: number): number | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return undefined;
}
