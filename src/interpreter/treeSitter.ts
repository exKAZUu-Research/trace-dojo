import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from './diagnostics';

// Resolving from the working directory keeps the lookup independent of how Next.js bundles this module.
const requireFromRoot = createRequire(path.join(process.cwd(), 'package.json'));
// Copying into this realm's Uint8Array passes the runtime's `instanceof` check, which a Buffer from another realm
// (as under jsdom) fails.
const readWasm = (specifier: string): Uint8Array => new Uint8Array(readFileSync(requireFromRoot.resolve(specifier)));
await Parser.init({
  wasmBinary: readWasm('@willbooster/web-tree-sitter/web-tree-sitter.wasm').buffer as ArrayBuffer,
});

export async function loadParser(languageWasmSpecifier: string): Promise<Parser> {
  const parser = new Parser();
  parser.setLanguage(await Language.load(readWasm(languageWasmSpecifier)));
  return parser;
}

/**
 * Parses a program and converts its tree while the tree is alive, throwing a {@link CompileError} for syntax errors.
 *
 * @param missingTokenNames Names for learners of the grammar's named tokens that error recovery may insert;
 * punctuation names itself.
 */
export function parseSource<T>(
  parser: Parser,
  source: string,
  missingTokenNames: Record<string, string>,
  convert: (root: Node) => T,
  { maxNestingDepth = MAX_NESTING_DEPTH, tooDeepMessage = '括弧やブロックなどの入れ子が深すぎます。' } = {}
): T {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The parser returned no tree');
  try {
    const tooDeep = findTooDeepNode(tree.rootNode, maxNestingDepth);
    if (tooDeep) {
      throw new CompileError([{ row: tooDeep.startPosition.row, message: tooDeepMessage }]);
    }
    const syntaxErrors = collectSyntaxErrors(tree.rootNode, missingTokenNames);
    if (syntaxErrors.length > 0) throw new CompileError(syntaxErrors);
    return convert(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** Converting, compiling, and running recurse into nested constructs, so deeper nesting would exhaust the stack. */
const MAX_NESTING_DEPTH = 300;

function findTooDeepNode(root: Node, maxDepth: number): Node | undefined {
  const cursor = root.walk();
  try {
    for (;;) {
      if (cursor.currentDepth > maxDepth) return cursor.currentNode;
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
      }
    }
  } finally {
    cursor.delete();
  }
}

function collectSyntaxErrors(root: Node, missingTokenNames: Record<string, string>): SourceDiagnostic[] {
  const errors: SourceDiagnostic[] = [];
  const visit = (node: Node): void => {
    if (errors.length >= 5) return;
    if (node.isMissing) {
      errors.push({
        row: rowBeforeMissing(node),
        message: `「${missingTokenNames[node.type] ?? node.type}」が足りません。`,
      });
      return;
    }
    if (node.isError) {
      errors.push({ row: node.startPosition.row, message: '書き方に誤りがあります。' });
      return;
    }
    if (!node.hasError) return;
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return errors;
}

/** The row where the code before a missing token ends, since the parser places that token at the next one. */
function rowBeforeMissing(missing: Node): number {
  for (let node: Node | null = missing; node; node = node.parent) {
    const previous = node.previousSibling;
    if (previous) return previous.endPosition.row;
  }
  return missing.startPosition.row;
}
