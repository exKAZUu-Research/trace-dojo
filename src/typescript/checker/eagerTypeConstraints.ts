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
    const parent = this.current;
    const evaluation: Evaluation = {};
    this.current = evaluation;
    try {
      const type = resolve();
      if (evaluation.operands || evaluation.children) this.byNode.set(node, evaluation);
      return type;
    } finally {
      this.current = parent;
      this.reuse(node);
    }
  }

  reuse(node: number): void {
    const evaluation = this.byNode.get(node);
    if (this.current && evaluation && this.current !== evaluation)
      (this.current.children ??= new Set()).add(evaluation);
  }

  record(operand: Type): void {
    if (this.current) (this.current.operands ??= new Set()).add(operand);
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
