import type { Node } from '@willbooster/web-tree-sitter';

import { loadParser, parseSource } from '../../../../interpreter/treeSitter';
import { uniqueCandidates } from '../../candidates';
import type { Candidate, Selector } from '../../types';
import { replacementsFor } from './mutations';
import { type Emit, meaningfulChildren, rules } from './rules';

const parser = await loadParser('@willbooster/tree-sitter-java/tree-sitter-java.wasm');

/** DFS visits nested constructs even when their ancestors are disabled. Parser nodes never escape the lifetime of parseSource. */
// code-gauge-allow functionCognitiveComplexity 20 -- The DFS stack and enabled-rule dispatch share one traversal lifetime.
export function collectJavaCandidates(source: string, selectors: readonly Selector[]): Candidate[] {
  const enabled = rules.filter((rule) => selectors.includes(rule.selector));
  return parseSource(parser, source, { identifier: '名前' }, (root) => {
    const candidates: Candidate[] = [];
    const emit = emitter(source, candidates, selectors);
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const rule of enabled) if (rule.nodeTypes.includes(node.type)) rule.collect(node, emit);
      if (node.type.endsWith('comment') || node.type === 'string_literal' || node.type === 'character_literal')
        continue;
      for (const child of node.children.toReversed()) if (child) stack.push(child);
    }
    return uniqueCandidates(candidates);
  });
}

/** Outer header parentheses and statement semicolons stay visible. Expression punctuation stays inside whole-expression candidates. */
// code-gauge-allow functionCognitiveComplexity 17 -- Range normalization keeps all boundary checks adjacent to the source slice.
function emitter(source: string, candidates: Candidate[], selectors: readonly Selector[]): Emit {
  return (original, role = 'expression', start = original?.startIndex, end = original?.endIndex) => {
    if (!original || start === undefined || end === undefined) return;
    const node = unwrap(original, start, end);
    if (!node) return;
    if (node !== original) {
      start = node.startIndex;
      end = node.endIndex;
    }
    while (start < end && /\s/.test(source[start])) start++;
    while (end > start && /\s/.test(source[end - 1])) end--;
    if (source[end - 1] === ';') end--;
    if (start >= end) return;
    candidates.push({ start, end, replacements: replacementsFor(node, role, source.slice(start, end), selectors) });
  };
}

function unwrap(node: Node, start: number, end: number): Node | undefined {
  const parent = node.parent;
  const header =
    parent &&
    ['if_statement', 'while_statement', 'do_statement', 'switch_expression'].includes(parent.type) &&
    parent.childForFieldName('condition')?.id === node.id;
  return header && node.type === 'parenthesized_expression' && start === node.startIndex && end === node.endIndex
    ? meaningfulChildren(node)[0]
    : node;
}
