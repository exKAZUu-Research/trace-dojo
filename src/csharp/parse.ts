import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { CompilationUnit } from './ast';
import { Converter } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-c-sharp/tree-sitter-c_sharp.wasm');

/** Parses a C# source file, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseCSharp(source: string, isLibrary = false): CompilationUnit {
  return parseSource(
    parser,
    parenthesizeExpressionStatements(source),
    MISSING_TOKEN_NAMES,
    (root) => new Converter(isLibrary).convertCompilationUnit(root),
    {
      locateErrors: (root: Node, errors: SourceDiagnostic[]) => roslynSyntaxErrors(root, errors),
    }
  );
}

const MISSING_TOKEN_NAMES = { identifier: '識別子' };

/** Roslyn's codes and messages for the tokens a program may leave out. */
const MISSING_TOKENS: Record<string, string> = {
  ';': 'CS1002: ; が必要です',
  ')': 'CS1026: ) が必要です',
  '}': 'CS1513: } が必要です',
  '{': 'CS1514: { が必要です',
  ']': "CS1003: 構文エラーです。']' が必要です",
  '(': "CS1003: 構文エラーです。'(' が必要です",
  ',': "CS1003: 構文エラーです。',' が必要です",
  識別子: 'CS1001: 識別子がありません',
};

/**
 * Words the syntax errors as Roslyn does for the mistakes learners make most: a token left out, which tree-sitter
 * shows as a missing node or as an error spanning the next line, an unclosed parenthesis or brace, and an operator
 * without its operand.
 */
function roslynSyntaxErrors(root: Node, errors: SourceDiagnostic[]): SourceDiagnostic[] {
  const strayElse = strayElseErrors(root);
  if (strayElse) return strayElse;
  const misplaced = misplacedKeywordError(root);
  if (misplaced) return [misplaced];
  const diagnostics: SourceDiagnostic[] = [];
  for (const diagnostic of errors) {
    const missing = /^「(.+)」が足りません。$/.exec(diagnostic.message);
    if (missing) {
      const token = missing[1] === ';' && endsDeclarationBeforeMore(root, diagnostic.row) ? ',' : missing[1];
      const message = MISSING_TOKENS[token] ?? `CS1003: 構文エラーです。'${token}' が必要です`;
      diagnostics.push({ row: diagnostic.row, message });
    }
  }
  for (const error of outermostErrors(root)) diagnostics.push(...roslynErrorsOf(root, error));
  return diagnostics.toSorted((a, b) => a.row - b.row);
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'abstract',
  'sealed',
  'virtual',
  'override',
  'readonly',
  'new',
  'extern',
]);

const TYPE_KEYWORDS = new Set([
  'void',
  'int',
  'long',
  'short',
  'byte',
  'char',
  'bool',
  'string',
  'double',
  'float',
  'decimal',
  'object',
]);

/**
 * The error of a member declaration whose modifiers or type a typo breaks, which the grammar reads as identifiers: a
 * modifier after the type, as in `pubilc static` or `void static`, or a type after a misspelled one, as in
 * `Static void`.
 */
function misplacedKeywordError(root: Node): SourceDiagnostic | undefined {
  const keyword = leavesOf(root).find(
    (leaf) =>
      leaf.type === 'identifier' &&
      (MODIFIERS.has(leaf.text) || TYPE_KEYWORDS.has(leaf.text)) &&
      ancestorOfType(leaf, 'block') === undefined &&
      ancestorOfType(leaf, 'declaration_list') !== undefined
  );
  if (!keyword) return undefined;
  const row = keyword.startPosition.row;
  if (MODIFIERS.has(keyword.text))
    return { row, message: `CS1585: メンバーの種類と名前の前にメンバー修飾子'${keyword.text}' が必要です` };
  return { row, message: `CS1519: メンバー宣言のトークン '${keyword.text}' が無効です` };
}

/**
 * The errors of an `else` inside the block it should follow, as `if (x) { a(); else { b(); }`, which the grammar reads
 * as an identifier: Roslyn reads a statement that cannot start with `else`, then misses the block's `}` at the end.
 */
function strayElseErrors(root: Node): SourceDiagnostic[] | undefined {
  const leaves = leavesOf(root);
  const stray = leaves.find((leaf) => leaf.type === 'identifier' && leaf.text === 'else');
  if (!stray) return undefined;
  const row = stray.startPosition.row;
  const diagnostics: SourceDiagnostic[] = [
    { row, message: "CS8641: 'else' でステートメントを開始することはできません。" },
    { row, message: MISSING_TOKENS['('] },
    { row, message: "CS1525: 'else' は無効です" },
    { row, message: MISSING_TOKENS[')'] },
    { row, message: MISSING_TOKENS[';'] },
  ];
  const opened = leaves.filter((leaf) => leaf.type === '{' && !leaf.isMissing).length;
  const closed = leaves.filter((leaf) => leaf.type === '}' && !leaf.isMissing).length;
  if (opened > closed) diagnostics.push({ row: lastLeafOf(root).endPosition.row, message: MISSING_TOKENS['}'] });
  return diagnostics;
}

