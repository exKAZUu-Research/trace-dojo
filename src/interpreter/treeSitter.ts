import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';

import { readWasm } from '#interpreterWasm';

import { CompileError, type SourceDiagnostic } from './diagnostics';

const runtimeWasm = await readWasm('@willbooster/web-tree-sitter/web-tree-sitter.wasm');
await Parser.init({ wasmBinary: runtimeWasm.buffer });

/** @param languageWasmSpecifier One of the grammars that `#interpreterWasm` resolves. */
export async function loadParser(languageWasmSpecifier: string): Promise<Parser> {
  const parser = new Parser();
  parser.setLanguage(await Language.load(await readWasm(languageWasmSpecifier)));
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
  {
    maxNestingDepth = MAX_NESTING_DEPTH,
    tooDeepMessage = NESTING_TOO_DEEP,
    locateErrors = (_root: Node, errors: SourceDiagnostic[]): SourceDiagnostic[] => errors,
    progress,
    acceptsMissing,
  }: {
    maxNestingDepth?: number;
    tooDeepMessage?: string;
    locateErrors?: (root: Node, errors: SourceDiagnostic[]) => SourceDiagnostic[];
    progress?: (cost?: number) => void;
    /** Whether a token the parser inserted stands for something the language lets a program leave out. */
    acceptsMissing?: (node: Node) => boolean;
  } = {}
): T {
  let parsingFailure: { error: unknown } | undefined;
  const tree = parser.parse(
    source,
    progress
      ? {
          progressCallback: () => {
            try {
              progress();
            } catch (error) {
              parsingFailure = { error };
              return true;
            }
          },
        }
      : undefined
  );
  if (!tree) {
    // A cancelled parse retains resumable state, which must not be reused for another program.
    parser.reset();
    if (parsingFailure) throw parsingFailure.error;
    throw new Error('The parser returned no tree');
  }
  try {
    assertNestingDepth(tree.rootNode, maxNestingDepth, tooDeepMessage, progress);
    const syntaxErrors = locateErrors(
      tree.rootNode,
      collectSyntaxErrors(tree.rootNode, missingTokenNames, false, progress, acceptsMissing)
    );
    if (syntaxErrors.length > 0) throw new CompileError(syntaxErrors);
    const converted = convert(tree.rootNode);
    // The converter's own checks name the errors it recognizes better than an error only the tree's flags show.
    const hiddenErrors = collectSyntaxErrors(tree.rootNode, missingTokenNames, true, progress, acceptsMissing);
    if (hiddenErrors.length > 0) throw new CompileError(hiddenErrors);
    return converted;
  } finally {
    tree.delete();
  }
}

/**
 * The syntax errors of a text that is not a whole program, such as the part of one before another error.
 *
 * @param includeHidden Whether to also report errors only a node's error flag shows, as {@link parseSource} does
 * after converting.
 */
export function findSyntaxErrors(
  parser: Parser,
  source: string,
  missingTokenNames: Record<string, string>,
  includeHidden = true
): SourceDiagnostic[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The parser returned no tree');
  try {
    return collectSyntaxErrors(tree.rootNode, missingTokenNames, includeHidden);
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

export const NESTING_TOO_DEEP = '括弧やブロックなどの入れ子が深すぎます。';

export function assertNestingDepth(
  root: Node,
  maxDepth = MAX_NESTING_DEPTH,
  message = NESTING_TOO_DEEP,
  progress?: () => void
): void {
  const tooDeep = findTooDeepNode(root, maxDepth, progress);
  if (tooDeep) throw new CompileError([{ row: tooDeep.startPosition.row, message }]);
}

function findTooDeepNode(root: Node, maxDepth: number, progress?: () => void): Node | undefined {
  if (maxDepth === Number.POSITIVE_INFINITY) return;
  const cursor = root.walk();
  // The cursor's own `currentDepth` takes time in proportion to the depth, which deep nesting makes quadratic.
  let depth = 0;
  try {
    for (;;) {
      progress?.();
      if (depth > maxDepth) return cursor.currentNode;
      if (cursor.gotoFirstChild()) {
        depth++;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
        depth--;
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
  includeHidden: boolean,
  progress?: (cost?: number) => void,
  acceptsMissing?: (node: Node) => boolean
): SourceDiagnostic[] {
  const errors: SourceDiagnostic[] = [];
  const isAccepted = (node: Node): boolean =>
    acceptsMissing !== undefined &&
    !node.isError &&
    (node.isMissing ? acceptsMissing(node) : node.children.every((child) => !child.hasError || isAccepted(child)));
  const visit = (node: Node): void => {
    if (errors.length >= 5) return;
    if (node.hasError && isAccepted(node)) return;
    const own = ownError(node, missingTokenNames);
    if (own) {
      errors.push(own);
      return;
    }
    if (!node.hasError) return;
    const found = errors.length;
    progress?.(node.childCount);
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
