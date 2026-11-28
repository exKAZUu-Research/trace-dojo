import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { laterRunningTypes } from './expandos';
import { type Type, typeCacheKey } from './types';

export type RetainFresh = false | 'boolean' | 'all';

export class ExpressionTypeCache {
  private readonly silentTypes = new Map<string, Type>();
  private readonly silentEnvironments = new Map<string, number>();
  private readonly yieldingNodes = new Map<number, boolean>();

  constructor(private readonly c: Checker) {}

  check(node: TreeNode, contextual: Type | undefined, retainFresh: RetainFresh, compute: () => Type): Type {
    // Checking a `yield` records its type on the generator, which a cached type would skip.
    if (this.yields(node)) return compute();
    const key = this.key(node, contextual, retainFresh);
    const cached = this.silentTypes.get(key);
    if (cached) return cached;
    const type = compute();
    if (key === this.key(node, contextual, retainFresh)) this.silentTypes.set(key, type);
    return type;
  }

  /** Whether an expression yields from the generator it is in, not only from a function it contains. */
  private yields(node: TreeNode): boolean {
    let yields = this.yieldingNodes.get(node.id);
    if (yields === undefined) {
      yields =
        node.type === 'yield_expression' ||
        node.namedChildren.some((child) => !laterRunningTypes.has(child.type) && this.yields(child));
      this.yieldingNodes.set(node.id, yields);
    }
    return yields;
  }

  private key(node: TreeNode, contextual: Type | undefined, retainFresh: RetainFresh): string {
    const flow = [...(this.c.flow.current?.entries ?? [])].map(([key, entry]) => [
      key,
      typeCacheKey(entry.type),
      entry.assigned,
      entry.evolving,
      typeCacheKey(entry.constraint),
    ]);
    const parameters = [...this.c.functions.parameterTypes].map(([id, type]) => [id, typeCacheKey(type)]);
    const contexts = this.c.functions.contexts.map((context) => [
      context.node.id,
      context.inReturn,
      typeCacheKey(context.contextualReturn),
    ]);
    const captured = this.c.functions.capturedTypes.map((entries) =>
      [...entries].map(([key, type]) => [key, typeCacheKey(type)])
    );
    const environment = JSON.stringify([
      this.c.flow.current !== undefined,
      this.c.flow.current?.superCalled,
      [...(this.c.flow.current?.assignedFields ?? [])].toSorted(),
      flow,
      parameters,
      contexts,
      captured,
      this.c.classes.thisContextId(node),
    ]);
    let environmentId = this.silentEnvironments.get(environment);
    if (environmentId === undefined) {
      this.c.budget.spend(Math.ceil(environment.length / 100));
      environmentId = this.silentEnvironments.size;
      this.silentEnvironments.set(environment, environmentId);
    }
    return `${this.c.expressions.deferredContexts.id}/${this.c.overloadContexts.cacheKey}/${node.id}/${typeCacheKey(contextual)}/${this.c.literals.isConstContext(node, contextual)}/${retainFresh}/${environmentId}`;
  }
}