/**
 * Whether a top-level local declaration lacks its `;` on a row before more code, where Roslyn expects another
 * declarator; inside a method it expects the `;`.
 */
function endsDeclarationBeforeMore(root: Node, row: number): boolean {
  const missing = leavesOf(root).find((leaf) => leaf.isMissing && leaf.type === ';' && leaf.startPosition.row === row);
  if (missing?.parent?.type !== 'local_declaration_statement' || missing.parent.parent?.type !== 'global_statement')
    return false;
  const next = nextLeafOf(root, missing);
  return next !== undefined && next.type !== '}';
}

function outermostErrors(root: Node): Node[] {
  return root.descendantsOfType('ERROR').filter((error): error is Node => error !== null && !hasErrorAncestor(error));
}

function hasErrorAncestor(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) if (current.type === 'ERROR') return true;
  return false;
}

// code-gauge-allow functionCognitiveComplexity 18 -- Each branch handles one case of the C# rule that the function applies.
function roslynErrorsOf(root: Node, error: Node): SourceDiagnostic[] {
  const tokens = leavesOf(error);
  // Roslyn reads on into a top-level declaration, expecting another declarator, where in a method it expects `;`.
  const inDeclaration =
    ancestorOfType(error, 'variable_declaration') !== undefined &&
    ancestorOfType(error, 'global_statement') !== undefined;
  const quote = unterminatedQuote(tokens);
  if (quote) {
    // An unterminated string ends at the line's end, after which a declaration expects its next declarator.
    const row = quote.startPosition.row;
    const diagnostics = [{ row, message: 'CS1010: 定数の 新しい行です' }];
    const declares =
      ancestorOfType(error, 'variable_declaration') !== undefined || tokens.some((token) => token.type === '=');
    const before = tokens.filter((token) => token.startIndex < quote.startIndex);
    // A string in a call's arguments leaves the call and its statement open too.
    const inArguments =
      before.filter((token) => token.type === '(').length > before.filter((token) => token.type === ')').length;
    if (inArguments) diagnostics.push({ row, message: MISSING_TOKENS[')'] });
    if (inDeclaration) diagnostics.push({ row, message: MISSING_TOKENS[','] });
    else if (declares || inArguments) diagnostics.push({ row, message: MISSING_TOKENS[';'] });
    // The string swallows the rest of its line, with the braces that would have closed the blocks.
    const opened =
      before.filter((token) => token.type === '{').length - before.filter((token) => token.type === '}').length;
    if (opened > 0 && !nextLeafOf(root, error))
      diagnostics.push({ row: lastLeafOf(root).endPosition.row, message: MISSING_TOKENS['}'] });
    return diagnostics;
  }
  // A character literal of several characters, as `'ab'`.
  const charOpening = tokens.find((token) => token.type === "'");
  const charClosing =
    charOpening && tokens.find((token) => token.type === "'" && token.startIndex > charOpening.startIndex);
  if (
    charOpening &&
    charClosing &&
    charClosing.startIndex - charOpening.endIndex > 1 &&
    !root.text.slice(charOpening.endIndex, charClosing.startIndex).startsWith('\\')
  )
    return [{ row: charOpening.startPosition.row, message: 'CS1012: 文字リテラルに文字が多すぎます' }];
  if (error.parent?.type === 'compilation_unit' && tokens.every((token) => token.type === '}')) {
    return [{ row: error.startPosition.row, message: 'CS1022: 型、名前空間の定義、またはファイルの終わりが必要です' }];
  }
  return [roslynErrorOf(root, error, tokens, inDeclaration)];
}

/** The opening quote of a string that its line does not close, which the grammar leaves in an error. */
function unterminatedQuote(tokens: Node[]): Node | undefined {
  // Quotes pair up in order: each opening one with the next, which must be on its line.
  let opening: Node | undefined;
  for (const token of tokens) {
    if (token.type !== '"') continue;
    if (!opening) opening = token;
    else if (token.startPosition.row !== opening.startPosition.row) return opening;
    else opening = undefined;
  }
  return opening;
}

