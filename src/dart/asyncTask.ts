/**
 * The steps an `async` or `async*` body recorded while it ran: from its start to its first suspension and from each
 * resumption to the next suspension. Only the body's driver runs it; a body another one calls runs inside its
 * caller, whose count includes it, while steps that other work records while the body waits count for neither.
 */
export class AsyncTask {
  private settledSteps = 0;
  private enteredAt: number | undefined;

  constructor(private readonly tracker: { statementMark(): number }) {}

  run<T>(work: () => T): T {
    const enteredAt = this.tracker.statementMark();
    this.enteredAt = enteredAt;
    try {
      return work();
    } finally {
      this.settledSteps += this.tracker.statementMark() - enteredAt;
      this.enteredAt = undefined;
    }
  }

  get recordedSteps(): number {
    return this.settledSteps + (this.enteredAt === undefined ? 0 : this.tracker.statementMark() - this.enteredAt);
  }
}
