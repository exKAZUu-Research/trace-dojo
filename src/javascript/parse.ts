import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Program } from './ast';
import { ProgramConverter } from './programConverter';

// The Script goal matches how learners' files run: no `import`, and `await` is an ordinary name.
const parser = await loadParser('@willbooster/tree-sitter-javascript/tree-sitter-javascript_script.wasm');

/**
 * Parses a script, throwing a `CompileError` for invalid or unsupported syntax.
 *
 * @param trace Makes the statements that record steps report their rows, for a model program.
 */
export function parseJavaScript(source: string, trace?: TraceOptions): Program {
  return parseSource(parser, source, { identifier: '名前' }, (root) =>
    new ProgramConverter(source, trace).convert(root)
  );
}

/** The `// atomic` annotations of a script, read from its comment tokens. */
export function findJavaScriptTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
