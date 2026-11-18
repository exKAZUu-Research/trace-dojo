import { ExecutionLimitError, LIMITS } from '../interpreter/limits';

let spend: (() => void) | undefined;

export function withCompilationBudget<T>(work: () => T): T {
  let remaining = LIMITS.maxOperations;
  return withTypeWorkBudget(() => {
    if (--remaining < 0) throw new ExecutionLimitError('operations');
  }, work);
}

export function withTypeWorkBudget<T>(charge: () => void, work: () => T): T {
  const saved = spend;
  spend = charge;
  try {
    return work();
  } finally {
    spend = saved;
  }
}

export function chargeTypeWork(): void {
  spend?.();
}
