import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isConstAssertion } from './syntax';
import type { Type } from './types';

export class DeferredContexts {
  id = 0;
  private nextId = 0;
  private readonly providers = new Map<number, () => Type | undefined>();

  constructor(private readonly c: Checker) {}

  with(node: TreeNode, context: () => Type | undefined, check: () => Type): Type {
    const previous = this.providers.get(node.id);
    const previousId = this.id;
    this.providers.set(node.id, context);
    this.id = ++this.nextId;
    try {
      return check();
    } finally {
      if (previous) this.providers.set(node.id, previous);
      else this.providers.delete(node.id);
      this.id = previousId;
    }
  }

  typeOf(node: TreeNode): Type | undefined {
    if (this.providers.size === 0) return undefined;
    for (let current: TreeNode | undefined = node; current; current = this.contextualParent(current)) {
      this.c.budget.spend();
      const provider = this.providers.get(current.id);
      if (provider) return provider();
    }
    return undefined;
  }

  private contextualParent(node: TreeNode): TreeNode | undefined {
    const parent = node.parent;
    if (!parent) return undefined;
    switch (parent.type) {
      case 'parenthesized_expression':
      case 'non_null_expression': {
        return parent;
      }
      case 'as_expression':
      case 'type_assertion': {
        return isConstAssertion(parent) ? parent : undefined;
      }
      case 'ternary_expression': {
        return parent.childForFieldName('condition')?.id === node.id ? undefined : parent;
      }
      case 'binary_expression': {
        return ['&&', '||', '??'].includes(parent.childForFieldName('operator')?.text ?? '') ? parent : undefined;
      }
      case 'arrow_function': {
        return parent.childForFieldName('body')?.id === node.id ? this.invocationOf(parent) : undefined;
      }
      case 'return_statement': {
        return this.returnInvocation(parent);
      }
      default: {
        return undefined;
      }
    }
  }

  private returnInvocation(statement: TreeNode): TreeNode | undefined {
    for (let owner = statement.parent; owner; owner = owner.parent) {
      this.c.budget.spend();
      if (
        [
          'arrow_function',
          'function_expression',
          'function_declaration',
          'generator_function',
          'generator_function_declaration',
          'method_definition',
        ].includes(owner.type)
      )
        return this.invocationOf(owner);
    }
    return undefined;
  }

  private invocationOf(fn: TreeNode): TreeNode | undefined {
    if (fn.childForFieldName('return_type')) return undefined;
    let expression = fn;
    while (expression.parent?.type === 'parenthesized_expression') expression = expression.parent;
    const call = expression.parent;
    return call?.type === 'call_expression' && call.childForFieldName('function')?.id === expression.id
      ? call
      : undefined;
  }
}
