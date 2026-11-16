import type { Node } from '@willbooster/web-tree-sitter';

import { compileError } from './errors';
import type { Span } from './syntax';

const reservedNames = new Set(
  `case class data default deriving do else foreign if import in infix infixl infixr instance let module newtype of then type where forall`.split(
    ' '
  )
);
const layoutNodes = new Set([
  'declarations',
  'local_binds',
  'alternatives',
  'class_declarations',
  'instance_declarations',
]);
interface Layout {
  indent: number;
  itemStart: number;
}

export function validateDialect(root: Node): void {
  new DialectValidator(root).run();
}

class DialectValidator {
  private previousRow = -1;
  private readonly columns: Uint32Array;

  constructor(private readonly root: Node) {
    this.columns = sourceColumns(root.text);
  }

  run(): void {
    this.visit(this.root);
  }

  private visit(node: Node, context?: Layout): void {
    if (isComment(node)) return;
    if (node.type === 'variable' && reservedNames.has(node.text)) fail(node);
    const children = node.children.filter((child): child is Node => child !== null);
    if (children.length === 0) {
      this.checkToken(node, context);
      return;
    }
    const items = layoutItems(node, children);
    const first = items[0];
    const explicit = children.some((child) => child.type === '{');
    if (first && !explicit && context && this.column(first) <= context.indent) fail(first);
    const itemIds = new Set(items.map((item) => item.id));
    for (const child of children) {
      const nested =
        first && itemIds.has(child.id)
          ? { indent: explicit ? -1 : this.column(first), itemStart: child.startIndex }
          : context;
      this.visit(child, nested);
    }
  }

  private checkToken(node: Node, context?: Layout): void {
    const firstOnLine = node.startPosition.row > this.previousRow;
    this.previousRow = node.endPosition.row;
    if (firstOnLine && context && node.startIndex !== context.itemStart && this.column(node) <= context.indent)
      fail(node);
  }

  private column(node: Node): number {
    return this.columns[node.startIndex]!;
  }
}

function sourceColumns(source: string): Uint32Array {
  const columns = new Uint32Array(source.length + 1);
  for (let index = 0; index < source.length; index++) {
    const previous = columns[index]!;
    columns[index + 1] =
      source[index] === '\n' ? 0 : source[index] === '\t' ? previous + 8 - (previous % 8) : previous + 1;
  }
  return columns;
}

function layoutItems(node: Node, children: Node[]): Node[] {
  if (node.type === 'do' && node.isNamed) return node.childrenForFieldName('statement');
  return layoutNodes.has(node.type) ? children.filter((child) => child.isNamed && !isComment(child)) : [];
}

function isComment(node: Node): boolean {
  return node.type === 'comment' || node.type === 'haddock';
}

function fail(node: Node): never {
  const start = node.startPosition;
  const end = node.endPosition;
  const span: Span = { row: start.row, col: start.column, endRow: end.row, endCol: end.column };
  throw compileError(span, '書き方に誤りがあります。');
}
