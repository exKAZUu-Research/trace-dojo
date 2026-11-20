import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { SourceFile } from './ast';
import { convertFile } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-zig/tree-sitter-zig.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  identifier: '名前',
  builtin_identifier: '組み込み関数の名前',
  ';': ';',
};

/** Parses a source file, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseZig(source: string, budget = new ExecutionBudget()): SourceFile {
  budget.spend(1 + Math.floor(source.length / 64));
  const file = parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => convertFile(root, budget), {
    locateErrors: (root, errors) => zigSyntaxErrors(root, source, errors),
    progress: (cost) => budget.spend(cost),
  });
  budget.spend();
  return file;
}

/**
 * Zig's parser reports the first syntax error: a missing `;` at the end of the line before the next statement, and an
 * unclosed block at the end of the file. tree-sitter's recovery reports the token after the gap, and often several.
 */
function zigSyntaxErrors(root: Node, source: string, errors: SourceDiagnostic[]): SourceDiagnostic[] {
  if (errors.length === 0) return errors;
  const first = errors.toSorted((a, b) => a.row - b.row)[0];
  const node = firstErrorNode(root);
  if (!node) return [first];
  const opens = (node.text.match(/\{/g) ?? []).length;
  const closes = (node.text.match(/\}/g) ?? []).length;
  if (node.isError && node.endIndex >= source.trimEnd().length && opens > closes) {
    return [{ ...first, row: root.endPosition.row }];
  }
  const before = source.slice(0, node.startIndex);
  const lineStart = before.lastIndexOf('\n') + 1;
  const previous = before.trimEnd();
  // A `}` ends a literal that needs `;` inside a function, but a declaration at the top level.
  const endsStatement = /[\w)\]"']$/.test(previous) || (previous.endsWith('}') && insideBlock(node));
  if (before.slice(lineStart).trim() === '' && endsStatement) {
    return [{ row: previous.split('\n').length - 1, message: '「;」が足りません。' }];
  }
  return [first];
}

function insideBlock(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) if (current.type === 'block') return true;
  return false;
}

/** The first node in source order that is a parse error or a token the parser inserted. */
function firstErrorNode(node: Node): Node | undefined {
  if (node.isError || node.isMissing) return node;
  if (!node.hasError) return undefined;
  for (const child of node.children) {
    const found = firstErrorNode(child);
    if (found) return found;
  }
  return undefined;
}

/** The `// atomic` annotations of a file, read from its line comments (not doc comments). */
export function findZigTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => /^\/\/(?![/!])/.test(comment.text)));
}
