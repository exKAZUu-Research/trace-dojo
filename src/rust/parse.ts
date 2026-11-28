import type { Node, Tree } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { ExecutionBudget } from '../interpreter/limits';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { assertNestingDepth, findSyntaxErrors, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Crate } from './ast';
import { Converter } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-rust/tree-sitter-rust.wasm');

const MISSING_TOKEN_NAMES = {
  identifier: '名前',
  type_identifier: '型の名前',
  field_identifier: 'フィールドの名前',
  primitive_type: '型',
};

/** Parses a crate's single source file, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseRust(source: string, budget: ExecutionBudget): Crate {
  return parseWith(source, (root, reparseTokens) => {
    const reparseMacro: typeof reparse = (text, convert) => {
      budget.spend(Math.ceil(text.length / 64));
      return reparseTokens(text, convert);
    };
    return new Converter(source, reparseMacro).convertCrate(root);
  });
}

export function parseWith<T>(
  source: string,
  convert: (root: Node, reparseTokens: typeof reparse, source: string) => T
): T {
  try {
    return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => convert(root, reparse, source));
  } finally {
    for (const tree of reparsedTrees.splice(0)) tree.delete();
  }
}

/** The trees of macro arguments, whose nodes the converter reads until the whole program is converted. */
const reparsedTrees: Tree[] = [];

/** Parses the tokens of a macro's arguments, placed at their rows and columns by the caller. */
function reparse(text: string, convert: (root: Node) => unknown): unknown {
  const tree = parser.parse(text);
  if (!tree) throw new Error('The parser returned no tree');
  reparsedTrees.push(tree);
  assertNestingDepth(tree.rootNode);
  const errors = findSyntaxErrors(parser, text, MISSING_TOKEN_NAMES);
  if (errors.length > 0) throw new CompileError(errors);
  return convert(tree.rootNode);
}

/** The `// atomic` annotations of a program, read from its line comments (not doc comments). */
export function findRustTraceAnnotations(source: string): TraceAnnotation[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The parser returned no tree');
  try {
    const comments = tree.rootNode
      .descendantsOfType('line_comment')
      .map((node) => ({ index: node.startIndex, text: node.text }))
      .filter(({ text }) => !/^\/\/[/!](?!\/)/.test(text));
    return traceAnnotationsIn(comments);
  } finally {
    tree.delete();
  }
}
