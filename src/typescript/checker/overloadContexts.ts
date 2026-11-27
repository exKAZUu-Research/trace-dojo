import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { contextualSignatureOf } from './contextualSignatures';
import { isContextSensitiveFunction } from './signatures';
import { isTaggedTemplateArgument, named } from './syntax';
import type { Type } from './types';

interface Callbacks {
  nodes: ReadonlySet<number>;
  mayDefer: boolean;
}

interface Contexts {
  id: number;
  types: Map<number, Type>;
  includesDeferred: boolean;
}

interface Preview {
  id: number;
  callbacks: ReadonlySet<number>;
  staged: Map<number, Type>;
  frame: Contexts;
  eager: boolean;
}

const functionKinds = new Set(['arrow_function', 'function_expression', 'generator_function', 'method_definition']);

export class OverloadContexts {
  private readonly locked: Contexts[] = [];
  private preview?: Preview;
  private nextId = 0;

  constructor(private readonly c: Checker) {}

  callbacksOf(args: TreeNode[]): Callbacks {
    const nodes = new Set<number>();
    let mayDefer = false;
    const pending = args.map((node) => ({ node, allowsDeferral: true }));
    while (pending.length > 0) {
      this.c.budget.spend();
      const { node, allowsDeferral } = pending.pop() as (typeof pending)[number];
      if (functionKinds.has(node.type)) {
        if (isContextSensitiveFunction(node)) {
          nodes.add(node.id);
          mayDefer ||= allowsDeferral;
        }
      } else if (!isTaggedTemplateArgument(node)) {
        for (const child of named(node))
          pending.push({ node: child, allowsDeferral: allowsDeferral && triggersDeferral(node, child) });
      }
    }
    return { nodes, mayDefer };
  }

  withCall<T>(run: () => T): T {
    this.locked.push({ id: 0, includesDeferred: false, types: new Map() });
    try {
      return run();
    } finally {
      this.locked.pop();
    }
  }

  capture(callbacks: Callbacks, check: () => boolean): void {
    const frame = this.locked.at(-1);
    if (!frame || frame.types.size === callbacks.nodes.size) return;
    const outer = this.preview;
    const preview: Preview = {
      id: ++this.nextId,
      callbacks: callbacks.nodes,
      staged: new Map(),
      frame,
      eager: frame.includesDeferred || !callbacks.mayDefer,
    };
    this.preview = preview;
    try {
      if (check()) {
        frame.includesDeferred = true;
        for (const [id, type] of preview.staged) this.lock(frame, id, type);
      }
    } finally {
      this.preview = outer;
    }
  }

  eagerly<T>(check: () => T): T {
    const preview = this.preview;
    if (!preview || preview.eager) return check();
    this.preview = { ...preview, id: ++this.nextId, eager: true };
    try {
      return check();
    } finally {
      this.preview = preview;
    }
  }

  withoutPreview<T>(check: () => T): T {
    const preview = this.preview;
    if (!preview) return check();
    this.preview = undefined;
    try {
      return check();
    } finally {
      this.preview = preview;
    }
  }

  contextOf(node: TreeNode, contextual: Type | undefined): Type | undefined {
    return this.locked.findLast((frame) => frame.types.has(node.id))?.types.get(node.id) ?? contextual;
  }

  previewType(node: TreeNode, contextual: Type | undefined): Type | undefined {
    const preview = this.preview;
    if (!contextual || !preview?.callbacks.has(node.id) || !contextualSignatureOf(this.c, contextual, node))
      return undefined;
    if (preview.eager || preview.frame.types.has(node.id)) {
      this.lock(preview.frame, node.id, contextual);
      return undefined;
    }
    preview.staged.set(node.id, contextual);
    return contextual;
  }

  private lock(frame: Contexts, id: number, type: Type): void {
    if (frame.types.has(id)) return;
    frame.types.set(id, type);
    frame.id = ++this.nextId;
  }

  get cacheKey(): string {
    return `${this.preview?.id ?? 0}/${this.locked.map(({ id }) => id).join(',')}`;
  }
}

/** The expression forms that trigger TypeScript's initial SkipContextSensitive pass on a call. */
function triggersDeferral(parent: TreeNode, child: TreeNode): boolean {
  switch (parent.type) {
    case 'array':
    case 'object':
    case 'parenthesized_expression': {
      return true;
    }
    case 'pair': {
      return parent.childForFieldName('value')?.id === child.id;
    }
    case 'ternary_expression': {
      return parent.childForFieldName('condition')?.id !== child.id;
    }
    case 'binary_expression': {
      const operator = parent.childForFieldName('operator')?.text;
      return operator === '||' || operator === '??';
    }
    default: {
      return false;
    }
  }
}
