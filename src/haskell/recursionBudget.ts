import { ExecutionLimitError, LIMITS } from '../interpreter/limits';

export class RecursionBudget {
  private depth = 0;

  constructor(private readonly limitError: () => Error = () => new ExecutionLimitError('operations')) {}

  run<T>(work: () => T): T {
    if (this.depth >= LIMITS.maxCallDepth) throw this.limitError();
    this.depth++;
    try {
      return work();
    } finally {
      this.depth--;
    }
  }
}
