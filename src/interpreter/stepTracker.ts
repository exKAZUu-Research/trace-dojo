/** Records the steps of a traced program, counting them so that a statement can tell what the calls it made showed. */
export class StepTracker {
  /** Called with a statement's row after it completes, in a program compiled for tracing; tells whether it recorded. */
  onStep?: (row: number) => boolean;
  private recordedSteps = 0;
  private completedAtomicCalls = 0;

  /** Records the step of the statement at `row`, if the statement records steps. */
  step(row: number | undefined): void {
    if (row !== undefined && this.onStep?.(row)) this.recordedSteps++;
  }

  /**
   * Runs a statement, then records its step at `row`. One that `onlyCalls` (calls functions or creates objects) records
   * none when the calls it made recorded steps, which already show what it did, unless one was an atomic call, whose
   * effect only this step shows.
   */
  runStatement<T>(row: number | undefined, onlyCalls: boolean, run: () => T): T {
    const { recordedSteps, completedAtomicCalls } = this;
    const result = run();
    const callsShowedIt =
      onlyCalls && this.recordedSteps !== recordedSteps && this.completedAtomicCalls === completedAtomicCalls;
    if (!callsShowedIt) this.step(row);
    return result;
  }

  completeAtomicCall(): void {
    this.completedAtomicCalls++;
  }
}
