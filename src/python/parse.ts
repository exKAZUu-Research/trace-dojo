import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { Module } from './ast';
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
export function parseDynamicCode(source: string): Module {
  return parseModule(source, undefined, { library: false, namesInLocals: true });
}

function parseModule(
  source: string,
  trace: TraceOptions | undefined,
  { library, namesInLocals }: { library: boolean; namesInLocals: boolean }
): Module {
  const indentationError = findIndentationError(source);
  if (indentationError) throw new CompileError([indentationError]);
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) =>
    new ProgramConverter(source, trace, namesInLocals, library).convert(root)
  );
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
