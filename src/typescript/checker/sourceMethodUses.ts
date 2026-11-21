import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { assertedExpression, assertionTypes, isErasedTypeSyntax } from '../erasedSyntax';
import { unsupportedMessage } from '../unsupported';
import { defaultedTarget } from './bindingPatternTypes';
import type { Checker } from './checker';
import type { Sym } from './scopes';
import { chainObject, named, propertyNameText } from './syntax';
import { type Type, typeMembers } from './types';

export class SourceMethodUses {
  private readonly properties = new Map<number, TreeNode>();
  private readonly keyTypes = new Map<number, Set<Type>>();
  private references?: Map<Sym, TreeNode[]>;

  constructor(private readonly c: Checker) {}

  recordSourceMethod(property: TreeNode): void {
    if (this.c.silent === 0 && !this.c.flow.probing) this.properties.set(property.id, property);
  }

  recordKey(node: TreeNode, type: Type): void {
    if (this.c.silent > 0 || this.c.flow.probing) return;
    const types = this.keyTypes.get(node.id) ?? new Set<Type>();
    types.add(type);
    this.keyTypes.set(node.id, types);
  }

  check(): void {
    for (const property of this.properties.values()) {
      if (!this.isNonConvertingUse(property)) {
        this.c.error(property, unsupportedMessage('関数やクラスの文字列への変換'));
      }
    }
  }

  private isNonConvertingUse(property: TreeNode): boolean {
    const read = property.parent;
    if (this.isSafeMethodUse(read)) return true;
    const binding = propertyBinding(property) ?? methodAliasTarget(read);
    if (!binding) return false;
    if (binding.type === 'object_pattern') return this.isMetadataBinding(binding);
    const symbol = localBinding(this.c, binding);
    return !!symbol && this.aliasesOnlyHaveSafeUses(symbol);
  }

  private aliasesOnlyHaveSafeUses(symbol: Sym): boolean {
    const references = this.valueReferences();
    const visited = new Set<Sym>();
    const pending = [symbol];
    while (pending.length > 0) {
      const binding = pending.pop() as Sym;
      if (visited.has(binding)) continue;
      visited.add(binding);
      const declarations = new Set(binding.valueEntries.map((entry) => entry.name.id));
      for (const use of references.get(binding) ?? []) {
        this.c.budget.spend();
        if (declarations.has(use.id) || this.isSafeMethodUse(use)) continue;
        const target = methodAliasTarget(use);
        const alias = target && localBinding(this.c, target);
        if (!alias) return false;
        pending.push(alias);
      }
    }
    return true;
  }

  private valueReferences(): Map<Sym, TreeNode[]> {
    const cached = this.references;
    if (cached) return cached;
    const references = new Map<Sym, TreeNode[]>();
    const pending = [this.c.root];
    while (pending.length > 0) {
      this.c.budget.spend();
      const node = pending.pop() as TreeNode;
      if (isErasedTypeSyntax(node.type)) continue;
      if (assertionTypes.has(node.type)) {
        const expression = assertedExpression(node);
        if (expression) pending.push(expression);
        continue;
      }
      const symbol = isValueName(node) ? this.c.binder.lookupValue(node, node.text) : undefined;
      if (symbol) {
        const uses = references.get(symbol) ?? [];
        uses.push(node);
        references.set(symbol, uses);
      }
      for (const child of named(node)) pending.push(child);
    }
    this.references = references;
    return references;
  }

  private isSafeMethodUse(read: TreeNode | null): boolean {
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
      return binding?.type === 'object_pattern' && this.isMetadataBinding(binding);
    }
    if (parent && chainObject(parent)?.id === expression.id) {
      const property = parent.childForFieldName('property');
      if (property) return isMethodMetadata(propertyNameText(property));
      const index = parent.childForFieldName('index');
      return !!index && this.isMetadataKey(index);
    }
    return false;
  }

  private isMetadataBinding(binding: TreeNode): boolean {
    return named(binding).every((element) => {
      if (element.type === 'rest_pattern') return false;
      const key = element.childForFieldName('key') ?? defaultedTarget(element) ?? element;
      return key.type === 'computed_property_name'
        ? this.isMetadataKey(named(key)[0])
        : isMethodMetadata(propertyNameText(key));
    });
  }

  private isMetadataKey(key: TreeNode): boolean {
    const types = this.keyTypes.get(key.id);
    if (!types) return false;
    return [...types].every((type) =>
      typeMembers(this.c.baseConstraint(type)).every(
        (member) => member.kind === 'literal' && isMethodMetadata(member.value)
      )
    );
  }
}

function localBinding(c: Checker, node: TreeNode): Sym | undefined {
  if (!isValueName(node)) return undefined;
  const symbol = c.binder.lookupValue(node, node.text);
  if (!symbol?.valueEntries.length || symbol.isLibrary) return undefined;
  // A redeclared parameter can expose the value through a non-strict function's arguments object.
  if (symbol.valueEntries.length > 1 && symbol.valueKind === 'parameter') return undefined;
  return symbol;
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
