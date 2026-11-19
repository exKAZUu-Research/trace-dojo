import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { Attributes, Block, Expr, Item, PathAst, Pattern, Span, TypeAst } from './ast';

/** Reparses the tokens of a macro's arguments as Rust code, keeping their rows and columns. */
export type Reparse = (text: string, convert: (root: Node) => unknown) => unknown;

export function unavailable(span: Span, what: string): never {
  throw new CompileError([{ row: span.row, message: `${what}は、この採点環境では使えません。` }]);
}

export function syntaxError(span: Span, message: string): never {
  throw new CompileError([{ row: span.row, message }]);
}

/** The state and the node helpers that every part of the conversion from the syntax tree to the AST shares. */
export abstract class SyntaxConverter {
  private readonly lines: string[];

  constructor(
    private readonly source: string,
    protected readonly reparse: Reparse,
    /** Whether the source is the standard library's declarations, which may leave out bodies and values. */
    protected readonly isStd = false
  ) {
    this.lines = source.split('\n');
  }

  abstract expr(node: Node): Expr;
  abstract pattern(node: Node): Pattern;
  abstract block(node: Node): Block;
  abstract type(node: Node): TypeAst;
  abstract typePath(node: Node): PathAst;
  abstract exprPath(node: Node): PathAst;
  protected abstract typeArgs(node: Node, allowBindings?: boolean): TypeAst[];
  protected abstract item(node: Node, attrs?: Attributes): Item | undefined;

  span(node: Node): Span {
    const { row, column } = node.startPosition;
    const line = this.lines[row] ?? '';
    return { row, col: line.slice(0, column).length + 1 };
  }

  protected onlyChild(node: Node): Node {
    const child = node.namedChildren.find((c) => !isComment(c));
    if (!child) syntaxError(this.span(node), '書き方に誤りがあります。');
    return child;
  }

  protected label(node: Node): string | undefined {
    const label = node.namedChildren.find((child) => child.type === 'label');
    return label?.text.slice(1);
  }

  protected field(node: Node, name: string): Node {
    const child = node.childForFieldName(name);
    if (!child) syntaxError(this.span(node), '書き方に誤りがあります。');
    return child;
  }
}

/** Words that edition 2024 reserves, which tree-sitter's grammar still reads as names. */
const RESERVED_WORDS = new Set([
  'abstract',
  'async',
  'await',
  'become',
  'box',
  'do',
  'dyn',
  'final',
  'gen',
  'macro',
  'override',
  'priv',
  'try',
  'typeof',
  'unsized',
  'virtual',
  'yield',
]);

export function checkNotReserved(name: string, span: Span): void {
  if (RESERVED_WORDS.has(name))
    syntaxError(span, `${name} は予約語なので、名前に使えません（r#${name} と書くか、名前を変えてください）。`);
}

export function isComment(node: Node): boolean {
  return node.type === 'line_comment' || node.type === 'block_comment';
}
