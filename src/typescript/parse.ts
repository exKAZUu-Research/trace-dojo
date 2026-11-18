import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Program } from '../javascript/ast';
import { nameOf } from '../javascript/convertNodes';
import { checkTypeScript } from './checker/checker';
import { hasInvalidUnicodeEscape } from './checker/syntax';
import { javaScriptViewOf } from './jsView';
import { TypeScriptProgramConverter } from './programConverter';
import { rejectUnsupportedSyntax } from './unsupported';

/** The members that may be a get or set accessor: in a class, an object literal, an interface, or an object type. */
const accessorTypes = new Set(['method_definition', 'method_signature', 'abstract_method_signature']);

const assignmentOperandParentTypes = new Set([
  'binary_expression',
  'unary_expression',
  'update_expression',
  'type_assertion',
]);
const assignmentTypes = new Set(['assignment_expression', 'augmented_assignment_expression']);
const optionalAnnotationTypes = new Set([
  'opting_type_annotation',
  'omitting_type_annotation',
  'adding_type_annotation',
]);

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
      const diagnostics = checkWithDecodedNames(root, source);
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

/** Type-checks a program with the `\u` escapes of its names decoded, as tsc reads them, which keeps every row. */
function checkWithDecodedNames(root: Node, source: string): SourceDiagnostic[] {
  const decoded = decodeNameEscapes(root, source);
  if (decoded === source) return checkTypeScript(root);
  const tree = parser.parse(decoded);
  try {
    // A decoded name that reads as a keyword changes the tree, whose original names are then checked instead.
    return checkTypeScript(tree && tree.rootNode.toString() === root.toString() ? tree.rootNode : root);
  } finally {
    tree?.delete();
  }
}

function decodeNameEscapes(root: Node, source: string): string {
  let decoded = '';
  let end = 0;
  const visit = (node: Node): void => {
    if (node.childCount > 0) {
      for (const child of node.children) if (child) visit(child);
    } else if (node.type.endsWith('identifier') && node.text.includes('\\')) {
      decoded += source.slice(end, node.startIndex) + decodedName(node);
      end = node.endIndex;
    }
  };
  visit(root);
  return decoded + source.slice(end);
}

/** The name a node spells, or its source text when an escape is invalid there, which the converter reports. */
function decodedName(node: Node): string {
  try {
    return nameOf(node);
  } catch (error) {
    if (error instanceof CompileError) return node.text;
    throw error;
  }
}

/** The syntax errors tsc's parser reports where the tree-sitter grammar accepts the program. */
function typeScriptSyntaxErrors(root: Node, source: string, errors: SourceDiagnostic[]): SourceDiagnostic[] {
  const visit = (node: Node): void => {
    const message = numericEscapeError(node, source) ?? unicodeEscapeError(node) ?? optionalAccessorError(node);
    if (message) errors.push({ row: node.startPosition.row, message });
    const located = exponentiationBaseError(node) ?? operandAssignmentError(node) ?? optionalIndexSignatureError(node);
    if (located) errors.push(located);
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return errors.toSorted((left, right) => left.row - right.row);
}

function numericEscapeError(node: Node, source: string): string | undefined {
  if (node.type !== 'escape_sequence' || !/^\\[0-9]/.test(node.text)) return undefined;
  const nullEscape = node.text === String.raw`\0` && !/[0-9]/.test(source[node.endIndex] ?? '');
  return isTaggedTemplateEscape(node) || nullEscape ? undefined : '8進数や10進数のエスケープシーケンスは使えません。';
}

function unicodeEscapeError(node: Node): string | undefined {
  if (node.parent?.type === 'template_literal_type' || isTaggedTemplateEscape(node)) return undefined;
  return hasInvalidUnicodeEscape(node) ? 'Unicode エスケープの値は 0x10FFFF 以下にしてください。' : undefined;
}

function isTaggedTemplateEscape(node: Node): boolean {
  const template = node.parent;
  return template?.type === 'template_string' && template.parent?.type === 'call_expression';
}

/** An unparenthesized unary, `await`, or type assertion expression as the base of `**`, which tsc's parser rejects. */
function exponentiationBaseError(node: Node): SourceDiagnostic | undefined {
  const base = node.type === 'binary_expression' ? node.childForFieldName('left') : undefined;
  if (!base || node.childForFieldName('operator')?.type !== '**') return undefined;
  const row = base.startPosition.row;
  if (base.type === 'type_assertion')
    return { row, message: '** の左辺に型アサーションを書くときは、括弧で囲んでください。' };
  if (base.type !== 'unary_expression' && base.type !== 'await_expression') return undefined;
  const operator = base.firstChild?.type ?? '';
  return { row, message: `** の左辺に ${operator} 演算子を使った式を書くときは、括弧で囲んでください。` };
}

/**
 * An unparenthesized assignment as an operand of another operator, such as `a > 0 && b = 1`, which tsc's parser
 * rejects, while the tree-sitter grammar reads it as `a > 0 && (b = 1)`.
 */
function operandAssignmentError(node: Node): SourceDiagnostic | undefined {
  if (!assignmentOperandParentTypes.has(node.type)) return undefined;
  const assignment = node.children.find((child) => child && assignmentTypes.has(child.type));
  const operator = assignment?.childForFieldName('left')?.nextSibling;
  if (!operator) return undefined;
  return { row: operator.startPosition.row, message: '括弧で囲まない代入式は、演算子の対象にできません。' };
}

/** A `?`, `-?`, or `+?` after an index signature that is not a mapped type's, which tsc's parser rejects. */
function optionalIndexSignatureError(node: Node): SourceDiagnostic | undefined {
  if (node.type !== 'index_signature' || node.children.some((child) => child?.type === 'mapped_type_clause'))
    return undefined;
  const annotation = node.childForFieldName('type');
  if (!annotation || !optionalAnnotationTypes.has(annotation.type)) return undefined;
  return { row: annotation.startPosition.row, message: 'インデックスシグネチャに ? は付けられません。' };
}

/** A `?` after an accessor's name, which tsc's parser rejects wherever an accessor may appear. */
function optionalAccessorError(node: Node): string | undefined {
  const member = node.parent;
  if (node.type !== '?' || !member || !accessorTypes.has(member.type)) return undefined;
  const tokens = new Set(member.children.map((child) => child?.type));
  return tokens.has('get') || tokens.has('set') ? 'アクセサーに ? は付けられません。' : undefined;
}

/** The `// atomic` annotations of a program, read from its comment tokens. */
export function findTypeScriptTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
