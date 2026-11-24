import type { Node } from '@willbooster/web-tree-sitter';

import { compileError } from './errors';
import type { Extensions } from './extensions';
import { sourceColumns } from './sourceCoordinates';
import type { Span } from './syntax';

const reservedNames = new Set(
  `case class data default deriving do else foreign if import in infix infixl infixr instance let module newtype of then type where forall`.split(
    ' '
  )
);
const blockArguments = new Set(['conditional', 'case', 'do', 'let_in', 'lambda']);
const layoutNodes = new Set([
  'declarations',
  'imports',
  'local_binds',
  'alternatives',
  'class_declarations',
  'instance_declarations',
]);
interface Layout {
  indent: number;
  itemStart: number;
}

export function validateDialect(root: Node, extensions: Extensions): void {
  new DialectValidator(root, extensions.has('BlockArguments')).run();
}

class DialectValidator {
  private previousRow = -1;
  private readonly columns: Uint32Array;

  constructor(
    private readonly root: Node,
    private readonly blockArguments: boolean
  ) {
    this.columns = sourceColumns(root.text);
  }

  run(): void {
    this.visit(this.root);
  }

  private visit(node: Node, context?: Layout): void {
    if (isComment(node)) return;
    validateSyntaxNode(node, this.blockArguments);
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
    let insideBraces = false;
    for (const child of children) {
      const nested = insideBraces
        ? undefined
        : first && itemIds.has(child.id)
          ? { indent: this.column(first), itemStart: child.startIndex }
          : context;
      this.visit(child, nested);
      if (child.type === '{' || child.type === '}') insideBraces = child.type === '{';
    }
  }

  private checkToken(node: Node, context?: Layout): void {
    const firstOnLine = node.startPosition.row > this.previousRow;
    this.previousRow = node.endPosition.row;
    if (firstOnLine && context && node.startIndex !== context.itemStart && this.column(node) <= context.indent) {
      const permitsEqualIndent =
        (node.type === '{' && (node.parent?.type === 'do' || layoutNodes.has(node.parent?.type ?? ''))) ||
        (node.parent?.type === 'conditional' && (node.type === 'then' || node.type === 'else'));
      if (!permitsEqualIndent || this.column(node) < context.indent) fail(node);
    }
  }

  private column(node: Node): number {
    return this.columns[node.startIndex]!;
  }
}

function validateSyntaxNode(node: Node, allowBlockArguments: boolean): void {
  if (node.type === 'variable' && reservedNames.has(node.text)) fail(node);
  if (node.type === 'arithmetic_sequence') {
    const value = node.childForFieldName('step') ?? node.childForFieldName('from');
    const name = value?.type === 'qualified' ? value.childForFieldName('id') : value;
    const dots = node.children.find((child) => child?.type === '..');
    if (value && name?.type === 'constructor' && value.endIndex === dots?.startIndex) fail(value);
  }
  if (node.type !== 'apply' || allowBlockArguments) return;
  const argument = node.childForFieldName('argument');
  if (argument && blockArguments.has(argument.type)) fail(argument);
}

function layoutItems(node: Node, children: Node[]): Node[] {
  if (node.type === 'do' && node.isNamed) return node.childrenForFieldName('statement');
  if (!layoutNodes.has(node.type) || node.parent?.children.some((child) => child?.type === '{')) return [];
  return children.filter((child) => child.isNamed && !isComment(child));
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
