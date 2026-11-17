import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

/** The named children of a node, without comments. */
export function named(node: TreeNode): TreeNode[] {
  return node.namedChildren.filter((child): child is TreeNode => child !== null && child.type !== 'comment');
}

export function hasToken(node: TreeNode, token: string): boolean {
  return node.children.some((child) => child !== null && !child.isNamed && child.type === token);
}

export function childOfType(node: TreeNode, type: string): TreeNode | undefined {
  return node.namedChildren.find((child): child is TreeNode => child?.type === type);
}

/** The identifiers a binding pattern declares, in order. */
export function patternIdentifiers(pattern: TreeNode): TreeNode[] {
  switch (pattern.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
    case 'shorthand_property_identifier': {
      return [pattern];
    }
    case 'assignment_pattern':
    case 'object_assignment_pattern':
    case 'assignment_expression': {
      const left = pattern.childForFieldName('left');
      return left ? patternIdentifiers(left) : [];
    }
    case 'pair_pattern':
    case 'pair': {
      const value = pattern.childForFieldName('value');
      return value ? patternIdentifiers(value) : [];
    }
    case 'rest_pattern':
    case 'spread_element':
    case 'array_pattern':
    case 'object_pattern':
    case 'array':
    case 'object': {
      return named(pattern).flatMap((child) => patternIdentifiers(child));
    }
    default: {
      return [];
    }
  }
}

/** The elements of an array pattern with their positions, which holes such as `[, x]` skip. */
export function arrayPatternElements(pattern: TreeNode): { element: TreeNode; index: number }[] {
  const elements: { element: TreeNode; index: number }[] = [];
  let index = 0;
  for (const child of pattern.children) {
    if (!child || child.type === '[' || child.type === ']' || child.type === 'comment') continue;
    if (child.type === ',') index++;
    else elements.push({ element: child, index });
  }
  return elements;
}

/** The expression inside parentheses. */
export function skipParentheses(node: TreeNode): TreeNode {
  let current = node;
  while (current.type === 'parenthesized_expression') {
    const inner = named(current)[0];
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/** The name of a property name node, or undefined for a computed one that is not a literal. */
export function propertyNameText(node: TreeNode): string | undefined {
  switch (node.type) {
    case 'property_identifier':
    case 'identifier':
    case 'type_identifier':
    case 'private_property_identifier':
    case 'shorthand_property_identifier': {
      return node.text;
    }
    case 'string': {
      return stringValue(node);
    }
    case 'number': {
      return String(Number(node.text.replaceAll('_', '')));
    }
    case 'computed_property_name': {
      const inner = named(node)[0];
      if (inner?.type === 'string') return stringValue(inner);
      if (inner?.type === 'number') return String(Number(inner.text.replaceAll('_', '')));
      if (inner?.type === 'member_expression' && inner.childForFieldName('object')?.text === 'Symbol')
        return `__@${inner.childForFieldName('property')?.text}`;
      return undefined;
    }
    default: {
      return undefined;
    }
  }
}

/** Whether a property name is numeric, which a number index signature covers: `1`, `1.5`, and `-1` but not `01`. */
export function isNumericName(name: string): boolean {
  return String(Number(name)) === name;
}

/** The value of a string literal node. */
export function stringValue(node: TreeNode): string {
  let value = '';
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'string_fragment') value += child.text;
    else if (child.type === 'escape_sequence') value += decodeEscape(child.text);
  }
  return value;
}

const simpleEscapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

function decodeEscape(text: string): string {
  const body = text.slice(1);
  if (body in simpleEscapes) return simpleEscapes[body];
  if (body.startsWith('x')) return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
  if (body.startsWith('u{')) return String.fromCodePoint(Number.parseInt(body.slice(2, -1), 16));
  if (body.startsWith('u')) return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
  if (body.startsWith('\r') || body.startsWith('\n')) return '';
  return body;
}

/** The value of a numeric literal, or a bigint for one ending with `n`. */
export function numberValue(text: string): number | bigint {
  const clean = text.replaceAll('_', '');
  if (clean.endsWith('n')) return BigInt(clean.slice(0, -1));
  if (/^0[0-7]+$/.test(clean)) return Number.parseInt(clean, 8);
  return Number(clean);
}

/** Whether a node is a function whose `this` is its own, rather than an arrow function's enclosing one. */
export function isFunctionWithOwnThis(node: TreeNode): boolean {
  return ['function_declaration', 'function_expression', 'method_definition', 'class_static_block'].includes(node.type);
}
