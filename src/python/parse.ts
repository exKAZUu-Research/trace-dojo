import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, findSyntaxErrors, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Module } from './ast';
import { findBlockNestingError } from './blockNesting';
import { findFirstSyntaxError } from './headerColons';
import { deepNestingError, isHostStackOverflow } from './hostStack';
import { findIndentationError, logicalLines } from './indentation';
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

/** Parses code that `exec`, `eval`, or `compile` runs, which starts with the `__future__` features it inherits. */
export function parseDynamicCode(
  source: string,
  futureFeatures: readonly string[] = [],
  allowsTopLevelAwait = false,
  optimize = 0
): Module {
  return parseModule(source, undefined, {
    library: false,
    namesInLocals: true,
    futureFeatures,
    allowsTopLevelAwait,
    optimize,
  });
}

function parseModule(
  original: string,
  trace: TraceOptions | undefined,
  {
    library,
    namesInLocals,
    futureFeatures = [],
    allowsTopLevelAwait = false,
    optimize = 0,
  }: {
    library: boolean;
    namesInLocals: boolean;
    futureFeatures?: readonly string[];
    allowsTopLevelAwait?: boolean;
    optimize?: number;
  }
): Module {
  const source = library ? original : normalizeIdentifiers(original);
  const { lines, limitError } = library ? { lines: [], limitError: undefined } : logicalLines(source);
  const indentationError = library ? undefined : findIndentationError(source, lines, limitError);
  if (indentationError) {
    const first = findFirstSyntaxError(source, lines, syntaxErrorsOf, indentationError);
    throw new CompileError(first ?? [indentationError.diagnostic]);
  }
  try {
    return parseSourceModule(source, trace, { library, namesInLocals, futureFeatures, allowsTopLevelAwait, optimize });
  } catch (error) {
    if (!library && error instanceof CompileError) {
      const first = findFirstSyntaxError(source, lines, syntaxErrorsOf);
      if (first) throw new CompileError(first);
    }
    // CPython parses up to thousands of nested levels, which converting and checking here recurse through.
    if (!isHostStackOverflow(error)) throw error;
    const row = withPythonTree(source, (root) => deepestNode(root).row);
    throw new CompileError([{ row, message: deepNestingError().message }]);
  }
}

function parseSourceModule(
  source: string,
  trace: TraceOptions | undefined,
  options: {
    library: boolean;
    namesInLocals: boolean;
    futureFeatures: readonly string[];
    allowsTopLevelAwait: boolean;
    optimize: number;
  }
): Module {
  const { library, namesInLocals, futureFeatures, allowsTopLevelAwait, optimize } = options;
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
        allowsTopLevelAwait,
        optimize
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
  // The cursor's own `currentDepth` takes time in proportion to the depth, which deep nesting makes quadratic.
  let depth = 0;
  try {
    for (;;) {
      if (depth > deepest.depth) deepest = { depth, row: cursor.startPosition.row };
      if (cursor.gotoFirstChild()) {
        depth++;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return deepest;
        depth--;
      }
    }
  } finally {
    cursor.delete();
  }
}

const KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/**
 * The source with each identifier in NFKC form, as CPython's tokenizer reads names (PEP 3131), so that `ｘ` and `x`
 * name one variable, attribute, or keyword argument. A name that normalizes to a keyword stays as written, since the
 * tokenizer recognizes keywords before normalizing. Identifiers lie within one line, so rows keep their meaning.
 */
function normalizeIdentifiers(source: string): string {
  // oxlint-disable-next-line eslint/no-control-regex -- Only text outside ASCII can change under NFKC.
  if (!/[^\u0000-\u007F]/.test(source)) return source;
  const tree = parser.parse(source);
  if (!tree) throw new Error('The Python parser returned no tree');
  try {
    let result = '';
    let copied = 0;
    for (const node of tree.rootNode.descendantsOfType('identifier')) {
      const normalized = node.text.normalize('NFKC');
      if (normalized === node.text || KEYWORDS.has(normalized)) continue;
      result += source.slice(copied, node.startIndex) + normalized;
      copied = node.endIndex;
    }
    return result + source.slice(copied);
  } finally {
    tree.delete();
  }
}

function syntaxErrorsOf(text: string): SourceDiagnostic[] {
  return findSyntaxErrors(parser, text, MISSING_TOKEN_NAMES);
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const PYTHON_ANNOTATION_PATTERN = /#[ \t]*atomic[ \t]*$/;

/** The `# atomic` annotations of a module, read from its comment tokens. */
export function findPythonTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source), PYTHON_ANNOTATION_PATTERN);
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
