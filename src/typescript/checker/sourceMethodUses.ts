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
      const method = this.boundMethod(property.parent);
      const binding = propertyBinding(property) ?? methodAliasTarget(method);
      const symbol = binding && localBinding(this.c, binding);
      if (this.isInvoked(method) || (symbol && this.hasInvokedAlias(symbol))) {
        this.c.error(property, unsupportedMessage('関数やクラスの文字列への変換'));
      }
    }
  }

  private hasInvokedAlias(symbol: Sym): boolean {
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
        if (declarations.has(use.id)) continue;
        const method = this.boundMethod(use);
        if (this.isInvoked(method)) return true;
        const target = methodAliasTarget(method);
        const alias = target && localBinding(this.c, target);
        if (alias) pending.push(alias);
      }
    }
    return false;
  }

  private boundMethod(read: TreeNode | null): TreeNode | undefined {
    let method = read ? outermostRuntimeExpression(read) : undefined;
    while (method) {
      const invoked = this.invokedMember(method);
      if (!invoked || !invoked.keys.every((name) => name === 'bind')) break;
      method = outermostRuntimeExpression(invoked.call);
    }
    return method;
  }

  private isInvoked(method: TreeNode | undefined): boolean {
    if (!method) return false;
    return (
      !!callOf(method) || this.invokedMember(method)?.keys.some((name) => name === 'call' || name === 'apply') === true
    );
  }

  private invokedMember(method: TreeNode): { call: TreeNode; keys: string[] } | undefined {
    const member = method.parent;
    if (!member || chainObject(member)?.id !== method.id) return undefined;
    const call = callOf(outermostRuntimeExpression(member));
    if (!call) return undefined;
    const property = member.childForFieldName('property');
    const name = property && propertyNameText(property);
    const index = member.childForFieldName('index');
    const keys = name ? [name] : index ? this.memberNames(index) : [];
    return keys.length === 0 ? undefined : { call, keys };
  }

  private memberNames(key: TreeNode): string[] {
    const types = this.keyTypes.get(key.id);
    if (!types) return [];
    return [...types].flatMap((type) =>
      typeMembers(this.c.baseConstraint(type)).map((member) =>
        member.kind === 'literal' && typeof member.value === 'string' ? member.value : ''
      )
    );
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
}

function localBinding(c: Checker, node: TreeNode): Sym | undefined {
  if (!isValueName(node)) return undefined;
  const symbol = c.binder.lookupValue(node, node.text);
  return symbol?.valueEntries.length === 1 && !symbol.isLibrary && !symbol.isReassigned ? symbol : undefined;
}

function callOf(method: TreeNode): TreeNode | undefined {
  const call = method.parent;
  return call?.type === 'call_expression' && call.childForFieldName('function')?.id === method.id ? call : undefined;
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

function methodAliasTarget(value: TreeNode | undefined): TreeNode | undefined {
  const declarator = value?.parent;
  if (declarator?.type !== 'variable_declarator' || declarator.childForFieldName('value')?.id !== value?.id)
    return undefined;
  return declarator.childForFieldName('name') ?? undefined;
}
