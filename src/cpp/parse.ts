import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { rejectUnsupportedSyntax } from './stages';
import { copySyntax, type Syntax } from './syntax';

const parser = await loadParser('@willbooster/tree-sitter-cpp/tree-sitter-cpp.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  identifier: '名前',
  type_identifier: '型の名前',
  field_identifier: 'メンバの名前',
  namespace_identifier: '名前空間の名前',
  statement_identifier: 'ラベルの名前',
  primitive_type: '型',
};

/** Parses a translation unit, throwing a `CompileError` for invalid syntax or syntax the interpreter leaves out. */
export function parseCpp(source: string): Syntax {
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => {
    const syntax = copySyntax(root);
    rejectUnsupportedSyntax(syntax);
    return syntax;
  });
}

/** The `// atomic` annotations of a program, read from its line comments. */
export function findCppTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
