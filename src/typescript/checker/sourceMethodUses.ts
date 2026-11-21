import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { assertedExpression, assertionTypes, isErasedTypeSyntax } from '../erasedSyntax';
import { defaultedTarget } from './bindingPatternTypes';
import type { Checker } from './checker';
import type { Sym } from './scopes';
import { chainObject, named, propertyNameText } from './syntax';
import { typeMembers } from './types';

const checkingKeys = new WeakMap<Checker, Set<number>>();
const referencesByChecker = new WeakMap<Checker, Map<Sym, TreeNode[]>>();

export function isNonConvertingSourceMethodUse(c: Checker, property: TreeNode): boolean {
  const read = property.parent;
  if (isSafeMethodUse(c, read)) return true;
  const binding = propertyBinding(property) ?? methodAliasTarget(read);
  if (!binding) return false;
  if (binding.type === 'object_pattern') return isMetadataBinding(c, binding);
  const symbol = localBinding(c, binding);
  return !!symbol && aliasesOnlyHaveSafeUses(c, symbol);
}

function aliasesOnlyHaveSafeUses(c: Checker, symbol: Sym): boolean {
  const references = valueReferences(c);
  const visited = new Set<Sym>();
  const pending = [symbol];
  while (pending.length > 0) {
    const binding = pending.pop() as Sym;
    if (visited.has(binding)) continue;
    visited.add(binding);
    const declarations = new Set(binding.valueEntries.map((entry) => entry.name.id));
    for (const use of references.get(binding) ?? []) {
      c.budget.spend();
      if (declarations.has(use.id) || isSafeMethodUse(c, use)) continue;
      const target = methodAliasTarget(use);
      const alias = target && localBinding(c, target);
      if (!alias) return false;
      pending.push(alias);
    }
  }
  return true;
}

function localBinding(c: Checker, node: TreeNode): Sym | undefined {
  if (!isValueName(node)) return undefined;
  const symbol = c.binder.lookupValue(node, node.text);
  if (!symbol?.valueEntries.length || symbol.isLibrary) return undefined;
  // A redeclared parameter can expose the value through a non-strict function's arguments object.
  if (symbol.valueEntries.length > 1 && symbol.valueKind === 'parameter') return undefined;
  return symbol;
}

function valueReferences(c: Checker): Map<Sym, TreeNode[]> {
  const cached = referencesByChecker.get(c);
  if (cached) return cached;
  const references = new Map<Sym, TreeNode[]>();
  const pending = [c.root];
  while (pending.length > 0) {
    c.budget.spend();
    const node = pending.pop() as TreeNode;
    if (isErasedTypeSyntax(node.type)) continue;
    if (assertionTypes.has(node.type)) {
      const expression = assertedExpression(node);
      if (expression) pending.push(expression);
      continue;
    }
    const symbol = isValueName(node) ? c.binder.lookupValue(node, node.text) : undefined;
    if (symbol) {
      const uses = references.get(symbol) ?? [];
      uses.push(node);
      references.set(symbol, uses);
    }
    for (const child of named(node)) pending.push(child);
  }
  referencesByChecker.set(c, references);
  return references;
}

function isSafeMethodUse(c: Checker, read: TreeNode | null): boolean {
  if (!read) return false;
  const expression = outermostRuntimeExpression(read);
  const { parent } = expression;
  if (parent?.type === 'expression_statement') return true;
  if (parent?.type === 'assignment_expression' && parent.childForFieldName('left')?.id === expression.id) return true;
  if (parent?.type === 'unary_expression')
    return ['typeof', 'void'].includes(parent.childForFieldName('operator')?.text ?? '');
  if (parent?.type === 'binary_expression')
    return ['===', '!==', '==', '!='].includes(parent.childForFieldName('operator')?.text ?? '');
  if (parent?.type === 'variable_declarator') {
    const binding = methodAliasTarget(expression);
    return binding?.type === 'object_pattern' && isMetadataBinding(c, binding);
  }
  if (parent && chainObject(parent)?.id === expression.id) {
    const property = parent.childForFieldName('property');
    if (property) return isMethodMetadata(propertyNameText(property));
    const index = parent.childForFieldName('index');
    return !!index && isMetadataKey(c, index);
  }
  return false;
}

function isMetadataBinding(c: Checker, binding: TreeNode): boolean {
  return named(binding).every((element) => {
    if (element.type === 'rest_pattern') return false;
    const key = element.childForFieldName('key') ?? defaultedTarget(element) ?? element;
    return key.type === 'computed_property_name'
      ? isMetadataKey(c, named(key)[0])
      : isMethodMetadata(propertyNameText(key));
  });
}

function isMetadataKey(c: Checker, key: TreeNode): boolean {
  let active = checkingKeys.get(c);
  if (!active) {
    active = new Set();
    checkingKeys.set(c, active);
  }
  if (active.has(key.id)) return false;
  active.add(key.id);
  try {
    const type = c.flow.probe(() => c.silently(() => c.baseConstraint(c.expressions.check(key))));
    return typeMembers(type).every((member) => member.kind === 'literal' && isMethodMetadata(member.value));
  } finally {
    active.delete(key.id);
  }
}

function isMethodMetadata(name: unknown): boolean {
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

function isValueName(node: TreeNode): boolean {
  return ['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'].includes(node.type);
}

function propertyBinding(property: TreeNode): TreeNode | undefined {
  const entry = property.parent;
  if (property.type === 'shorthand_property_identifier_pattern') return property;
  if (entry?.type !== 'pair_pattern' || entry.childForFieldName('key')?.id !== property.id) return undefined;
  const value = entry.childForFieldName('value');
  const name = value && (defaultedTarget(value) ?? value);
  return name ?? undefined;
}

function methodAliasTarget(read: TreeNode | null): TreeNode | undefined {
  if (!read) return undefined;
  const value = outermostRuntimeExpression(read);
  const { parent } = value;
  if (parent?.type === 'variable_declarator' && parent.childForFieldName('value')?.id === value.id) {
    return parent.childForFieldName('name') ?? undefined;
  }
  if (
    parent?.type === 'assignment_expression' &&
    parent.childForFieldName('right')?.id === value.id &&
    outermostRuntimeExpression(parent).parent?.type === 'expression_statement'
  ) {
    const target = parent.childForFieldName('left');
    if (target?.type === 'identifier') return target;
  }
  return undefined;
}
