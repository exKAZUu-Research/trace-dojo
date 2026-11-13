/** What a trace does with the steps of a program compiled for tracing. */
export interface StepRecorder {
  /** Records the step of the statement at `row` that has just completed, telling whether it did. */
  record(row: number): boolean;
  /**
   * Whether nothing a learner answers changed since the last recorded step: the turtles, the board, and the variables
   * of the running frame.
   */
  showsState(): boolean;
}

/** Records the steps of a traced program, counting them so that a statement can tell what the calls it made showed. */
export class StepTracker {
  recorder?: StepRecorder;
  private recordedSteps = 0;
  /** Whether an atomic call returned after the last recorded step, leaving an effect that no step shows yet. */
  private atomicCallUnshown = false;

  /** Records the step of the statement at `row`, if the statement records steps. */
  step(row: number | undefined): void {
    if (row === undefined || !this.recorder?.record(row)) return;
    this.recordedSteps++;
    this.atomicCallUnshown = false;
  }

  /**
   * Records the step of a loop variable's binding at `row`. A binding that stores nothing learners answer, such as an
   * object, records one only when something changed since the last recorded step.
   */
  stepBinding(row: number | undefined, storesAnswer: boolean): void {
    if (storesAnswer || this.recorder?.showsState() === false) this.step(row);
  }

  /**
   * Runs a statement, then records its step at `row`. One that `onlyCalls` (calls functions or creates objects, which a
   * language may tell only after running it) records
   * none when the calls it made recorded steps and nothing happened after the last of them, since those steps already
   * show what it did. An atomic call returning after those steps, or any change after them (a turtle operation taking
   * an argument whose evaluation recorded steps, a variable a `return` expression updates), needs this step.
   */
  runStatement<T>(row: number | undefined, onlyCalls: boolean | (() => boolean), run: () => T): T {
    const mark = this.statementMark();
    const result = run();
    this.completeStatement(row, onlyCalls, mark);
    return result;
  }

  /**
   * Marks the start of a statement for {@link completeStatement}, for an evaluator that cannot pass the statement's run
   * as a function, such as one whose statements are generators.
   */
  statementMark(): number {
    return this.recordedSteps;
  }

  /** Records the step of a statement that started at `mark`, by the rule of {@link runStatement}. */
  completeStatement(row: number | undefined, onlyCalls: boolean | (() => boolean), mark: number): void {
    const callsShowedIt =
      (typeof onlyCalls === 'function' ? onlyCalls() : onlyCalls) &&
      this.recordedSteps !== mark &&
      !this.atomicCallUnshown &&
      this.recorder?.showsState() === true;
    if (!callsShowedIt) this.step(row);
  }

  completeAtomicCall(): void {
    this.atomicCallUnshown = true;
  }
}
