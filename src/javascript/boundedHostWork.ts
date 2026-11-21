import assert from 'node:assert/strict';
import { Script } from 'node:vm';

import { z } from 'zod';

import { type ExecutionBudget, ExecutionLimitError } from '../interpreter/limits';

const invoke = new Script('run()');
const timedOut = z.object({ code: z.literal('ERR_SCRIPT_EXECUTION_TIMEOUT') });

export function boundedHostWork<T>(budget: ExecutionBudget, work: () => T): T {
  const timeout = budget.remainingMilliseconds;
  if (timeout === 0) throw new ExecutionLimitError('time');
  let result: { value: T } | undefined;
  try {
    invoke.runInNewContext(
      {
        run: () => {
          result = { value: work() };
        },
      },
      { timeout }
    );
  } catch (error) {
    if (timedOut.safeParse(error).success) throw new ExecutionLimitError('time');
    throw error;
  }
  assert.ok(result);
  return result.value;
}
