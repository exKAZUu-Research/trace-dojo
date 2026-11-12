import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { findSyntaxErrors, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Module } from './ast';
import { findFirstSyntaxError } from './headerColons';
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
 */
export function parsePython(source: string, trace?: TraceOptions): Module {
  const lines = logicalLines(source);
  const indentationError = findIndentationError(source, lines);
  if (indentationError) {
    const first = findFirstSyntaxError(source, lines, syntaxErrorsOf, indentationError);
    throw new CompileError(first ?? [indentationError.diagnostic]);
  }
  try {
    return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) =>
      new ProgramConverter(source, trace).convert(root)
    );
  } catch (error) {
    const first = error instanceof CompileError ? findFirstSyntaxError(source, lines, syntaxErrorsOf) : undefined;
    throw first ? new CompileError(first) : error;
  }
}

function syntaxErrorsOf(text: string): SourceDiagnostic[] {
  return findSyntaxErrors(parser, text, MISSING_TOKEN_NAMES);
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
