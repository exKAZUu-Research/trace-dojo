import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { contextualSignatureOf } from './contextualSignatures';
import { isGeneratorFunction } from './functions';
import { isContextSensitiveFunction, parameterNodes } from './signatures';
import { argumentParameters, isFunctionWithOwnThis, isTaggedTemplateArgument, named } from './syntax';
import type { Type } from './types';

interface Callbacks {
  nodes: ReadonlySet<number>;
  eagerNodes: ReadonlySet<number>;
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
  eagerNodes: ReadonlySet<number>;
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
    const eagerNodes = new Set<number>();
    let mayDefer = false;
    const pending = args.map((node) => ({ node, allowsDeferral: true }));
    while (pending.length > 0) {
      this.c.budget.spend();
      const { node, allowsDeferral } = pending.pop() as (typeof pending)[number];
      if (functionKinds.has(node.type)) {
        addCallbackNode(node, allowsDeferral, nodes, eagerNodes, () => {
          mayDefer = true;
        });
      } else if (!isTaggedTemplateArgument(node)) {
        for (const child of named(node))
          pending.push({ node: child, allowsDeferral: allowsDeferral && triggersDeferral(node, child) });
      }
    }
    return { nodes, eagerNodes, mayDefer };
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
      eagerNodes: callbacks.eagerNodes,
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
    if (preview.eager || preview.eagerNodes.has(node.id) || preview.frame.types.has(node.id)) {
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

function addCallbackNode(
  node: TreeNode,
  allowsDeferral: boolean,
  nodes: Set<number>,
  eagerNodes: Set<number>,
  markDeferred: () => void
): void {
  const generator = isGeneratorFunction(node);
  const deferred = generator ? hasDeferredGeneratorParameters(node) : isContextSensitiveFunction(node);
  if (deferred) {
    nodes.add(node.id);
    if (allowsDeferral) markDeferred();
    return;
  }
  if (generator && !node.childForFieldName('type_parameters') && !node.childForFieldName('return_type')) {
    nodes.add(node.id);
    eagerNodes.add(node.id);
  }
}

function hasDeferredGeneratorParameters(node: TreeNode): boolean {
  if (node.childForFieldName('type_parameters')) return false;
  const params = parameterNodes(node);
  if (params.some((parameter) => !parameter.childForFieldName('type'))) return true;
  return argumentParameters(params).length === params.length && referencesOwnThis(node);
}

function referencesOwnThis(node: TreeNode): boolean {
  const stack = [
    ...parameterNodes(node),
    ...(node.childForFieldName('body') ? [node.childForFieldName('body') as TreeNode] : []),
  ];
  for (let current = stack.pop(); current; current = stack.pop()) {
    if (current.type === 'this') return true;
    for (const child of named(current)) {
      if (isFunctionWithOwnThis(child) || child.type === 'field_definition') continue;
      stack.push(child);
    }
  }
  return false;
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
