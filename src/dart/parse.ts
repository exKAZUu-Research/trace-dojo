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
  const moved = new Map<number, number>();
  for (const node of errorNodes(root)) {
    const previous = tokens.findLast((token) => token.endIndex <= node.startIndex);
    if (previous && previous.endPosition.row < node.startPosition.row && !STATEMENT_ENDS.has(previous.type)) {
      moved.set(node.startPosition.row, previous.endPosition.row);
    }
  }
  return errors.map((error) => ({ ...error, row: moved.get(error.row) ?? error.row }));
}

const CLOSERS: Record<string, string> = { '{': '}', '${': '}', '(': ')', '[': ']', '?[': ']' };
const STATEMENT_ENDS = new Set([';', '{', '}']);

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

function errorNodes(root: Node): Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    if (node.isError) {
      found.push(node);
      return;
    }
    if (node.hasError) for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

/**
 * The brackets without a closing one, innermost first, paired as the SDK's scanner pairs them. When one `{` is left
 * open and the file's last `}` begins a line indented unlike the line of the `{` it closes, the SDK takes that `}` to
 * close the outer one and reports the inner `{` instead.
 */
function unclosedBrackets(tokens: readonly Node[], source: string): Node[] {
  const stack: Node[] = [];
  const unclosed: Node[] = [];
  let lastCurly: { opener: Node; closer: Node } | undefined;
  for (const token of tokens) {
    if (token.type in CLOSERS) {
      stack.push(token);
      continue;
    }
    if (token.type !== '}' && token.type !== ')' && token.type !== ']') continue;
    const index = stack.findLastIndex((opener) => CLOSERS[opener.type] === token.type);
    if (index === -1) continue;
    unclosed.push(...stack.splice(index + 1).toReversed());
    const opener = stack.pop() as Node;
    if (token.type === '}') lastCurly = { opener, closer: token };
  }
  unclosed.unshift(...stack.toReversed());
  if (
    unclosed.length === 1 &&
    unclosed[0].type === '{' &&
    lastCurly &&
    lastCurly.opener.startIndex > unclosed[0].startIndex
  ) {
    const { opener, closer } = lastCurly;
    if (startsLine(closer, source) && closer.startPosition.column !== indentationOf(opener, source)) return [opener];
  }
  return unclosed;
}

function startsLine(token: Node, source: string): boolean {
  const lineStart = source.lastIndexOf('\n', token.startIndex - 1) + 1;
  return source.slice(lineStart, token.startIndex).trim() === '';
}

function indentationOf(token: Node, source: string): number {
  const lineStart = source.lastIndexOf('\n', token.startIndex - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0].length ?? 0;
}

/** The `// atomic` annotations of a program, read from its line comments. */
export function findDartTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
