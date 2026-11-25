import type { Node } from '@willbooster/web-tree-sitter';

import type { ClassDecl } from './ast';
import { enc, lower } from './bytes';
import { BUILTIN_TYPES } from './converterBase';
import { decodeLiteral, decodeSingleQuoted } from './literals';
import type { TypeDecl } from './values';

export const CLASS_KINDS: Record<string, ClassDecl['kind']> = {
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
};

export const CLASS_KIND_NOUNS: Record<ClassDecl['kind'], string> = {
  class: 'a class',
  interface: 'an interface',
  trait: 'a trait',
  enum: 'an enum',
};

export const MAGIC_METHODS: Record<
  string,
  { args?: number; isStatic?: boolean; isPublic?: boolean; returnType?: string; parameterTypes?: string[] }
> = {
  __construct: { isStatic: false, returnType: '' },
  __destruct: { args: 0, isStatic: false, returnType: '' },
  __clone: { args: 0, isStatic: false, returnType: 'void' },
  __get: { parameterTypes: ['string'], args: 1, isStatic: false, isPublic: true },
  __set: { parameterTypes: ['string'], args: 2, isStatic: false, isPublic: true, returnType: 'void' },
  __isset: { parameterTypes: ['string'], args: 1, isStatic: false, isPublic: true, returnType: 'bool' },
  __unset: { parameterTypes: ['string'], args: 1, isStatic: false, isPublic: true, returnType: 'void' },
  __call: { parameterTypes: ['string', 'array'], args: 2, isStatic: false, isPublic: true },
  __callstatic: { parameterTypes: ['string', 'array'], args: 2, isStatic: true, isPublic: true },
  __tostring: { args: 0, isStatic: false, isPublic: true, returnType: 'string' },
  __debuginfo: { args: 0, isStatic: false, isPublic: true, returnType: '?array' },
  __invoke: { isStatic: false, isPublic: true },
  __serialize: { args: 0, isStatic: false, isPublic: true, returnType: 'array' },
  __unserialize: { parameterTypes: ['array'], args: 1, isStatic: false, isPublic: true, returnType: 'void' },
  __set_state: { parameterTypes: ['array'], args: 1, isStatic: true, isPublic: true, returnType: 'object' },
};

/** The row where a declaration starts after the attributes written before it, which PHP's messages name. */
export function declarationRow(node: Node): number {
  const start = node.children.find((child) => child.type !== 'attribute_list' && child.type !== 'comment') ?? node;
  return start.startPosition.row;
}

export function typeAllowsNull(type: TypeDecl): boolean {
  if (type.k === 'named') return type.nullable === true || type.name === 'null' || type.name === 'mixed';
  if (type.k === 'union') return type.types.some(typeAllowsNull);
  return false;
}

const PROPERTY_REFERENCE_BOUNDARIES = new Set([
  'anonymous_class',
  'anonymous_function',
  'arrow_function',
  'class_declaration',
  'enum_declaration',
  'function_definition',
  'interface_declaration',
  'method_declaration',
  'trait_declaration',
]);

export function referencesProperty(node: Node, name: string): boolean {
  if (PROPERTY_REFERENCE_BOUNDARIES.has(node.type)) return false;
  if (node.type === 'member_access_expression' || node.type === 'nullsafe_member_access_expression') {
    const object = withoutParentheses(node.childForFieldName('object'));
    const member = withoutParentheses(node.childForFieldName('name'));
    if (object?.type === 'variable_name' && object.text === '$this' && memberNameLiteral(member) === name) return true;
  }
  return node.namedChildren.some((child) => referencesProperty(child, name));
}

function withoutParentheses(node: Node | null | undefined): Node | undefined {
  while (node?.type === 'parenthesized_expression') node = node.namedChildren.find((child) => child.type !== 'comment');
  return node ?? undefined;
}

function memberNameLiteral(node: Node | undefined): string | undefined {
  if (node?.type === 'name') return enc(node.text);
  if (node?.type === 'string') return decodeSingleQuoted(node.text.slice(node.text.indexOf("'") + 1, -1));
  if (
    node?.type === 'encapsed_string' &&
    node.namedChildren.every((child) => child.type === 'string_content' || child.type === 'escape_sequence')
  )
    return decodeLiteral(node.text.slice(node.text.indexOf('"') + 1, -1), true);
  return undefined;
}

/** Whether a literal of a scalar type may be the default value of a parameter of `type`; an int may stand for a float. */
export function defaultFits(type: TypeDecl, literalType: string): boolean {
  if (literalType === 'null' && typeAllowsNull(type)) return true;
  if (type.k === 'inter') return false;
  if (type.k === 'union') return type.types.some((part) => defaultFits(part, literalType));
  const name = type.name;
  if (name === 'mixed' || name === literalType) return true;
  if (literalType === 'int' && name === 'float') return true;
  if (literalType === 'true' || literalType === 'false') return name === 'bool';
  if (literalType === 'array') return name === 'iterable';
  return false;
}

export function hasProhibitedMemberType(type: TypeDecl): boolean {
  return type.k === 'named'
    ? ['void', 'never', 'callable'].includes(type.name)
    : type.types.some(hasProhibitedMemberType);
}

export function builtinType(type: TypeDecl): boolean {
  return type.k === 'named' ? BUILTIN_TYPES.has(type.name) : type.types.every(builtinType);
}

/** The syntax that starts a scope of its own, whose `yield` belongs to it rather than to the enclosing function. */
const NESTED_FUNCTION_SCOPES = new Set([
  'function_definition',
  'anonymous_function',
  'arrow_function',
  'method_declaration',
  'class_declaration',
  'anonymous_class',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

export function containsYield(node: Node): boolean {
  for (const child of node.namedChildren) {
    if (child.type === 'yield_expression') return true;
    if (!NESTED_FUNCTION_SCOPES.has(child.type) && containsYield(child)) return true;
  }
  return false;
}

/** Whether a generator may declare `type`, which must accept the Generator object a call returns. */
export function allowsGenerator(type: TypeDecl): boolean {
  if (type.k !== 'named') return type.types.some(allowsGenerator);
  return ['iterable', 'object', 'mixed', 'traversable', 'iterator', 'generator'].includes(lower(type.name));
}
