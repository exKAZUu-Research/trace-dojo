import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { assertedExpression, assertionTypes, isErasedTypeSyntax } from '../erasedSyntax';
import { defaultedTarget } from './bindingPatternTypes';
import type { Checker } from './checker';
import { chainObject, named, propertyNameText, withoutAssertions } from './syntax';

export function isNonConvertingSourceMethodUse(c: Checker, property: TreeNode): boolean {
  const read = property.parent;
  if (isMetadataOrComparison(read)) return true;
  const binding = propertyBinding(property) ?? initializerBinding(read);
  if (!binding) return false;
  if (binding.type === 'object_pattern') return isMetadataBinding(binding);
  return isValueName(binding, binding.text) && bindingUsedOnlyForMetadataOrComparison(c, binding);
}

function bindingUsedOnlyForMetadataOrComparison(c: Checker, binding: TreeNode): boolean {
  const name = binding.text;
  const symbol = c.binder.lookupValue(binding, name);
  if (!symbol) return false;
  const declarations = new Set(symbol.valueEntries.map((entry) => entry.name.id));
  if (!declarations.has(binding.id)) return false;
  // Redeclaring a simple parameter can expose the value through `arguments` in a non-strict function.
  if (declarations.size > 1 && symbol.valueKind === 'parameter') return false;
  const scope = symbol.scope.kind === 'module' ? c.root : (symbol.scope.node ?? c.root);
  const canVisit = (node: TreeNode): boolean => {
    c.budget.spend();
    if (isErasedTypeSyntax(node.type)) return true;
    if (assertionTypes.has(node.type)) {
      const expression = assertedExpression(node);
      return !expression || canVisit(expression);
    }
    if (
      !declarations.has(node.id) &&
      isValueName(node, name) &&
      !isMetadataOrComparison(node) &&
      c.binder.lookupValue(node, name) === symbol
    )
      return false;
    return node.namedChildren.every((child) => child === null || canVisit(child));
  };
  return canVisit(scope);
}

function isMetadataOrComparison(read: TreeNode | null): boolean {
  if (!read) return false;
  const expression = outermostRuntimeExpression(read);
  const { parent } = expression;
  if (parent?.type === 'unary_expression')
    return ['typeof', 'void'].includes(parent.childForFieldName('operator')?.text ?? '');
  if (parent?.type === 'binary_expression')
    return ['===', '!==', '==', '!='].includes(parent.childForFieldName('operator')?.text ?? '');
  if (parent?.type === 'variable_declarator') {
    const binding = initializerBinding(expression);
    return binding?.type === 'object_pattern' && isMetadataBinding(binding);
  }
  if (parent && chainObject(parent)?.id === expression.id) {
    const property = parent.childForFieldName('property');
    if (property) return isMethodMetadata(propertyNameText(property));
    const index = parent.childForFieldName('index');
    const key = index && withoutAssertions(index);
    return key?.type === 'string' && isMethodMetadata(propertyNameText(key));
  }
  return false;
}

function isMetadataBinding(binding: TreeNode): boolean {
  return named(binding).every((element) => {
    const key = element.childForFieldName('key') ?? defaultedTarget(element) ?? element;
    return element.type !== 'rest_pattern' && isMethodMetadata(propertyNameText(key));
  });
}

function isMethodMetadata(name: string | undefined): boolean {
  return name === 'name' || name === 'length';
}

function outermostRuntimeExpression(node: TreeNode): TreeNode {
  let expression = node;
  for (let parent = expression.parent; parent; parent = parent.parent) {
    if (
      parent.type !== 'parenthesized_expression' &&
      (!assertionTypes.has(parent.type) || assertedExpression(parent)?.id !== expression.id)
    )
      break;
    expression = parent;
  }
  return expression;
}

function isValueName(node: TreeNode, name: string): boolean {
  return (
    ['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'].includes(node.type) &&
    node.text === name
  );
}

function propertyBinding(property: TreeNode): TreeNode | undefined {
  const entry = property.parent;
  if (property.type === 'shorthand_property_identifier_pattern') return property;
  if (entry?.type !== 'pair_pattern' || entry.childForFieldName('key')?.id !== property.id) return undefined;
  const value = entry.childForFieldName('value');
  const name = value && (defaultedTarget(value) ?? value);
  return name ?? undefined;
}

function initializerBinding(read: TreeNode | null): TreeNode | undefined {
  if (!read) return undefined;
  const initializer = outermostRuntimeExpression(read);
  const declarator = initializer.parent;
  if (declarator?.type !== 'variable_declarator' || declarator.childForFieldName('value')?.id !== initializer.id)
    return undefined;
  return declarator.childForFieldName('name') ?? undefined;
}
