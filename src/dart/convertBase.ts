import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { Span } from './ast';

export function spanOf(node: Node): Span {
  return { row: node.startPosition.row, column: node.startPosition.column, start: node.startIndex, end: node.endIndex };
}

export function unsupported(node: Node | Span, what: string): never {
  const row = 'startPosition' in node ? node.startPosition.row : node.row;
  throw new CompileError([{ row, message: `${what}は、この採点環境では使えません。` }]);
}

export function syntaxError(node: Node | Span, message: string): never {
  const row = 'startPosition' in node ? node.startPosition.row : node.row;
  throw new CompileError([{ row, message }]);
}

export function childrenOf(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null);
}

export function syntaxChildrenOf(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null && child.type !== 'comment');
}

export function namedOf(node: Node): Node[] {
  return syntaxChildrenOf(node).filter((child) => child.isNamed);
}

export function fieldOf(node: Node, name: string): Node | undefined {
  return node.childForFieldName(name) ?? undefined;
}

export function fieldsOf(node: Node, name: string): Node[] {
  return node.childrenForFieldName(name).filter((child): child is Node => child !== null);
}

export function hasToken(node: Node, token: string): boolean {
  return childrenOf(node).some((child) => !child.isNamed && child.type === token);
}

export function requireNode(node: Node | undefined, parent: Node): Node {
  if (!node) return syntaxError(parent, '書き方に誤りがあります。');
  return node;
}
