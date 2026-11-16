import { ExecutionLimitError, LIMITS } from '../interpreter/limits';

let remaining: number | undefined;

export function withCompilationBudget<T>(work: () => T): T {
  const saved = remaining;
  remaining = LIMITS.maxOperations;
  try {
    return work();
  } finally {
    remaining = saved;
  }
}

export function chargeCompilationWork(): void {
  if (remaining !== undefined && --remaining < 0) throw new ExecutionLimitError('operations');
}
