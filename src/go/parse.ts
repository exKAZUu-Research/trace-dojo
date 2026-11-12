import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { File } from './ast';
import { Converter } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-go/tree-sitter-go.wasm');

/** Parses a source file, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseGo(source: string): File {
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => {
    const newlineErrors = findMisplacedNewlines(root);
    if (newlineErrors.length > 0) throw new CompileError(newlineErrors);
    return new Converter().convertFile(root);
  });
}

const MISSING_TOKEN_NAMES = {
  identifier: '名前',
  type_identifier: '型の名前',
  field_identifier: '名前',
  package_identifier: 'パッケージの名前',
};

/** The `// atomic` annotations of a file, read from its comment tokens. */
export function findGoTraceAnnotations(source: string): TraceAnnotation[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The Go parser returned no tree');
  try {
    const comments: TraceAnnotation[] = [];
    const visit = (node: Node): void => {
      if (node.type === 'comment' && node.text.startsWith('//')) {
        comments.push({ index: node.startIndex, text: node.text });
      }
      for (const child of node.children) if (child) visit(child);
    };
    visit(tree.rootNode);
    return traceAnnotationsIn(comments);
  } finally {
    tree.delete();
  }
}

/** The tokens after which Go's lexer ends a statement at a newline. */
const SEMICOLON_TRIGGERS = new Set([
  'identifier',
  'field_identifier',
  'type_identifier',
  'package_identifier',
  'label_name',
  'blank_identifier',
  'int_literal',
  'float_literal',
  'imaginary_literal',
  'rune_literal',
  'true',
  'false',
  'nil',
  'iota',
  'break',
  'continue',
  'fallthrough',
  'return',
  '++',
  '--',
  ')',
  ']',
  '}',
]);

/** The constructs whose elements a semicolon separates, where a newline may end an element. */
const SEMICOLON_LISTS = new Set([
  'source_file',
  'block',
  'statement_list',
  'field_declaration_list',
  'interface_type',
  'import_spec_list',
  'import_declaration',
  'var_spec_list',
  'var_declaration',
  'const_declaration',
  'type_declaration',
  'expression_switch_statement',
  'type_switch_statement',
  'select_statement',
  'expression_case',
  'type_case',
  'default_case',
  'communication_case',
  'labeled_statement',
]);

/**
 * Finds newlines that Go's lexer turns into a semicolon where the grammar allows none, which tree-sitter's grammar,
 * lacking the lexer's rule, accepts: a `{` or `else` on the next line, or a list of arguments or elements whose line
 * ends without a comma.
 */
function findMisplacedNewlines(root: Node): SourceDiagnostic[] {
  const leaves: Node[] = [];
  const collect = (node: Node): void => {
    if (node.type === 'comment') return;
    // A string's content may hold newlines (raw strings), but only its closing quote ends a token.
    if (node.childCount === 0 || node.type.endsWith('string_literal') || node.type === 'rune_literal') {
      leaves.push(node);
      return;
    }
    for (const child of node.children) if (child) collect(child);
  };
  collect(root);
  const errors: SourceDiagnostic[] = [];
  for (let index = 0; index + 1 < leaves.length; index++) {
    const token = leaves[index];
    const next = leaves[index + 1];
    if (next.startPosition.row <= token.endPosition.row || !triggersSemicolon(token)) continue;
    const container = commonAncestor(token, next);
    if (container && SEMICOLON_LISTS.has(container.type)) continue;
    errors.push({ row: token.endPosition.row, message: newlineMessage(next) });
    if (errors.length >= 5) break;
  }
  return errors;
}

function triggersSemicolon(token: Node): boolean {
  if (token.type.endsWith('string_literal') || token.type === 'rune_literal') return true;
  return SEMICOLON_TRIGGERS.has(token.type);
}

function newlineMessage(next: Node): string {
  if (next.type === '{') return '{ は、前の行の終わりに書いてください（Go では行の終わりで文が終わります）。';
  if (next.type === 'else') return 'else は、前の } と同じ行に書いてください。';
  return '行の終わりに「,」が足りないか、式の途中で改行しています（Go では行の終わりで文が終わります）。';
}

function commonAncestor(a: Node, b: Node): Node | undefined {
  const ancestors = new Set<number>();
  for (let node: Node | null = a.parent; node; node = node.parent) ancestors.add(node.id);
  for (let node: Node | null = b.parent; node; node = node.parent) if (ancestors.has(node.id)) return node;
  return undefined;
}
