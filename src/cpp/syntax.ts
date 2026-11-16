import type { Node } from '@willbooster/web-tree-sitter';

/**
 * A copy of a tree-sitter node that outlives the tree, which the compiler reads after the parser frees it.
 */
export interface Syntax {
  readonly type: string;
  readonly text: string;
  /** The 0-based row where the node starts. */
  readonly row: number;
  readonly endRow: number;
  /** The offset of the node in the source, in UTF-16 code units. */
  readonly start: number;
  readonly end: number;
  readonly isNamed: boolean;
  /** The field of the parent that holds this node, if any. */
  readonly field: string | undefined;
  /** Every child, including anonymous tokens such as operators and keywords. */
  readonly all: readonly Syntax[];
  /** The named children. */
  readonly children: readonly Syntax[];
}

export function copySyntax(node: Node, field?: string): Syntax {
  const all: Syntax[] = [];
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child) continue;
    all.push(copySyntax(child, node.fieldNameForChild(index) ?? undefined));
  }
  return {
    type: node.type,
    text: node.text,
    row: node.startPosition.row,
    endRow: node.endPosition.row,
    start: node.startIndex,
    end: node.endIndex,
    isNamed: node.isNamed,
    field,
    all,
    children: all.filter((child) => child.isNamed),
  };
}

/** The child in field `name`, if any. */
export function fieldOf(node: Syntax, name: string): Syntax | undefined {
  return node.all.find((child) => child.field === name);
}

/** Every child in field `name`. */
export function fieldsOf(node: Syntax, name: string): Syntax[] {
  return node.all.filter((child) => child.field === name);
}

/** Whether the node has an anonymous token of the given text among its children. */
export function hasToken(node: Syntax, token: string): boolean {
  return node.all.some((child) => !child.isNamed && child.type === token);
}

/** The anonymous token among the node's children that is one of `tokens`, such as the operator of an expression. */
export function tokenOf(node: Syntax, tokens: readonly string[]): string | undefined {
  return node.all.find((child) => !child.isNamed && tokens.includes(child.type))?.type;
}

/** The named children of a node that are not in any field, such as the specifiers of a declaration. */
export function unfieldedChildren(node: Syntax): Syntax[] {
  return node.children.filter((child) => child.field === undefined);
}
