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
    source,
    MISSING_TOKEN_NAMES,
    (root) => new Converter(isLibrary).convertCompilationUnit(root),
    {
      locateErrors: (_root: Node, errors: SourceDiagnostic[]) => errors.map(roslynSyntaxError),
    }
  );
}

const MISSING_TOKEN_NAMES = { identifier: '識別子' };

/** Words the shared syntax errors in the messages that Roslyn gives for the same mistakes. */
function roslynSyntaxError(diagnostic: SourceDiagnostic): SourceDiagnostic {
  const missing = /^「(.+)」が足りません。$/.exec(diagnostic.message);
  if (!missing) return { row: diagnostic.row, message: '構文エラーです。' };
  const token = missing[1];
  return { row: diagnostic.row, message: token === '識別子' ? '識別子がありません' : `${token} が必要です` };
}

/** The `// atomic` annotations of a source, read from its line comments. */
export function findCSharpTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
