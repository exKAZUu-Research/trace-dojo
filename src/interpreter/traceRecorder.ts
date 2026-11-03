import type { TraceItem } from '../problems/trace';
import { ExecutionLimitError, MAX_TRACE_ITEMS } from './limits';
import type { TurtleWorld } from './turtleWorld';

export type TraceVariables = Pick<TraceItem, 'vars' | 'referenceVars'>;

/** Collects the trace items of a model program, starting with its state before it runs. */
export class TraceRecorder {
  readonly traceItems: TraceItem[];

  constructor(
    private readonly world: TurtleWorld,
    private readonly callerIdByRow: Map<number, number>
  ) {
    this.traceItems = [
      { depth: 0, sid: 0, callStack: [], vars: {}, referenceVars: {}, turtles: [], board: world.boardText() },
    ];
  }

  /**
   * @param callRows The rows of the calls that created the frames above the entry point's, where an undefined row
   * marks an implicit call (such as a default constructor), which is part of its caller's step.
   */
  record(stepId: number, callRows: (number | undefined)[], variables: TraceVariables): void {
    if (this.traceItems.length >= MAX_TRACE_ITEMS) throw new ExecutionLimitError('trace');
    const calls = callRows.filter((row) => row !== undefined);
    this.traceItems.push({
      depth: calls.length,
      sid: stepId,
      callStack: calls.map((row) => this.callerIdByRow.get(row) ?? 0),
      ...variables,
      turtles: this.world.turtleTraces(),
      board: this.world.boardText(),
    });
  }
}
