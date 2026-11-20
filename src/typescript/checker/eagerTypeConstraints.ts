import type { ExecutionBudget } from '../../interpreter/limits';
import type { Type } from './types';

interface Evaluation {
  operands?: Set<Type>;
  children?: Set<Evaluation>;
}

/** Records which base constraints type evaluation actually inspects before normalization can erase them. */
export class EagerTypeConstraints {
  private readonly byNode = new Map<number, Evaluation>();
  private current?: Evaluation;

  evaluate(node: number, resolve: () => Type): Type {
    const evaluation: Evaluation = {};
    const type = this.collect(evaluation, resolve);
    if (evaluation.operands || evaluation.children) this.byNode.set(node, evaluation);
    this.reuse(node);
    return type;
  }

  reuse(node: number): void {
    this.include(this.byNode.get(node));
  }

  record(operand: Type): void {
    if (this.current) (this.current.operands ??= new Set()).add(operand);
  }

  withinDeferredType(resolve: () => Type): Type {
    return this.collect(undefined, resolve);
  }

  prepareDeferred<T>(resolve: () => T): () => T {
    const evaluation: Evaluation = {};
    const value = this.collect(evaluation, resolve);
    return () => {
      if (evaluation.operands || evaluation.children) this.include(evaluation);
      return value;
    };
  }

  private collect<T>(evaluation: Evaluation | undefined, resolve: () => T): T {
    const outer = this.current;
    this.current = evaluation;
    try {
      return resolve();
    } finally {
      this.current = outer;
    }
  }

  private include(evaluation: Evaluation | undefined): void {
    if (this.current && evaluation && this.current !== evaluation)
      (this.current.children ??= new Set()).add(evaluation);
  }

  *operandsOf(node: number, budget: ExecutionBudget): Iterable<Type> {
    const root = this.byNode.get(node);
    if (!root) return;
    const visited = new Set<Evaluation>();
    const pending = [root];
    for (let evaluation = pending.pop(); evaluation; evaluation = pending.pop()) {
      budget.spend();
      if (visited.has(evaluation)) continue;
      visited.add(evaluation);
      if (evaluation.operands) yield* evaluation.operands;
      for (const child of evaluation.children ?? []) pending.push(child);
    }
  }
}
