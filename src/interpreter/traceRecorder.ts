import type { TraceItem } from '../problems/trace';
import { ExecutionLimitError, MAX_TRACE_ITEMS } from './limits';
import type { TurtleWorld } from './turtleWorld';

export type TraceVariables = Pick<TraceItem, 'vars' | 'referenceVars'>;

/** Collects the trace items of a model program, starting with its state before it runs. */
export class TraceRecorder {
  readonly traceItems: TraceItem[];

  constructor(private readonly world: TurtleWorld) {
    this.traceItems = [{ line: 0, callLines: [], vars: {}, referenceVars: {}, turtles: [], board: world.boardText() }];
  }

  /**
   * @param row The row of the statement that has just run.
   * @param callRows The rows of the calls that created the frames above the entry point's, where an undefined row
   * marks an implicit call (such as a default constructor), which is part of its caller's step.
   */
  record(row: number, callRows: (number | undefined)[], variables: TraceVariables): void {
    if (this.traceItems.length >= MAX_TRACE_ITEMS) throw new ExecutionLimitError('trace');
    this.traceItems.push({
      line: row + 1,
      callLines: callRows.filter((callRow) => callRow !== undefined).map((callRow) => callRow + 1),
      ...variables,
      turtles: this.world.turtleTraces(),
      board: this.world.boardText(),
    });
  }
}
