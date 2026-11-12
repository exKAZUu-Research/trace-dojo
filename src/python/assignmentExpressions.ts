import type { Node } from '@willbooster/web-tree-sitter';

/**
 * Why CPython refuses an assignment expression (`name := value`) where it stands, or undefined where it allows one:
 * never within an annotation, and without parentheses only in the positions CPython's grammar names.
 */
export function assignmentExpressionError(node: Node): string | undefined {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === 'type') return '型ヒントの中では := を使えません。';
  }
  return isBareAllowed(node) ? undefined : ':= を使った式は、( ) で囲んでください。';
}

function isBareAllowed(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case 'parenthesized_expression':
    case 'argument_list':
    case 'list':
    case 'set':
    case 'tuple':
    case 'match_statement': {
      return true;
    }
    case 'if_statement':
    case 'elif_clause':
    case 'while_statement': {
      return isField(parent, 'condition', node);
    }
    case 'subscript': {
      return isField(parent, 'subscript', node);
    }
    case 'list_comprehension':
    case 'set_comprehension':
    case 'generator_expression': {
      return isField(parent, 'body', node);
    }
    case 'if_clause': {
      // A case guard is an if_clause too; a comprehension's condition is not a position CPython allows.
      return parent.parent?.type === 'case_clause';
    }
    default: {
      return false;
    }
  }
}

function isField(parent: Node, name: string, node: Node): boolean {
  return parent.childrenForFieldName(name).some((child) => child.id === node.id);
}
