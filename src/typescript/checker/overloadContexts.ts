import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { contextualSignatureOf } from './contextualSignatures';
import { isContextSensitiveFunction } from './signatures';
import { named, skipParentheses } from './syntax';
import type { Type } from './types';

interface Contexts {
  id: number;
  types: Map<number, Type>;
}

interface Preview extends Contexts {
  callbacks: ReadonlySet<number>;
}

const functionKinds = new Set(['arrow_function', 'function_expression', 'method_definition']);

export class OverloadContexts {
  private readonly locked: Contexts[] = [];
  private preview?: Preview;
  private nextId = 0;

  constructor(private readonly c: Checker) {}

  callbacksOf(args: TreeNode[]): Set<number> {
    const result = new Set<number>();
    const pending = [...args];
    while (pending.length > 0) {
      this.c.budget.spend();
      const node = skipParentheses(pending.pop() as TreeNode);
      if (functionKinds.has(node.type)) {
        if (isContextSensitiveFunction(node)) result.add(node.id);
      } else {
        for (const child of contextualChildren(node)) pending.push(child);
      }
    }
    return result;
  }

  withCall<T>(run: () => T): T {
    this.locked.push({ id: 0, types: new Map() });
    try {
      return run();
    } finally {
      this.locked.pop();
    }
  }

  capture(callbacks: ReadonlySet<number>, check: () => boolean): void {
    const frame = this.locked.at(-1);
    if (!frame || frame.types.size > 0) return;
    const outer = this.preview;
    const preview = { id: ++this.nextId, callbacks, types: new Map<number, Type>() };
    this.preview = preview;
    try {
      if (check() && preview.types.size > 0) {
        frame.id = ++this.nextId;
        frame.types = preview.types;
      }
    } finally {
      this.preview = outer;
    }
  }

  contextOf(node: TreeNode, contextual: Type | undefined): Type | undefined {
    return this.locked.findLast((frame) => frame.types.has(node.id))?.types.get(node.id) ?? contextual;
  }

  previewType(node: TreeNode, contextual: Type | undefined): Type | undefined {
    if (!contextual || !this.preview?.callbacks.has(node.id) || !contextualSignatureOf(this.c, contextual, node))
      return undefined;
    this.preview.types.set(node.id, contextual);
    return contextual;
  }

  get cacheKey(): string {
    return `${this.preview?.id ?? 0}/${this.locked.map(({ id }) => id).join(',')}`;
  }
}

function contextualChildren(node: TreeNode): TreeNode[] {
  switch (node.type) {
    case 'array':
    case 'object': {
      return named(node);
    }
    case 'pair': {
      const value = node.childForFieldName('value');
      return value ? [value] : [];
    }
    case 'ternary_expression': {
      return named(node).slice(1);
    }
    case 'binary_expression': {
      const operator = node.childForFieldName('operator')?.text;
      return operator === '||' || operator === '??' ? named(node) : [];
    }
    default: {
      return [];
    }
  }
}
