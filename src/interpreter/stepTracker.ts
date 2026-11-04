/** What a trace does with the steps of a program compiled for tracing. */
export interface StepRecorder {
  /** Records the step of the statement at `row` that has just completed, telling whether it did. */
  record(row: number): boolean;
  /** Whether the last recorded step still shows the turtles and the board as they are now. */
  showsWorld(): boolean;
}

/** Records the steps of a traced program, counting them so that a statement can tell what the calls it made showed. */
export class StepTracker {
  recorder?: StepRecorder;
  private recordedSteps = 0;
  private completedAtomicCalls = 0;

  /** Records the step of the statement at `row`, if the statement records steps. */
  step(row: number | undefined): void {
    if (row !== undefined && this.recorder?.record(row)) this.recordedSteps++;
  }

  /**
   * Records the step of a loop variable's binding at `row`. A binding that stores nothing learners answer, such as an
   * object, records one only when the last recorded step no longer shows the turtles and the board.
   */
  stepBinding(row: number | undefined, storesAnswer: boolean): void {
    if (storesAnswer || this.recorder?.showsWorld() === false) this.step(row);
  }

  /**
   * Runs a statement, then records its step at `row`. One that `onlyCalls` (calls functions or creates objects) records
   * none when the calls it made recorded steps and the last of them still shows the turtles and the board, since those
   * steps already show what it did. A completed atomic call or a turtle operation after those steps, such as one taking
   * an argument whose evaluation recorded steps, leaves an effect that only this step shows.
   */
  runStatement<T>(row: number | undefined, onlyCalls: boolean, run: () => T): T {
    const { recordedSteps, completedAtomicCalls } = this;
    const result = run();
    const callsShowedIt =
      onlyCalls &&
      this.recordedSteps !== recordedSteps &&
      this.completedAtomicCalls === completedAtomicCalls &&
      this.recorder?.showsWorld() === true;
    if (!callsShowedIt) this.step(row);
    return result;
  }

  completeAtomicCall(): void {
    this.completedAtomicCalls++;
  }
}