// code-gauge-allow functionCognitiveComplexity 23 -- Each branch handles one case of the C# rule that the function applies.
function roslynErrorOf(root: Node, error: Node, tokens: Node[], inDeclaration: boolean): SourceDiagnostic {
  const count = (text: string): number => tokens.filter((token) => token.type === text).length;
  // A `for` header with a comma for its second `;`, as `for (int i = 0; i < 3, i++)`.
  if (tokens[0]?.type === 'for' && count(';') < 2) {
    const lastSemicolon = tokens.findLast((token) => token.type === ';');
    const comma = tokens.find(
      (token) => token.type === ',' && (!lastSemicolon || token.startIndex > lastSemicolon.startIndex)
    );
    return { row: (comma ?? tokens[0]).startPosition.row, message: MISSING_TOKENS[';'] };
  }
  // An expression statement whose `;` is missing before the `}` that closes its block, as `{ i++ }`.
  const children = error.namedChildren.filter((child): child is Node => child !== null);
  if (
    children.length === 1 &&
    children[0].endIndex === error.endIndex &&
    nextLeafOf(root, error)?.type === '}' &&
    /expression|identifier/.test(children[0].type)
  )
    return { row: error.endPosition.row, message: MISSING_TOKENS[';'] };
  if (count('{') > count('}') && !nextLeafOf(root, error)) {
    return { row: lastLeafOf(root).endPosition.row, message: MISSING_TOKENS['}'] };
  }
  const open = tokens.find((token) => token.type === '(');
  if (open && count('(') > count(')')) {
    // Roslyn expects `)` after the last token before the one that cannot continue the parenthesized part.
    const stop = tokens.find((token) => token.startIndex > open.startIndex && token.type === '{');
    const before = stop ? tokens.findLast((token) => token.endIndex <= stop.startIndex) : open;
    return { row: (before ?? open).endPosition.row, message: MISSING_TOKENS[')'] };
  }
  const previous = previousLeafOf(root, error);
  const first = tokens[0] ?? error;
  if (previous && first.startPosition.row > previous.endPosition.row) {
    return { row: previous.endPosition.row, message: inDeclaration ? MISSING_TOKENS[','] : MISSING_TOKENS[';'] };
  }
  if (previous && ancestorOfType(error, 'variable_declarator') && /^[\p{L}_]/u.test(first.text)) {
    return { row: previous.endPosition.row, message: inDeclaration ? MISSING_TOKENS[','] : MISSING_TOKENS[';'] };
  }
  const next = nextLeafOf(root, error);
  if (tokens.length > 0 && tokens.every((token) => OPERATORS.has(token.type)) && next) {
    return { row: next.startPosition.row, message: `CS1525: '${next.text}' は無効です` };
  }
  return { row: first.startPosition.row, message: `CS1525: '${first.text.split(/\s/)[0]}' は無効です` };
}

const OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '&&',
  '||',
  '=',
  '+=',
  '-=',
  '&',
  '|',
  '^',
]);

function leavesOf(node: Node): Node[] {
  if (node.childCount === 0) return [node];
  return node.children.filter((child): child is Node => child !== null).flatMap(leavesOf);
}

function lastLeafOf(node: Node): Node {
  return leavesOf(node).at(-1) ?? node;
}

function previousLeafOf(root: Node, node: Node): Node | undefined {
  return leavesOf(root).findLast((leaf) => leaf.endIndex <= node.startIndex && leaf.type !== 'comment');
}

function nextLeafOf(root: Node, node: Node): Node | undefined {
  return leavesOf(root).find(
    (leaf) => leaf.startIndex >= node.endIndex && leaf.id !== node.id && !leaf.isMissing && leaf.type !== 'comment'
  );
}

function ancestorOfType(node: Node, type: string): Node | undefined {
  for (let current = node.parent; current; current = current.parent) if (current.type === type) return current;
  return undefined;
}

/**
 * Parenthesizes expressions that stand as statements, such as `1 + 2;`, which C#'s grammar accepts (the compiler
 * then rejects them as CS0201) but tree-sitter's cannot parse; a parenthesized expression parses, keeping the rows.
 */
function parenthesizeExpressionStatements(source: string): string {
  const tree = parser.parse(source);
  if (!tree) return source;
  try {
    const joined = [...parenthesizedErrors(tree.rootNode), ...parenthesizedSplitStatements(tree.rootNode)];
    const edits = [...joined, ...parenthesizedStatements(tree.rootNode, source, joined)];
    let result = source;
    for (const edit of edits.toSorted((a, b) => b.index - a.index))
      result = result.slice(0, edit.index) + edit.text + result.slice(edit.index);
    return result;
  } finally {
    tree.delete();
  }
}

interface Edit {
  index: number;
  text: string;
}

