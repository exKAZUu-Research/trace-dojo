import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { stripAttributes } from './attributes';
import { preprocessCpp } from './preprocessor';
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
export function parseCpp(written: string): Syntax {
  const source = preprocessCpp(written);
  return parseSource(
    parser,
    source,
    MISSING_TOKEN_NAMES,
    (root) => {
      const syntax = copySyntax(root);
      rejectUnsupportedSyntax(syntax);
      return stripAttributes(syntax);
    },
    { locateErrors: (root, errors) => locateErrors(root, errors, source) }
  );
}

export function parseInitializerArguments(parameters: Syntax): Syntax | undefined {
  const prefix = 'void initializer_probe() { initializer_probe';
  const tree = parser.parse(`${prefix}${parameters.text}; }`);
  if (!tree) return undefined;
  try {
    const { rootNode } = tree;
    if (rootNode.hasError) return undefined;
    const body = rootNode.namedChild(0)?.childForFieldName('body');
    const call = body?.namedChild(0)?.namedChild(0);
    const args = call?.childForFieldName('arguments');
    if (!args || args.endIndex !== prefix.length + parameters.text.length) return undefined;
    const syntax = copySyntax(args, 'value', { row: parameters.row, index: parameters.start - prefix.length });
    rejectUnsupportedSyntax(syntax);
    return syntax;
  } finally {
    tree.delete();
  }
}

function locateErrors(root: Node, errors: SourceDiagnostic[], source: string): SourceDiagnostic[] {
  if (errors.length === 0) return afterStringLiteral(root, source) ?? errors;
  const strayElse = root
    .descendantsOfType('compound_literal_expression')
    .find(
      (node) =>
        node.hasError === false &&
        node.startPosition.row <= errors[0].row &&
        node.childForFieldName('type')?.text === 'else'
    );
  if (strayElse) return [{ row: strayElse.startPosition.row, message: '対応する if のない else は書けません。' }];
  const firstError = root.descendantsOfType('ERROR')[0];
  const diagnosticRow = errors[0].row;
  const sites = [
    tokenBeforeRow(root, firstError?.startPosition.row ?? diagnosticRow),
    tokenBeforeRow(root, diagnosticRow),
  ];
  for (const previous of new Set(sites)) {
    if (!previous || previous.type === ';' || previous.type === '{') continue;
    const repaired = missingSemicolon(previous, source);
    if (repaired) return repaired;
  }
  return errors;
}

function afterStringLiteral(root: Node, source: string): SourceDiagnostic[] | undefined {
  for (const string of root.descendantsOfType('concatenated_string')) {
    const parts = string.namedChildren.filter((child) => child.type !== 'comment');
    for (const [index, part] of parts.entries()) {
      const previous = parts[index - 1];
      if (part.type !== 'identifier' || previous?.type !== 'string_literal') continue;
      if (part.startPosition.row <= previous.endPosition.row) continue;
      const repaired = missingSemicolon(previous, source);
      if (repaired) return repaired;
    }
  }
}

function missingSemicolon(previous: Node, source: string): SourceDiagnostic[] | undefined {
  const patched = parser.parse(source.slice(0, previous.endIndex) + ';' + source.slice(previous.endIndex));
  try {
    if (patched && !patched.rootNode.hasError)
      return [{ row: previous.endPosition.row, message: '「;」が足りません。' }];
  } finally {
    patched?.delete();
  }
}

function tokenBeforeRow(node: Node, row: number): Node | undefined {
  if (node.startPosition.row >= row || node.type === 'comment' || node.isMissing) return;
  const children = node.children;
  if (children.length === 0) return node.endPosition.row < row ? node : undefined;
  for (let index = children.length - 1; index >= 0; index--) {
    const previous = tokenBeforeRow(children[index], row);
    if (previous) return previous;
  }
}

/** The `// atomic` annotations of a program, read from its line comments. */
export function findCppTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
