import type { Node } from '@willbooster/web-tree-sitter';
import { eastAsianWidth } from 'get-east-asian-width';

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
  private readonly columns = new Map<number, SourceColumns>();

  constructor(
    source: string,
    protected readonly reparse: Reparse,
    /** Whether the source is the standard library's declarations, which may leave out bodies and values. */
    protected readonly isStd = false
  ) {
    for (const [row, line] of source.split('\n').entries()) {
      if (/[\t\u0080-\uFFFF]/.test(line)) this.columns.set(row, measureColumns(line));
    }
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
    const columns = this.columns.get(row);
    if (!columns) return { row, col: column + 1 };
    return { row, col: columns.scalars[column] + 1, displayCol: columns.display[column] + 1 };
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

interface SourceColumns {
  scalars: Uint32Array;
  display: Uint32Array;
}

function measureColumns(line: string): SourceColumns {
  const scalars = new Uint32Array(line.length + 1);
  const display = new Uint32Array(line.length + 1);
  let offset = 0;
  let count = 0;
  let width = 0;
  for (const char of line) {
    offset += char.length;
    scalars[offset] = ++count;
    width += displayWidth(char);
    display[offset] = width;
  }
  return { scalars, display };
}

// rustc makes bidi controls visible and counts each scalar using unicode-width's non-CJK rules.
const VISIBLE_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/u;
const ZERO_WIDTH =
  /[\p{Default_Ignorable_Code_Point}\p{Grapheme_Extend}\u0605\u070F\u0890-\u0891\u08E2\u0D4E\u1160-\u11FF\uA8FA\uD7B0-\uD7C6\uD7CB-\uD7FB\u{111C2}-\u{111C3}\u{113D1}\u{1193F}\u{11941}\u{11A84}-\u{11A89}\u{11D46}\u{11F02}]/u;

function displayWidth(char: string): number {
  if (char === '\t') return 4;
  if (char === '\u17D8') return 3;
  if (char === '\u115F' || char === '\u17A4') return 2;
  if (char === '\u2D7F' || VISIBLE_CONTROLS.test(char)) return 1;
  if (ZERO_WIDTH.test(char)) return 0;
  return eastAsianWidth(char.codePointAt(0)!);
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
  const type = node.type;
  if (type === 'line_comment' || type === 'block_comment') return true;
  if (type !== 'attribute_item' && type !== 'inner_attribute_item') return false;
  const comment = node.firstNamedChild;
  return comment !== null && (comment.type === 'line_comment' || comment.type === 'block_comment');
}
