import type { Node } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Library } from './ast';
import { Converter } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-dart/tree-sitter-dart.wasm');

const MISSING_TOKEN_NAMES = {
  identifier: '名前',
  type_identifier: '型の名前',
};

/**
 * Parses a Dart library, throwing a `CompileError` for invalid or unsupported syntax.
 *
 * @param isLibrary Whether the source is one of the interpreter's own libraries, which may declare `external` members.
 */
export function parseDart(source: string, isLibrary = false): Library {
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => new Converter(isLibrary).convertLibrary(root), {
    locateErrors: locateDartErrors,
  });
}

/**
 * Moves syntax errors to where the SDK reports them: an unclosed bracket at its opening bracket, and text the parser
 * could not read at the end of the line before it when that line lacks its `;`.
 */
function locateDartErrors(root: Node, errors: SourceDiagnostic[]): SourceDiagnostic[] {
  const tokens = leafTokens(root);
  const unclosed = unclosedBrackets(tokens, root.text);
  if (unclosed.length > 0) {
    return unclosed.map((token) => ({
      row: token.startPosition.row,
      message: `「${CLOSERS[token.type]}」が足りません。`,
    }));
  }
  const nodes = errorNodes(root, errors.length);
  return errors.map((error, index) => {
    const row = semicolonRow(nodes[index], tokens);
    return row === undefined ? error : { row, message: '「;」が足りません。' };
  });
}

function semicolonRow(node: Node, tokens: readonly Node[]): number | undefined {
  if (node.isMissing && node.type !== ';') return undefined;
  const index = tokens.findLastIndex((token) => token.endIndex <= node.startIndex);
  const previous = tokens[index];
  if (!previous) return undefined;
  if (previous.type === '}' && isRecoveredBodyLiteral(previous.parent)) {
    return tokens[recoveredBodyEnd(tokens, index - 1)].endPosition.row;
  }
  if (!node.isError || previous.endPosition.row >= node.startPosition.row || STATEMENT_ENDS.has(previous.type)) {
    return undefined;
  }
  // After a token that opens a statement body, the unread text is itself the statement lacking its `;`.
  return startsStatementBody(tokens, index) ? node.endPosition.row : previous.endPosition.row;
}

function startsStatementBody(tokens: readonly Node[], index: number): boolean {
  const token = tokens[index];
  if (token.type === ':' || token.type === 'else' || token.type === 'do') return true;
  if (token.type !== ')') return false;
  let depth = 0;
  for (let opener = index; opener > 0; opener--) {
    if (tokens[opener].type === ')') depth++;
    else if (tokens[opener].type === '(' && --depth === 0) return LOOP_OR_IF_KEYWORDS.has(tokens[opener - 1].type);
  }
  return false;
}

function recoveredBodyEnd(tokens: readonly Node[], end: number): number {
  while (tokens[end].type === '}') {
    const literal = tokens[end].parent;
    const element = literal?.parent;
    if (
      literal?.type !== 'set_or_map_literal' ||
      literal.namedChildCount === 0 ||
      (element?.type !== 'if_element' && element?.type !== 'for_element')
    )
      break;
    end--;
  }
  return end;
}

// The grammar can recover an embedded block missing its last semicolon as a set literal.
function isRecoveredBodyLiteral(literal: Node | null): boolean {
  if (literal?.type !== 'set_or_map_literal' || literal.namedChildCount === 0) return false;
  for (let node: Node | null = literal.parent; node?.startIndex === literal.startIndex; node = node.parent) {
    if (node.type !== 'expression_statement') continue;
    const parent = node.parent;
    const id = node.id;
    return ['body', 'consequence', 'alternative'].some((field) => parent?.childForFieldName(field)?.id === id);
  }
  return false;
}

const CLOSERS: Record<string, string> = { '{': '}', '${': '}', '(': ')', '[': ']', '?[': ']' };
const STATEMENT_ENDS = new Set([';', '{', '}']);
const LOOP_OR_IF_KEYWORDS = new Set(['if', 'for', 'while']);
const BLOCK_HEADER_KEYWORDS = new Set([...LOOP_OR_IF_KEYWORDS, 'switch', 'catch']);

