import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from './diagnostics';

// Resolving from the working directory keeps the lookup independent of how Next.js bundles this module.
const requireFromRoot = createRequire(path.join(process.cwd(), 'package.json'));
// Copying into this realm's Uint8Array passes the runtime's `instanceof` check, which a Buffer from another realm
// (as under jsdom) fails.
const readWasm = (specifier: string): Uint8Array => Uint8Array.from(readFileSync(requireFromRoot.resolve(specifier)));
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
  convert: (root: Node) => T
): T {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The parser returned no tree');
  try {
    const tooDeep = findTooDeepNode(tree.rootNode);
    if (tooDeep) {
      throw new CompileError([{ row: tooDeep.startPosition.row, message: '括弧やブロックなどの入れ子が深すぎます。' }]);
    }
    const syntaxErrors = collectSyntaxErrors(tree.rootNode, missingTokenNames, false);
    if (syntaxErrors.length > 0) throw new CompileError(syntaxErrors);
    const converted = convert(tree.rootNode);
    // The converter's own checks name the errors it recognizes better than an error only the tree's flags show.
    const hiddenErrors = collectSyntaxErrors(tree.rootNode, missingTokenNames, true);
    if (hiddenErrors.length > 0) throw new CompileError(hiddenErrors);
    return converted;
  } finally {
    tree.delete();
  }
}

/** The syntax errors of a text that is not a whole program, such as the part of one before another error. */
export function findSyntaxErrors(
  parser: Parser,
  source: string,
  missingTokenNames: Record<string, string>
): SourceDiagnostic[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The parser returned no tree');
  try {
    return collectSyntaxErrors(tree.rootNode, missingTokenNames, true);
  } finally {
    tree.delete();
  }
}

/** The `comment` tokens of `source`, in source order. */
export function commentTokens(parser: Parser, source: string): { index: number; text: string }[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The parser returned no tree');
  try {
    return tree.rootNode.descendantsOfType('comment').map((node) => ({ index: node.startIndex, text: node.text }));
  } finally {
    tree.delete();
  }
}

/** Converting, compiling, and running recurse into nested constructs, so deeper nesting would exhaust the stack. */
const MAX_NESTING_DEPTH = 300;

function findTooDeepNode(root: Node): Node | undefined {
  const cursor = root.walk();
  try {
    for (;;) {
      if (cursor.currentDepth > MAX_NESTING_DEPTH) return cursor.currentNode;
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
      }
    }
  } finally {
    cursor.delete();
  }
}

/**
 * The syntax errors a tree shows, and with `includeHidden` also where only a node's error flag shows one: a token the
 * parser inserted to recover is invisible when its grammar rule is hidden, like Python's newline and dedent.
 */
function collectSyntaxErrors(
  root: Node,
  missingTokenNames: Record<string, string>,
  includeHidden: boolean
): SourceDiagnostic[] {
  const errors: SourceDiagnostic[] = [];
  const visit = (node: Node): void => {
    if (errors.length >= 5) return;
    const own = ownError(node, missingTokenNames);
    if (own) {
      errors.push(own);
      return;
    }
    if (!node.hasError) return;
    const found = errors.length;
    for (const child of node.children) visit(child);
    if (includeHidden && errors.length === found) {
      errors.push({ row: hiddenErrorRow(node), message: '書き方に誤りがあります。' });
    }
  };
  visit(root);
  return errors;
}

/** The error a node is itself: a token the parser inserted, or text it could not parse. */
function ownError(node: Node, missingTokenNames: Record<string, string>): SourceDiagnostic | undefined {
  if (node.isMissing) {
    return { row: rowBeforeMissing(node), message: `「${missingTokenNames[node.type] ?? node.type}」が足りません。` };
  }
  return node.isError ? { row: node.startPosition.row, message: '書き方に誤りがあります。' } : undefined;
}

/**
 * The row of an error the parser recovered from with a hidden token: where two of the node's parts share a line with
 * nothing between them, as two statements do when the newline between them is missing, or else the node's own row.
 */
function hiddenErrorRow(node: Node): number {
  const { children } = node;
  for (const [index, part] of children.slice(1).entries()) {
    const previous = children[index];
    if (previous.isNamed && part.isNamed && previous.endPosition.row === part.startPosition.row) {
      return part.startPosition.row;
    }
  }
  return node.startPosition.row;
}

/** The row where the code before a missing token ends, since the parser places that token at the next one. */
function rowBeforeMissing(missing: Node): number {
  for (let node: Node | null = missing; node; node = node.parent) {
    const previous = node.previousSibling;
    if (previous) return previous.endPosition.row;
  }
  return missing.startPosition.row;
}
