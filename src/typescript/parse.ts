import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
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
  return parseSource(
    parser,
    source,
    { identifier: '名前', type_identifier: '型の名前' },
    (root) => {
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
    },
    { locateErrors: (root, errors) => typeScriptSyntaxErrors(root, source, errors) }
  );
}

function typeScriptSyntaxErrors(root: Node, source: string, errors: SourceDiagnostic[]): SourceDiagnostic[] {
  const visit = (node: Node): void => {
    if (node.type === 'escape_sequence' && /^\\[0-9]/.test(node.text)) {
      const template = node.parent;
      const tagged = template?.type === 'template_string' && template.parent?.type === 'call_expression';
      const nullEscape = node.text === String.raw`\0` && !/[0-9]/.test(source[node.endIndex] ?? '');
      if (!tagged && !nullEscape)
        errors.push({ row: node.startPosition.row, message: '8進数や10進数のエスケープシーケンスは使えません。' });
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return errors.toSorted((left, right) => left.row - right.row);
}

/** The `// atomic` annotations of a program, read from its comment tokens. */
export function findTypeScriptTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