/** `x + 1;` read as an error `x` and the statement `+ 1;` on the same row, which the edits join as one expression. */
function parenthesizedErrors(root: Node): Edit[] {
  const edits: Edit[] = [];
  for (const error of root.descendantsOfType('ERROR')) {
    const sibling = error?.nextNamedSibling;
    // A top-level statement is wrapped in a global statement.
    const next = sibling?.type === 'global_statement' ? sibling.firstNamedChild : sibling;
    if (
      !error ||
      next?.type !== 'expression_statement' ||
      next.startPosition.row !== error.endPosition.row ||
      !isStatementHolder(error.parent)
    )
      continue;
    const semicolon = next.lastChild;
    if (semicolon?.type !== ';') continue;
    edits.push({ index: error.startIndex, text: '(' }, { index: semicolon.startIndex, text: ')' });
  }
  return edits;
}

/** The statement after one, looking through the global statements that wrap top-level ones. */
function statementAfter(statement: Node): Node | null {
  const holder = statement.parent?.type === 'global_statement' ? statement.parent : statement;
  const next = holder.nextNamedSibling;
  return next?.type === 'global_statement' ? next.firstNamedChild : next;
}

/** `1 + 2;` read as `1` without its `;` and then `+2;`, which the edits join as one expression. */
function parenthesizedSplitStatements(root: Node): Edit[] {
  const edits: Edit[] = [];
  for (const statement of root.descendantsOfType('expression_statement')) {
    const missing = statement?.lastChild;
    if (!statement || !missing?.isMissing || missing.type !== ';') continue;
    const next = statementAfter(statement);
    const operator = next?.firstChild?.firstChild;
    if (next?.type !== 'expression_statement' || next.startPosition.row !== statement.endPosition.row) continue;
    if (!operator || !['+', '-', '*', '/', '%', '==', '!=', '<', '>'].includes(operator.type)) continue;
    const semicolon = next.lastChild;
    if (semicolon?.type !== ';' || semicolon.isMissing) continue;
    edits.push({ index: statement.startIndex, text: '(' }, { index: semicolon.startIndex, text: ')' });
  }
  return edits;
}

/**
 * The edits that parenthesize the other statements with an error inside, such as `x + y;`, `x ? 1 : 2;`, or a `switch`
 * expression, which tree-sitter reads as broken declarations, labels, or blocks: from such a statement to the first
 * `;` of it or of the statements after it whose text parses as an expression once parenthesized.
 */
function parenthesizedStatements(root: Node, source: string, edits: Edit[]): Edit[] {
  const added: Edit[] = [];
  let covered = -1;
  for (const statement of root.descendantsOfType([
    'expression_statement',
    'local_declaration_statement',
    'labeled_statement',
  ])) {
    if (!statement?.hasError || statement.startIndex < covered) continue;
    const holder = statement.parent?.type === 'global_statement' ? statement.parent : statement;
    if (holder === statement && !isStatementHolder(statement.parent)) continue;
    if (edits.some((edit) => edit.index >= statement.startIndex && edit.index < statement.endIndex)) continue;
    const end = expressionEnd(holder, statement.startIndex, source);
    if (end === undefined) continue;
    added.push({ index: statement.startIndex, text: '(' }, { index: end, text: ')' });
    covered = end;
  }
  return added;
}

/** Whether a node holds statements: a block, the compilation unit, or a statement that embeds one, as `if` does. */
function isStatementHolder(node: Node | null): boolean {
  return node !== null && STATEMENT_HOLDERS.has(node.type);
}

const STATEMENT_HOLDERS = new Set([
  'block',
  'compilation_unit',
  'if_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'foreach_statement',
]);

/** The position of the first `;`, of a statement or of a few after it, up to which the text from `start` parses. */
function expressionEnd(holder: Node, start: number, source: string): number | undefined {
  // Roslyn reads `a ? b` as a declaration of a nullable type, so `a ? b : c;` is not an expression to it.
  if (/^[A-Z_a-z]\w*\s*\?\s*[@A-Z_a-z]/u.test(source.slice(start))) return undefined;
  let current: Node | null = holder;
  for (let count = 0; current && count < 8; count++, current = current.nextNamedSibling) {
    const semicolon = lastToken(current);
    if (semicolon.type !== ';' || semicolon.isMissing) continue;
    if (parsesAsExpression(source.slice(start, semicolon.startIndex))) return semicolon.startIndex;
  }
  return undefined;
}

function lastToken(node: Node): Node {
  let current = node;
  while (current.lastChild) current = current.lastChild;
  return current;
}

/** Whether a text parses without errors as a parenthesized expression statement. */
function parsesAsExpression(text: string): boolean {
  const tree = parser.parse(`class C { void M() { (${text}); } }`);
  if (!tree) return false;
  try {
    return !tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}

/** The `// atomic` annotations of a source, read from its line comments. */
export function findCSharpTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
