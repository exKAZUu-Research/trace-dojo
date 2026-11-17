import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, parseSource } from '../interpreter/treeSitter';
import type { Program } from '../javascript/ast';
import { checkTypeScript } from './checker/checker';
import { javaScriptViewOf } from './jsView';
import { TypeScriptProgramConverter } from './programConverter';
import { loadTypeScriptParser } from './treeSitter';
import { rejectUnsupportedSyntax } from './unsupported';

const parser = await loadTypeScriptParser();

/**
 * Parses and type-checks a program, throwing a `CompileError` for invalid or unsupported syntax and for the type
 * errors `tsc --strict` reports.
 *
 * @param trace Makes the statements that record steps report their rows, for a model program.
 */
export function parseTypeScript(source: string, trace?: TraceOptions): Program {
  return parseSource(parser, source, { identifier: '名前', type_identifier: '型の名前' }, (root) => {
    rejectUnsupportedSyntax(root);
    let program: Program | undefined;
    let converterErrors: SourceDiagnostic[] = [];
    try {
      program = new TypeScriptProgramConverter(source, trace).convert(javaScriptViewOf(root));
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      converterErrors = error.diagnostics;
    }
    // tsc reports its grammar errors and type errors together; the type checker words a row's error first.
    const diagnostics = checkTypeScript(root);
    const rows = new Set(diagnostics.map((diagnostic) => diagnostic.row));
    const all = [...diagnostics, ...converterErrors.filter((diagnostic) => !rows.has(diagnostic.row))].toSorted(
      (a, b) => a.row - b.row
    );
    if (all.length > 0 || !program) throw new CompileError(all);
    return program;
  });
}

/** The `// atomic` annotations of a program, read from its comment tokens. */
export function findTypeScriptTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
