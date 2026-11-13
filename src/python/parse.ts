import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, findSyntaxErrors, loadParser, parseSource } from '../interpreter/treeSitter';
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
export function parsePython(original: string, trace?: TraceOptions): Module {
  const source = normalizeIdentifiers(original);
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
