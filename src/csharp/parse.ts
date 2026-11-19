import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { CompilationUnit } from './ast';
import { Converter } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-c-sharp/tree-sitter-c_sharp.wasm');

/** Parses a C# source file, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseCSharp(source: string, isLibrary = false): CompilationUnit {
  return parseSource(
    parser,
    parenthesizeExpressionStatements(source),
    MISSING_TOKEN_NAMES,
    (root) => new Converter(isLibrary).convertCompilationUnit(root),
    {
      locateErrors: (root: Node, errors: SourceDiagnostic[]) => roslynSyntaxErrors(root, errors),
    }
  );
}

const MISSING_TOKEN_NAMES = { identifier: '識別子' };

/** Roslyn's codes and messages for the tokens a program may leave out. */
const MISSING_TOKENS: Record<string, string> = {
  ';': 'CS1002: ; が必要です',
  ')': 'CS1026: ) が必要です',
  '}': 'CS1513: } が必要です',
  '{': 'CS1514: { が必要です',
  ']': "CS1003: 構文エラーです。']' が必要です",
  '(': "CS1003: 構文エラーです。'(' が必要です",
  ',': "CS1003: 構文エラーです。',' が必要です",
  識別子: 'CS1001: 識別子がありません',
};

const STATEMENT_ONLY =
  'CS0201: 代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます';

/**
 * Words the syntax errors as Roslyn does where tree-sitter's recovery shows the same mistake: a missing token, or an
 * expression that is not a statement (which the grammar cannot parse as a statement at all).
 */
function roslynSyntaxErrors(root: Node, errors: SourceDiagnostic[]): SourceDiagnostic[] {
  const notStatements = new Set<number>();
  for (const error of root.descendantsOfType('ERROR')) {
    if (!error) continue;
    const next = error.nextNamedSibling;
    if (
      next?.type === 'expression_statement' &&
      next.startPosition.row === error.endPosition.row &&
      error.parent?.type === 'block'
    ) {
      notStatements.add(error.startPosition.row);
    }
  }
  return errors.map((diagnostic) => {
    if (notStatements.has(diagnostic.row)) return { row: diagnostic.row, message: STATEMENT_ONLY };
    const missing = /^「(.+)」が足りません。$/.exec(diagnostic.message);
    if (missing)
      return {
        row: diagnostic.row,
        message: MISSING_TOKENS[missing[1]] ?? `CS1003: 構文エラーです。'${missing[1]}' が必要です`,
      };
    return { row: diagnostic.row, message: `CS1525: '${firstTokenAt(root, diagnostic.row)}' は無効です` };
  });
}

/**
 * Parenthesizes expressions that stand as statements, such as `1 + 2;`, which C#'s grammar accepts (the compiler
 * then rejects them as CS0201) but tree-sitter's cannot parse; a parenthesized expression parses, keeping the rows.
 */
function parenthesizeExpressionStatements(source: string): string {
  const tree = parser.parse(source);
  if (!tree) return source;
  try {
    const edits: { index: number; text: string }[] = [];
    for (const error of tree.rootNode.descendantsOfType('ERROR')) {
      const next = error?.nextNamedSibling;
      if (
        !error ||
        next?.type !== 'expression_statement' ||
        next.startPosition.row !== error.endPosition.row ||
        error.parent?.type !== 'block'
      )
        continue;
      const semicolon = next.lastChild;
      if (semicolon?.type !== ';') continue;
      edits.push({ index: error.startIndex, text: '(' }, { index: semicolon.startIndex, text: ')' });
    }
    let result = source;
    for (const edit of edits.toSorted((a, b) => b.index - a.index))
      result = result.slice(0, edit.index) + edit.text + result.slice(edit.index);
    return result;
  } finally {
    tree.delete();
  }
}

/** The text of the first error token on a row, which Roslyn's invalid term error names. */
function firstTokenAt(root: Node, row: number): string {
  const error = root.descendantsOfType('ERROR').find((node) => node?.startPosition.row === row);
  const token = error?.firstChild ?? error;
  return token?.text.split(/\s/)[0] ?? '';
}

/** The `// atomic` annotations of a source, read from its line comments. */
export function findCSharpTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
