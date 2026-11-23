import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { hasToken } from './syntax';
import type { Property } from './types';

const functionTypes = new Set([
  'function_declaration',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'arrow_function',
  'method_definition',
]);

/**
 * Whether a property access in a field initializer or a static block reads a class member before it is initialized,
 * following TypeScript's `checkPropertyNotUsedBeforeDeclaration`.
 */
export function isUsedBeforeInitialization(node: TreeNode, objectNode: TreeNode, property: Property): boolean {
  const declaration = property.declaration;
  if (node.type !== 'member_expression' || !property.declaringClass || !declaration) return false;
  if (!isInInitializer(node) || isAccess(objectNode)) return false;
  if (declaration.type === 'field_definition' && hasToken(declaration, '?')) return false;
  if (isMethod(declaration) && hasToken(declaration, 'static')) return false;
  const usage = node.childForFieldName('property') ?? node;
  return !isDeclaredBeforeUse(declaration, usage, objectNode);
}

/** Whether `node` runs while the class initializes its fields: in a field initializer or a static block. */
function isInInitializer(node: TreeNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    switch (current.type) {
      case 'field_definition':
      case 'class_static_block': {
        return true;
      }
      case 'type_query':
      case 'arrow_function': {
        return false;
      }
      case 'statement_block': {
        if (current.parent && current.parent.type !== 'arrow_function' && functionTypes.has(current.parent.type))
          return false;
        break;
      }
      default: {
        break;
      }
    }
  }
  return false;
}

function isAccess(node: TreeNode): boolean {
  return node.type === 'member_expression' || node.type === 'subscript_expression';
}

function isDeclaredBeforeUse(declaration: TreeNode, usage: TreeNode, objectNode: TreeNode): boolean {
  const uninitializedThisRead =
    declaration.type === 'field_definition' &&
    objectNode.type === 'this' &&
    !declaration.childForFieldName('value') &&
    !hasToken(declaration, '!');
  if (declaration.startIndex <= usage.startIndex && !uninitializedThisRead) {
    if (declaration.type === 'field_definition') return !isImmediatelyReferenced(declaration, usage, false);
    if (isParameterProperty(declaration))
      return !(classOf(declaration)?.id === classOf(usage)?.id && isDeferred(usage, declaration));
    return true;
  }
  if (!isDeferred(usage, declaration)) return false;
  if (declaration.type === 'field_definition' || isParameterProperty(declaration))
    return !isImmediatelyReferenced(declaration, usage, true);
  return true;
}

/** Whether `usage` runs after the class body evaluates, in a function or in an instance field initializer. */
function isDeferred(usage: TreeNode, declaration: TreeNode): boolean {
  const declarationClass = classOf(declaration);
  for (let current: TreeNode | null = usage; current; current = current.parent) {
    if (current.id === declarationClass?.id) return false;
    if (functionTypes.has(current.type)) return true;
    if (current.type === 'class_static_block' && declaration.startIndex < usage.startIndex) return true;
    const field = current.parent;
    const isInitializer = field?.type === 'field_definition' && field.childForFieldName('value')?.id === current.id;
    if (isInitializer && isInitializerDeferred(field, usage, declaration)) return true;
  }
  return false;
}

/** Whether a field initializer reading `declaration` at `usage` runs after `declaration` is initialized. */
function isInitializerDeferred(field: TreeNode, usage: TreeNode, declaration: TreeNode): boolean {
  if (hasToken(field, 'static')) return isMethod(declaration);
  return (
    declaration.type !== 'field_definition' ||
    hasToken(declaration, 'static') ||
    classOf(usage)?.id !== classOf(declaration)?.id
  );
}

/** Whether `usage` reads the field it initializes, or a field it precedes, without deferring the read. */
function isImmediatelyReferenced(declaration: TreeNode, usage: TreeNode, stopAtAnyField: boolean): boolean {
  if (usage.endIndex > declaration.endIndex) return false;
  const declarationBody = isParameterProperty(declaration)
    ? classOf(declaration)?.childForFieldName('body')
    : declaration.parent;
  for (let current = usage.parent; current && current.id !== declaration.id; current = current.parent) {
    switch (current.type) {
      case 'arrow_function': {
        return false;
      }
      case 'field_definition': {
        return stopAtAnyField && current.parent?.id === declarationBody?.id;
      }
      case 'statement_block': {
        if (current.parent?.type === 'method_definition') return false;
        break;
      }
      default: {
        break;
      }
    }
  }
  return true;
}

function isMethod(declaration: TreeNode): boolean {
  return declaration.type === 'method_definition' && !hasToken(declaration, 'get') && !hasToken(declaration, 'set');
}

function isParameterProperty(declaration: TreeNode): boolean {
  return declaration.type === 'required_parameter' || declaration.type === 'optional_parameter';
}

/** The class whose body contains `node`. */
function classOf(node: TreeNode): TreeNode | undefined {
  for (let current = node.parent; current; current = current.parent)
    if (current.type === 'class_body') return current.parent ?? undefined;
  return undefined;
}
