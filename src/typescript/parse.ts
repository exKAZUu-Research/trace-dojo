import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError, diagnosticIndex, type SourceDiagnostic, sourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Program } from '../javascript/ast';
import { nameOf } from '../javascript/convertNodes';
import { checkTypeScript } from './checker/checker';
import { hasInvalidCharacterEscape, isRawTypeTemplateFragment } from './checker/syntax';
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

const multilineTokenTypes = new Set(['comment', 'string', 'template_string']);
const strictIdentifierTypes = new Set([
  'identifier',
  'type_identifier',
  'statement_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
]);
const strictReservedWords = new Set([
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'yield',
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
      const budget = new ExecutionBudget();
      rejectUnsupportedSyntax(root);
      let program: Program | undefined;
      let converterErrors: SourceDiagnostic[] = [];
      try {
        program = new TypeScriptProgramConverter(source, trace).convert(javaScriptViewOf(root, budget));
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        converterErrors = error.diagnostics;
      }
      const diagnostics = checkWithDecodedNames(root, source, budget);
      const described = new Set(diagnostics.map(diagnosticIndex).filter((index) => index !== undefined));
      const all = [
        ...diagnostics,
        ...converterErrors.filter((diagnostic) => !described.has(diagnosticIndex(diagnostic) ?? -1)),
      ].toSorted((left, right) => left.row - right.row || (diagnosticIndex(left) ?? 0) - (diagnosticIndex(right) ?? 0));
      if (all.length > 0 || !program) throw new CompileError(all);
      return program;
    },
    { locateErrors: (root, errors) => typeScriptSyntaxErrors(root, source, errors) }
  );
}

/** Type-checks a program with the `\u` escapes of its names decoded, as tsc reads them, which keeps every row. */
function checkWithDecodedNames(root: Node, source: string, budget: ExecutionBudget): SourceDiagnostic[] {
  const decoded = decodeNameEscapes(root, source, budget);
  if (decoded.text === source) return checkTypeScript(root, budget);
  const tree = parser.parse(decoded.text);
  try {
    if (!tree || tree.rootNode.toString() !== root.toString()) return checkTypeScript(root, budget);
    return restoreDiagnosticIndices(checkTypeScript(tree.rootNode, budget), decoded.offsets);
  } finally {
    tree?.delete();
  }
}

interface NameOffset {
  end: number;
  removed: number;
}

function decodeNameEscapes(
  root: Node,
  source: string,
  budget: ExecutionBudget
): { text: string; offsets: NameOffset[] } {
  if (!source.includes(String.raw`\u`)) return { text: source, offsets: [] };
  let decoded = '';
  let end = 0;
  const offsets: NameOffset[] = [];
  const visit = (node: Node): void => {
    budget.spend();
    if (node.childCount > 0) {
      for (const child of node.children) if (child) visit(child);
    } else if ((node.type.endsWith('identifier') || strictIdentifierTypes.has(node.type)) && node.text.includes('\\')) {
      decoded += source.slice(end, node.startIndex) + decodedName(node);
      end = node.endIndex;
      offsets.push({ end: decoded.length, removed: end - decoded.length });
    }
  };
  visit(root);
  return { text: decoded + source.slice(end), offsets };
}

function restoreDiagnosticIndices(diagnostics: SourceDiagnostic[], offsets: NameOffset[]): SourceDiagnostic[] {
  let current = 0;
  let removed = 0;
  return diagnostics.map((diagnostic) => {
    const index = diagnosticIndex(diagnostic);
    if (index === undefined) return diagnostic;
    while (current < offsets.length && offsets[current].end <= index) removed = offsets[current++].removed;
    return sourceDiagnostic(diagnostic.row, index + removed, diagnostic.message);
  });
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
    const message =
      numericEscapeError(node, source) ??
      characterEscapeError(node) ??
      methodModifierError(node) ??
      strictIdentifierError(node);
    if (message) errors.push({ row: node.startPosition.row, message });
    checkMixedLogicalOperators(node, errors);
    const located =
      superTypeArgumentError(node) ??
      exponentiationBaseError(node) ??
      operandAssignmentError(node) ??
      optionalIndexSignatureError(node);
    if (located) errors.push(located);
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return replaceUnterminatedStringErrors(root, source, errors).toSorted((left, right) => left.row - right.row);
}

/**
 * Names the strings left open by a raw line break or the end of the program in the text the parser could not read,
 * as tsc does. Tree-sitter's recovery does not lex that text as tsc does, so it is lexed here instead.
 */
function replaceUnterminatedStringErrors(root: Node, source: string, errors: SourceDiagnostic[]): SourceDiagnostic[] {
  const remaining = [...errors];
  const unterminated: SourceDiagnostic[] = [];
  let scannedUntil = 0;
  for (const node of outermostErrorNodes(root)) {
    const scan = unterminatedStringsIn(source, Math.max(lexingStart(root, source, node), scannedUntil), node.endIndex);
    scannedUntil = scan.end;
    for (const { endIndex } of scan.strings) {
      unterminated.push({ row: rowAt(source, endIndex), message: '文字列リテラルが閉じられていません。' });
    }
    const first = scan.strings.find(({ startIndex }) => startIndex >= node.startIndex);
    if (!first || hasErrorBefore(node, first.startIndex)) continue;
    // Each outermost ERROR node reports one generic error at its start row.
    const index = remaining.findIndex(
      (error) => error.row === node.startPosition.row && error.message === '書き方に誤りがあります。'
    );
    if (index !== -1) remaining.splice(index, 1);
  }
  return [...remaining, ...unterminated];
}

