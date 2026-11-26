/**
 * The steps an `async` or `async*` body recorded while it ran: from its start to its first suspension and from each
 * resumption to the next suspension. Only the body's driver runs it; a body another one calls starts inside its
 * caller's run, whose count includes what it records then. What it records after it resumes on its own is counted
 * for the task that started it as well, through `spawnedSteps`, so that a statement that awaits a call counts what
 * the call did, as the same call without await does; steps of work the statement did not start count for neither.
 */
export class AsyncTask {
  private settledSteps = 0;
  private enteredAt: number | undefined;
  /** The steps this task recorded in runs outside its parent's, which the parent did not count. */
  private detachedSteps = 0;
  /** The tasks that started while this one ran. */
  readonly spawned: AsyncTask[] = [];
  private readonly parent: AsyncTask | undefined;
  /** Whether the body has ended, after its last run. */
  isDone = false;
  /**
   * The detached steps of this task and every task below it, fixed once the task and all of them have ended, which
   * no later run can change; a statement reads it instead of walking the tasks again.
   */
  private subtreeSteps: number | undefined;

  constructor(private readonly tracker: { statementMark(): number }) {
    this.parent = running.get(tracker);
    this.parent?.spawned.push(this);
  }

  run<T>(work: () => T): T {
    const enteredAt = this.tracker.statementMark();
    const outer = running.get(this.tracker);
    const isDetached = this.parent !== undefined && this.parent.enteredAt === undefined;
    this.enteredAt = enteredAt;
    running.set(this.tracker, this);
    try {
      return work();
    } finally {
      const recorded = this.tracker.statementMark() - enteredAt;
      this.settledSteps += recorded;
      if (isDetached) this.detachedSteps += recorded;
      this.enteredAt = undefined;
      if (outer) running.set(this.tracker, outer);
      else running.delete(this.tracker);
      if (this.isDone) this.fixSubtree();
    }
  }

  /** Fixes the subtree's detached steps when every task below has fixed its own, as an ended recursion's have. */
  private fixSubtree(): void {
    let total = this.detachedSteps;
    for (const task of this.spawned) {
      if (task.subtreeSteps === undefined) return;
      total += task.subtreeSteps;
    }
    this.subtreeSteps = total;
  }

  get recordedSteps(): number {
    return this.settledSteps + (this.enteredAt === undefined ? 0 : this.tracker.statementMark() - this.enteredAt);
  }

  /** The steps the tasks spawned from `start` on recorded where this task did not count them, theirs included. */
  spawnedSteps(start: number): number {
    // A loop over the tasks, as a deep recursion of async calls makes a deep tree of them.
    let total = 0;
    const pending = this.spawned.slice(start);
    for (let task = pending.pop(); task; task = pending.pop()) {
      if (task.subtreeSteps !== undefined) {
        total += task.subtreeSteps;
        continue;
      }
      total += task.detachedSteps;
      pending.push(...task.spawned);
    }
    return total;
  }
}

/** The task each tracker's run is in, whose tasks started then are its spawned ones. */
const running = new WeakMap<object, AsyncTask>();
