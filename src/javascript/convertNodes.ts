import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { Expression, PropertyName } from './ast';

export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && child.type !== 'comment');
}

/** The first named child in a field, skipping the `;` and empty statements that the `for` header puts there. */
export function namedField(node: Node, name: string): Node | undefined {
  return node
    .childrenForFieldName(name)
    .find((child): child is Node => child !== null && child.isNamed && child.type !== 'empty_statement');
}

export function field(node: Node, name: string): Node {
  const child = node.childForFieldName(name);
  if (!child) return fail(node, '書き方に誤りがあります。');
  return child;
}

export function hasChild(node: Node, type: string): boolean {
  return node.children.some((child) => child?.type === type);
}

export function isPresent(node: Node | null): node is Node {
  return node !== null && node.type !== 'comment';
}

export function rowOf(node: Node): number {
  return node.startPosition.row;
}

export function unwrapParentheses(node: Node): Node {
  let current = node;
  while (current.type === 'parenthesized_expression') current = namedChildren(current)[0];
  return current;
}

/** The text of a callee for error messages, shortened as long expressions are. */
export function calleeText(node: Node): string {
  const text = node.text.replaceAll(/\s+/g, ' ');
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

/** Gives an anonymous function or class the name it is assigned to, as `name` shows. */
export function nameAnonymous(value: Expression, name: string): void {
  if (value.kind === 'functionExpression' && value.fn.name === '') value.fn.name = name;
  if (value.kind === 'classExpression' && value.cls.name === '') value.cls.name = name;
}

export function keyName(key: PropertyName): string {
  if (key.kind === 'key') return key.key;
  if (key.kind === 'private') return key.name;
  return '';
}

/** The accessor keyword of a method definition, if any. */
export function accessorOf(node: Node): 'getter' | 'setter' | undefined {
  if (hasChild(node, 'get')) return 'getter';
  if (hasChild(node, 'set')) return 'setter';
  return undefined;
}

const reservedBindingNames = new Set(['eval', 'arguments']);

export function checkBindingName(node: Node): void {
  if (reservedBindingNames.has(nameOf(node))) fail(node, `${node.text} は変数名に使えません。`);
}

/** The words JavaScript reserves, which an identifier spelling one with an escape may not stand for. */
const reservedWords = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with'.split(
    ' '
  )
);

/** The name an identifier, a property name, or a `#name` spells, with its `\\u` escapes decoded. */
export function nameOf(node: Node): string {
  const { text } = node;
  if (!text.includes('\\')) return text;
  const name = text.replaceAll(/\\u(?:\{([\dA-Fa-f]+)\}|([\dA-Fa-f]{4}))/g, (_, braced?: string, fixed?: string) =>
    String.fromCodePoint(Number.parseInt(braced ?? fixed ?? '', 16))
  );
  const isReference = node.type === 'identifier' || node.type.startsWith('shorthand_property_identifier');
  if (isReference && reservedWords.has(name)) fail(node, `予約語 ${name} は、エスケープを含めて書けません。`);
  return name;
}

/** The name a node spells, or an empty one when there is no node, as for an anonymous function. */
export function optionalNameOf(node: Node | null | undefined): string {
  return node ? nameOf(node) : '';
}

export function fail(node: Node, message: string): never {
  throw new CompileError([{ row: rowOf(node), message }]);
}

export function unsupported(node: Node, feature: string): never {
  return fail(node, `${feature}は、この採点環境では使えません。`);
}

/** Features learners may write that the interpreter rejects, by node type. */
export const unsupportedFeatures: Record<string, string> = {
  import_statement: 'import や export ',
  export_statement: 'import や export ',
  with_statement: 'with 文',
  jsx_element: 'JSX ',
  jsx_self_closing_element: 'JSX ',
};
