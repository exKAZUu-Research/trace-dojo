/** Stops a program that exceeds a limit the learner cannot catch. */
export class ExecutionLimitError extends Error {
  constructor(readonly limit: 'operations' | 'time' | 'output' | 'trace') {
    super(`Execution limit exceeded: ${limit}`);
    this.name = 'ExecutionLimitError';
  }
}

/** Bounds every run, since learners' programs run inside the web server's process. */
export const LIMITS = {
  maxOperations: 1_000_000,
  maxMilliseconds: 2000,
  maxCallDepth: 512,
  /** The total number of array elements and object fields allocated while running. */
  maxSlots: 1_000_000,
  /** The length of one string built while running; building strings also costs operations, which bounds the rest. */
  maxStringLength: 1_000_000,
  maxOutputLength: 100_000,
};
const OPERATIONS_PER_CLOCK_CHECK = 1024;

/** Counts the operations and output of one run against {@link LIMITS}. */
export class ExecutionBudget {
  output = '';
  private operations = 0;
  private nextClockCheck = OPERATIONS_PER_CLOCK_CHECK;
  private deadline = performance.now() + LIMITS.maxMilliseconds;

  spend(cost = 1): void {
    // A negative charge (such as a scan over an empty range computed backward) must never refill the budget.
    this.operations += Math.max(cost, 0);
    if (this.operations > LIMITS.maxOperations) throw new ExecutionLimitError('operations');
    // A charge for many operations at once (e.g., scanning a long string) may stand for slow native work, so it
    // checks the clock at once; single operations check it periodically.
    if (cost === 1 && this.operations < this.nextClockCheck) return;
    this.nextClockCheck = this.operations + OPERATIONS_PER_CLOCK_CHECK;
    if (performance.now() > this.deadline) throw new ExecutionLimitError('time');
  }

  /**
   * Runs `work`, which the grader does for itself rather than for the program (such as parsing a library's source once
   * per process), so that its time does not count against the program's.
   */
  excludingTime<T>(work: () => T): T {
    const start = performance.now();
    try {
      return work();
    } finally {
      this.deadline += performance.now() - start;
    }
  }

  print(text: string): void {
    this.output += text;
    if (this.output.length > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  }
}

/** Model programs are trusted but must not hang the server through an accidental unbounded loop. */
export const MAX_TRACE_ITEMS = 10_000;