function outermostErrorNodes(root: Node): Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    if (node.isError) found.push(node);
    else if (node.hasError) for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

/**
 * Where to lex an ERROR node from: the start of its first line, where no string is open, since a quote the node
 * starts with may close a string; or, when a comment or template spans into that line, the end of that token.
 */
function lexingStart(root: Node, source: string, node: Node): number {
  const lineStart = source.lastIndexOf('\n', node.startIndex - 1) + 1;
  for (let covering = root.descendantForIndex(lineStart); covering; covering = covering.parent) {
    if (covering.startIndex < lineStart && multilineTokenTypes.has(covering.type)) {
      return Math.min(covering.endIndex, node.startIndex);
    }
  }
  return lineStart;
}

/** Whether the parser failed on text in `node` before `index`, a mistake independent of a string opening there. */
function hasErrorBefore(node: Node, index: number): boolean {
  return node.children.some(
    (child) => child.startIndex < index && (child.isError || child.isMissing || hasErrorBefore(child, index))
  );
}

/** Lexes from `start` through the end of the line holding `end`, and on to the end of a string open there. */
function unterminatedStringsIn(
  source: string,
  start: number,
  end: number
): { strings: { startIndex: number; endIndex: number }[]; end: number } {
  const lineEnd = source.indexOf('\n', Math.max(start, end - 1));
  const regionEnd = lineEnd === -1 ? source.length : lineEnd;
  const strings: { startIndex: number; endIndex: number }[] = [];
  let index = start;
  while (index < regionEnd) {
    const char = source[index];
    if (source.startsWith('//', index)) {
      index = regionEnd;
    } else if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 2;
    } else if (char === '`') {
      const close = source.indexOf('`', index + 1);
      index = close === -1 ? source.length : close + 1;
    } else if (char === "'" || char === '"') {
      const close = closingQuoteIndex(source, index);
      if (source[close] === char) {
        index = close + 1;
      } else {
        strings.push({ startIndex: index, endIndex: close });
        index = close;
      }
    } else {
      index++;
    }
  }
  return { strings, end: index };
}

/** The index of the quote closing the string opening at `opening`, or of the line break or end that leaves it open. */
function closingQuoteIndex(source: string, opening: number): number {
  let index = opening + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === source[opening] || char === '\r' || char === '\n') return index;
    index += char === '\\' ? (source.startsWith('\r\n', index + 1) ? 3 : 2) : 1;
  }
  return source.length;
}

function rowAt(source: string, index: number): number {
  let row = 0;
  for (
    let position = source.indexOf('\n');
    position !== -1 && position < index;
    position = source.indexOf('\n', position + 1)
  ) {
    row++;
  }
  return row;
}

function strictIdentifierError(node: Node): string | undefined {
  if (!strictIdentifierTypes.has(node.type)) return undefined;
  const name = decodedName(node);
  return strictReservedWords.has(name) ? `識別子が必要です。'${name}' は Strict モードでは予約語です。` : undefined;
}

function checkMixedLogicalOperators(node: Node, errors: SourceDiagnostic[]): void {
  if (node.type !== 'binary_expression') return;
  const operator = node.childForFieldName('operator')?.type;
  if (operator !== '??' && operator !== '&&' && operator !== '||') return;
  for (const field of ['left', 'right']) {
    const operand = node.childForFieldName(field);
    if (operand?.type !== 'binary_expression') continue;
    const other = operand.childForFieldName('operator');
    if (operator === '??' ? other?.type === '&&' || other?.type === '||' : other?.type === '??') {
      errors.push({
        row: operand.startPosition.row,
        message: '?? と && または || を組み合わせるときは、括弧で囲んでください。',
      });
    }
  }
}

function numericEscapeError(node: Node, source: string): string | undefined {
  if (node.type !== 'escape_sequence' || !/^\\[0-9]/.test(node.text)) return undefined;
  const nullEscape = node.text === String.raw`\0` && !/[0-9]/.test(source[node.endIndex] ?? '');
  return isRawTypeTemplateFragment(node) || isTaggedTemplateEscape(node) || nullEscape
    ? undefined
    : '8進数や10進数のエスケープシーケンスは使えません。';
}

function characterEscapeError(node: Node): string | undefined {
  if (isRawTypeTemplateFragment(node) || isTaggedTemplateEscape(node)) return undefined;
  return hasInvalidCharacterEscape(node) ? 'エスケープシーケンスの書き方に誤りがあります。' : undefined;
}

function isTaggedTemplateEscape(node: Node): boolean {
  const template = node.parent;
  return template?.type === 'template_string' && template.parent?.type === 'call_expression';
}

function superTypeArgumentError(node: Node): SourceDiagnostic | undefined {
  if (node.type !== 'call_expression' || node.childForFieldName('function')?.type !== 'super') return undefined;
  const argumentsNode = node.childForFieldName('type_arguments');
  return argumentsNode
    ? { row: argumentsNode.startPosition.row, message: 'super の呼び出しに型引数は指定できません。' }
    : undefined;
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
function methodModifierError(node: Node): string | undefined {
  const member = node.parent;
  if (!member || !accessorTypes.has(member.type)) return undefined;
  if (node.type === 'readonly') return "'readonly' 修飾子はプロパティ宣言かインデックス シグネチャにしか書けません。";
  if (node.type !== '?') return undefined;
  const tokens = new Set(member.children.map((child) => child?.type));
  return tokens.has('get') || tokens.has('set') ? 'アクセサーに ? は付けられません。' : undefined;
}

/** The `// atomic` annotations of a program, read from its comment tokens. */
export function findTypeScriptTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
