import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Type } from './types';

export class ExpressionTypeCache {
  private readonly silentTypes = new Map<string, Type>();
  private readonly silentEnvironments = new Map<string, number>();

  constructor(private readonly c: Checker) {}

  check(node: TreeNode, contextual: Type | undefined, compute: () => Type): Type {
    const key = this.key(node, contextual);
    const cached = this.silentTypes.get(key);
    if (cached) return cached;
    const type = compute();
    if (key === this.key(node, contextual)) this.silentTypes.set(key, type);
    return type;
  }

  private key(node: TreeNode, contextual?: Type): string {
    const flow = [...(this.c.flow.current?.entries ?? [])].map(([key, entry]) => [
      key,
      entry.type.id,
      entry.assigned,
      entry.evolving,
      entry.constraint?.id,
    ]);
    const parameters = [...this.c.functions.parameterTypes].map(([id, type]) => [id, type.id]);
    const contexts = this.c.functions.contexts.map((context) => [
      context.node.id,
      context.inReturn,
      context.contextualReturn?.id,
    ]);
    const captured = this.c.functions.capturedTypes.map((entries) => [...entries].map(([key, type]) => [key, type.id]));
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
    return `${this.c.expressions.deferredContexts.id}/${this.c.overloadContexts.cacheKey}/${node.id}/${contextual?.id}/${this.c.literals.isConstContext(node, contextual)}/${environmentId}`;
  }
}
