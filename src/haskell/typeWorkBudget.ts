import { assert } from 'es-toolkit';

import { ExecutionBudget } from '../interpreter/limits';

/** Spends units of the budget in force, throwing when it runs out. */
type Charge = (units: number) => void;

let spend: Charge | undefined;
let compilation: ExecutionBudget | undefined;

/**
 * Runs a compilation on a budget of its own operations, which the code it runs while it compiles (a Template Haskell
 * splice's) spends too.
 */
export function withCompilationBudget<T>(work: () => T): T {
  const budget = new ExecutionBudget(Number.POSITIVE_INFINITY);
  compilation = budget;
  try {
    return withTypeWorkBudget((units) => budget.spend(units), work);
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

/** The budget of the compilation in progress. */
export function compilationBudget(): ExecutionBudget {
  assert(compilation, 'No compilation is in progress');
  return compilation;
}