/** The tokens of a tree in source order, without the zero-width ones error recovery inserts. */
function leafTokens(root: Node): Node[] {
  const tokens: Node[] = [];
  const visit = (node: Node): void => {
    if (node.childCount === 0) {
      if (!node.isMissing && node.endIndex > node.startIndex && node.type !== 'comment') tokens.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return tokens;
}

function errorNodes(root: Node, limit: number): Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    if (found.length === limit) return;
    if (node.isError || node.isMissing) {
      found.push(node);
      return;
    }
    if (node.hasError) for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

/** The brackets without a closing one, innermost first, paired as the SDK's scanner pairs them. */
function unclosedBrackets(tokens: readonly Node[], source: string): Node[] {
  const stack: number[] = [];
  const unclosed: number[] = [];
  const pairs = new Map<number, number>();
  for (const [index, token] of tokens.entries()) {
    if (token.type in CLOSERS) {
      stack.push(index);
      continue;
    }
    if (token.type !== '}' && token.type !== ')' && token.type !== ']') continue;
    const position = stack.findLastIndex((opener) => CLOSERS[tokens[opener].type] === token.type);
    if (position === -1) continue;
    unclosed.push(...stack.splice(position + 1).toReversed());
    const opener = stack.pop() as number;
    pairs.set(opener, index);
    pairs.set(index, opener);
  }
  unclosed.unshift(...stack.toReversed());
  if (unclosed.length === 1 && tokens[unclosed[0]].type === '{') {
    const blamed = misalignedOpener(tokens, pairs, unclosed[0], source);
    if (blamed !== undefined) return [tokens[blamed]];
  }
  return unclosed.map((index) => tokens[index]);
}

/**
 * The SDK scanner's `getOffsetForCurlyBracketRecoveryStart`: when a single `{` lacks its `}`, the last later `{` whose
 * `}` is indented unlike the `{`'s logical line is the one missing its `}`.
 */
function misalignedOpener(
  tokens: readonly Node[],
  pairs: ReadonlyMap<number, number>,
  unclosed: number,
  source: string
): number | undefined {
  let blamed: number | undefined;
  for (let index = unclosed + 1; index < tokens.length; index++) {
    if (tokens[index].type !== '{' && tokens[index].type !== '${') continue;
    const closer = pairs.get(index);
    if (closer === undefined || tokens[closer].startPosition.row === tokens[index].startPosition.row) continue;
    const indentation = logicalIndentation(tokens, pairs, index, source);
    if (indentation >= 0 && indentation !== logicalIndentation(tokens, pairs, closer, source)) blamed = index;
  }
  return blamed;
}

/**
 * The SDK scanner's `_spacesAtStartOfLogicalLineOf`: the column of the first token on the line of `tokens[index]`, or
 * for a block's `{` on the line of the statement that opens the block; -1 for a `{` of any other kind.
 */
function logicalIndentation(
  tokens: readonly Node[],
  pairs: ReadonlyMap<number, number>,
  index: number,
  source: string
): number {
  let anchor = index;
  if (tokens[index].type === '{') {
    const previous = tokens[index - 1]?.type;
    const opener = previous === ')' ? pairs.get(index - 1) : undefined;
    if (opener !== undefined && opener > 0) anchor = opener - 1;
    const isBlock =
      opener !== undefined
        ? BLOCK_HEADER_KEYWORDS.has(tokens[anchor].type)
        : previous === 'else' ||
          previous === 'try' ||
          previous === 'finally' ||
          (previous === '=' && tokens[index - 2]?.type === 'identifier') ||
          (previous === 'const' && tokens[index - 2]?.type === '=' && tokens[index - 3]?.type === 'identifier');
    if (!isBlock) return -1;
  }
  const lineStart = source.lastIndexOf('\n', tokens[anchor].startIndex - 1) + 1;
  let first = anchor;
  while (first > 0 && tokens[first - 1].startIndex >= lineStart) first--;
  return tokens[first].startIndex - lineStart;
}

/** The `// atomic` annotations of a program, read from its line comments. */
export function findDartTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
