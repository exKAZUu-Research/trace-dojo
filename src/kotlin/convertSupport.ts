import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';

/** The message of a construct that this environment does not run. */
export function unavailableMessage(what: string): string {
  return `${what}は、この採点環境では使えません。`;
}

export function unavailableJavaFeature(path: string): string | undefined {
  const within = (prefix: string): boolean => path === prefix || path.startsWith(prefix + '.');
  if (within('java.util.Scanner') || path === 'java.lang.System.in') return '標準入力';
  if (within('java.io') || within('java.nio')) return 'ファイルの読み書き';
  if (within('java.net')) return 'ネットワーク';
  if (within('java.util.concurrent')) return 'コルーチン・スレッド';
  if (within('java.lang.reflect')) return 'リフレクション';
  return undefined;
}

export function syntaxError(node: Node, message: string): CompileError {
  return new CompileError([{ row: node.startPosition.row, message }]);
}

export function unavailable(node: Node, what: string): CompileError {
  return syntaxError(node, unavailableMessage(what));
}

export function named(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && !isComment(child));
}

export function children(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null && !isComment(child));
}

export function isComment(node: Node): boolean {
  return node.type === 'line_comment' || node.type === 'block_comment';
}

export function namedOfType(node: Node, type: string): Node[] {
  return named(node).filter((child) => child.type === type);
}

export function firstOfType(node: Node, type: string): Node | undefined {
  return named(node).find((child) => child.type === type);
}

/** Whether `node` has an anonymous child token with the given text. */
export function hasToken(node: Node, text: string): boolean {
  return children(node).some((child) => !child.isNamed && child.type === text);
}

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('A node the grammar requires is missing');
  return value;
}

export function rowOf(node: Node): number {
  return node.startPosition.row;
}
