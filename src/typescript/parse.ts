import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Program } from '../javascript/ast';
import { checkTypeScript } from './checker/checker';
import { javaScriptViewOf } from './jsView';
import { TypeScriptProgramConverter } from './programConverter';
import { rejectUnsupportedSyntax } from './unsupported';

const parser = await loadParser('@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm');

/**
 * Parses and type-checks a program, throwing a `CompileError` for invalid or unsupported syntax and for the type
 * errors `tsc --strict` reports.
 *
 * @param trace Makes the statements that record steps report their rows, for a model program.
 */
export function parseTypeScript(source: string, trace?: TraceOptions): Program {
  return parseSource(parser, source, { identifier: '名前', type_identifier: '型の名前' }, (root) => {
    rejectUnsupportedSyntax(root);
    const program = new TypeScriptProgramConverter(source, trace).convert(javaScriptViewOf(root));
    const diagnostics = checkTypeScript(root);
    if (diagnostics.length > 0) throw new CompileError(diagnostics);
    return program;
  });
}

/** The `// atomic` annotations of a program, read from its comment tokens. */
export function findTypeScriptTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
