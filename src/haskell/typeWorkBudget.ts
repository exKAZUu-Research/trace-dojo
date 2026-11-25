import { ExecutionLimitError, LIMITS } from '../interpreter/limits';

/** Spends units of the budget in force, throwing when it runs out. */
type Charge = (units: number) => void;

let spend: Charge | undefined;
/** The budget of the compilation in progress, which every producer of compile-time work charges. */
let compilation: Charge | undefined;

/**
 * Runs a compilation within the one compilation budget. A compilation inside another one, such as that of a Template
 * Haskell splice's program, spends the enclosing budget rather than starting afresh.
 */
export function withCompilationBudget<T>(work: () => T): T {
  if (compilation) return withTypeWorkBudget(compilation, work);
  let remaining = LIMITS.maxOperations;
  const charge: Charge = (units) => {
    remaining -= units;
    if (remaining < 0) throw new ExecutionLimitError('operations');
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
