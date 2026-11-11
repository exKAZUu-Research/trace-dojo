import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { Module } from './ast';
import { findBlockNestingError } from './blockNesting';
import { deepNestingError, isHostStackOverflow } from './hostStack';
import { findIndentationError } from './indentation';
import { ProgramConverter } from './programConverter';

const parser = await loadParser('@willbooster/tree-sitter-python/tree-sitter-python.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  identifier: '名前',
  _indent: '字下げ（インデント）',
  _dedent: '字下げ（インデント）の終わり',
  _newline: '改行',
  string_end: '文字列の終わりの引用符',
};

/**
 * Parses a module, throwing a `CompileError` for the errors CPython reports before running and for unsupported syntax.
 *
 * @param trace Makes the statements that record steps report their rows, for a model program.
 * @param library Parses a standard library module written in Python, whose imports this grader checks when they run.
 */
export function parsePython(source: string, trace?: TraceOptions, library = false): Module {
  return parseModule(source, trace, { library, namesInLocals: false });
}

/** Parses the source a program passes to `exec`, `eval`, or `compile`, whose names live in the namespace it runs in. */
/** Parses code that `exec`, `eval`, or `compile` runs, which starts with the `__future__` features it inherits. */
export function parseDynamicCode(
  source: string,
  futureFeatures: readonly string[] = [],
  allowsTopLevelAwait = false
): Module {
  return parseModule(source, undefined, { library: false, namesInLocals: true, futureFeatures, allowsTopLevelAwait });
}

function parseModule(
  source: string,
  trace: TraceOptions | undefined,
  {
    library,
    namesInLocals,
    futureFeatures = [],
    allowsTopLevelAwait = false,
  }: { library: boolean; namesInLocals: boolean; futureFeatures?: readonly string[]; allowsTopLevelAwait?: boolean }
): Module {
  const indentationError = findIndentationError(source);
  if (indentationError) throw new CompileError([indentationError]);
  try {
    return parseSourceModule(source, trace, { library, namesInLocals, futureFeatures, allowsTopLevelAwait });
  } catch (error) {
    // CPython parses up to thousands of nested levels, which converting and checking here recurse through.
    if (!isHostStackOverflow(error)) throw error;
    const row = withPythonTree(source, (root) => deepestNode(root).row);
    throw new CompileError([{ row, message: deepNestingError().message }]);
  }
}

function parseSourceModule(
  source: string,
  trace: TraceOptions | undefined,
  options: { library: boolean; namesInLocals: boolean; futureFeatures: readonly string[]; allowsTopLevelAwait: boolean }
): Module {
  const { library, namesInLocals, futureFeatures, allowsTopLevelAwait } = options;
  return parseSource(
    parser,
    source,
    MISSING_TOKEN_NAMES,
    (root) => {
      const module = new ProgramConverter(
        source,
        trace,
        namesInLocals,
        library,
        futureFeatures,
        allowsTopLevelAwait
      ).convert(root);
      const nestingError = library ? undefined : findBlockNestingError(root);
      if (nestingError) throw new CompileError([nestingError]);
      // The standard library's sources, which are known to nest little, skip the walks that measure the nesting.
      return library ? { ...module, source } : { ...module, source, nestingDepth: deepestNode(root).depth };
    },
    // Past the deepest nesting CPython's parser and compiler accept, which a long chain such as `a.b.c...` reaches,
    // converting would only take long before the host's stack ran out.
    { maxNestingDepth: library ? Number.POSITIVE_INFINITY : 24_000, tooDeepMessage: deepNestingError().message }
  );
}

/** The depth of the deepest node of a syntax tree, and its row. */
function deepestNode(root: Node): { depth: number; row: number } {
  const cursor = root.walk();
  let deepest = { depth: 0, row: 0 };
  try {
    for (;;) {
      if (cursor.currentDepth > deepest.depth) {
        deepest = { depth: cursor.currentDepth, row: cursor.startPosition.row };
      }
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return deepest;
      }
    }
  } finally {
    cursor.delete();
  }
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const PYTHON_ANNOTATION_PATTERN = /#[ \t]*atomic[ \t]*$/;

/** The `# atomic` annotations of a module, read from its comment tokens. */
// code-gauge-allow duplicateLines 15 -- Each language reads its own comment tokens with its own parser.
export function findPythonTraceAnnotations(source: string): TraceAnnotation[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The Python parser returned no tree');
  try {
    const comments: TraceAnnotation[] = [];
    const visit = (node: Node): void => {
      if (node.type === 'comment') comments.push({ index: node.startIndex, text: node.text });
      for (const child of node.children) if (child) visit(child);
    };
    visit(tree.rootNode);
    return traceAnnotationsIn(comments, PYTHON_ANNOTATION_PATTERN);
  } finally {
    tree.delete();
  }
}

/** Parses source text and hands its syntax tree to `use` while the tree is alive. */
export function withPythonTree<T>(source: string, use: (root: Node) => T): T {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The Python parser returned no tree');
  try {
    return use(tree.rootNode);
  } finally {
    tree.delete();
  }
}
