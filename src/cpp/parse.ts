import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';
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
  return parseSource(
    parser,
    source,
    MISSING_TOKEN_NAMES,
    (root) => {
      const syntax = copySyntax(root);
      rejectUnsupportedSyntax(syntax);
      return syntax;
    },
    { locateErrors: (root, errors) => locateErrors(root, errors, source) }
  );
}

function locateErrors(root: Node, errors: SourceDiagnostic[], source: string): SourceDiagnostic[] {
  if (errors.length === 0) return errors;
  const strayElse = root
    .descendantsOfType('compound_literal_expression')
    .find(
      (node) =>
        node.hasError === false &&
        node.startPosition.row <= errors[0].row &&
        node.childForFieldName('type')?.text === 'else'
    );
  if (strayElse) return [{ row: strayElse.startPosition.row, message: '対応する if のない else は書けません。' }];
  const failure = root.descendantsOfType('ERROR')[0];
  const previous = failure?.previousNamedSibling;
  if (
    !previous ||
    !['class_specifier', 'struct_specifier', 'union_specifier', 'update_expression'].includes(previous.type)
  )
    return errors;
  const patched = parser.parse(source.slice(0, previous.endIndex) + ';' + source.slice(previous.endIndex));
  try {
    if (patched && !patched.rootNode.hasError)
      return [{ row: previous.endPosition.row, message: '「;」が足りません。' }];
  } finally {
    patched?.delete();
  }
  return errors;
}

/** The `// atomic` annotations of a program, read from its line comments. */
export function findCppTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
