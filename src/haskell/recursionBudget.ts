import { ExecutionLimitError, LIMITS } from '../interpreter/limits';

export class RecursionBudget {
  private depth = 0;

  run<T>(work: () => T): T {
    if (this.depth >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    this.depth++;
    try {
      return work();
    } finally {
      this.depth--;
    }
  }
}
