import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { Position } from './ast';

/** Rejects syntax that this grader does not run. */
export function unsupported(node: Node | Position, what: string): never {
  const row = 'startPosition' in node ? node.startPosition.row : node.row;
  throw new CompileError([{ row, message: `${what}は、この採点環境では使えません。` }]);
}

export function positionOf(node: Node): Position {
  return { row: node.startPosition.row, column: node.startPosition.column };
}

/** The named children of a node, without the comments that tree-sitter places among them. */
export function namedChildren(node: Node): Node[] {
  // The grammar makes `this` and `base` anonymous tokens even where they are expressions, such as in `return this;`.
  if (
    node.type !== 'constructor_initializer' &&
    node.children.some((child) => child?.type === 'this' || child?.type === 'base')
  ) {
    return childrenOf(node).filter((child) => child.isNamed || child.type === 'this' || child.type === 'base');
  }
  return node.namedChildren.filter((child): child is Node => child?.type !== undefined && child.type !== 'comment');
}

/** All the children of a node, without comments. */
export function childrenOf(node: Node): Node[] {
  return node.children.filter((child): child is Node => child?.type !== undefined && child.type !== 'comment');
}

/** Whether two wrappers stand for the same node, since tree-sitter creates a wrapper per access. */
export function sameNode(a: Node | undefined, b: Node | undefined): boolean {
  return a !== undefined && b !== undefined && a.id === b.id;
}

export function field(node: Node, name: string): Node | undefined {
  return node.childForFieldName(name) ?? undefined;
}

export function requiredField(node: Node, name: string): Node {
  const child = node.childForFieldName(name);
  if (!child) throw new CompileError([{ row: node.startPosition.row, message: '書き方に誤りがあります。' }]);
  return child;
}

export function fieldChildren(node: Node, name: string): Node[] {
  return node
    .childrenForFieldName(name)
    .filter((child): child is Node => child?.type !== undefined && child.type !== 'comment');
}

/** Whether the node has an anonymous child token with the given text. */
export function hasToken(node: Node, text: string): boolean {
  return node.children.some((child) => child?.isNamed === false && child.type === text);
}

/** Converts the escape sequence of a C# character or string literal into its UTF-16 code units. */
export function unescape(node: Node, text: string): string {
  const simple = SIMPLE_ESCAPES[text];
  if (simple !== undefined) return simple;
  const hex = /^\\(?:u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8})|x([\dA-Fa-f]{1,4}))$/.exec(text);
  if (!hex)
    throw new CompileError([{ row: node.startPosition.row, message: 'CS1009: 認識できないエスケープ シーケンスです' }]);
  const code = Number.parseInt(hex[1] ?? hex[2] ?? hex[3], 16);
  if (code > 0x10_ff_ff)
    throw new CompileError([{ row: node.startPosition.row, message: 'CS1009: 認識できないエスケープ シーケンスです' }]);
  return String.fromCodePoint(code);
}

const SIMPLE_ESCAPES: Record<string, string> = {
  "\\'": "'",
  '\\"': '"',
  '\\\\': '\\',
  '\\0': '\0',
  '\\a': '\u0007',
  '\\b': '\b',
  '\\e': '\u001B',
  '\\f': '\f',
  '\\n': '\n',
  '\\r': '\r',
  '\\t': '\t',
  '\\v': '\v',
};
