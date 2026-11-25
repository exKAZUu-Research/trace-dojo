import { ExecutionLimitError, LIMITS } from '../interpreter/limits';

/** Spends units of the budget in force, throwing when it runs out. */
type Charge = (units: number) => void;

let spend: Charge | undefined;
let compilation: Charge | undefined;
let compilationRemaining = 0;

/**
 * A compilation inside another one, such as that of a Template Haskell splice's program, spends the enclosing
 * budget rather than starting afresh.
 */
export function withCompilationBudget<T>(work: () => T): T {
  if (compilation) return withTypeWorkBudget(compilation, work);
  compilationRemaining = LIMITS.maxOperations;
  const charge: Charge = (units) => {
    compilationRemaining -= units;
    if (compilationRemaining < 0) throw new ExecutionLimitError('operations');
  };
  compilation = charge;
  try {
    return withTypeWorkBudget(charge, work);
  } finally {
    compilation = undefined;
  }
}

export function withTypeWorkBudget<T>(charge: Charge, work: () => T): T {
  const saved = spend;
  spend = charge;
  try {
    return work();
  } finally {
    spend = saved;
  }
}

/** Charges compile-time work to the budget in force: one unit for a step, or the size of what a step produces. */
export function chargeTypeWork(units = 1): void {
  spend?.(units);
}

/** The operations the compilation in progress has left, which a program it runs (a splice's) may spend. */
export function remainingCompilationWork(): number {
  return compilation ? Math.max(compilationRemaining, 0) : LIMITS.maxOperations;
}
