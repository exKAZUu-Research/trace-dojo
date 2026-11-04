import fastDeepEqual from 'fast-deep-equal';

import type { TraceItem } from '../problems/trace';
import { ExecutionLimitError, MAX_TRACE_ITEMS } from './limits';
import type { StepRecorder } from './stepTracker';
import type { TurtleWorld } from './turtleWorld';

export type TraceVariables = Pick<TraceItem, 'vars' | 'referenceVars'>;

/** What the recorder reads from a language's runtime while it runs a model program. */
export interface TracedRuntime<F extends TracedFrame> {
  readonly world: TurtleWorld;
  /** The call stack, the entry point's frame first. */
  readonly frames: readonly F[];
  collectGarbage(): void;
}

export interface TracedFrame {
  /** The row of the call that created this frame, where undefined marks an implicit call (such as a default
   * constructor), which is part of its caller's step. */
  readonly callRow: number | undefined;
}

export interface FrameReader<F extends TracedFrame> {
  isAtomic(frame: F): boolean;
  variablesOf(frame: F): TraceVariables;
}

/** Collects the trace items of a model program, starting with its state before it runs. */
export class TraceRecorder<F extends TracedFrame> implements StepRecorder {
  readonly traceItems: TraceItem[];
  /** The variables each frame on the stack showed when the last step was recorded. */
  private readonly varsAtLastStep = new WeakMap<F, TraceItem['vars']>();

  constructor(
    private readonly runtime: TracedRuntime<F>,
    private readonly frames: FrameReader<F>
  ) {
    this.traceItems = [
      { line: 0, callLines: [], vars: {}, referenceVars: {}, turtles: [], board: runtime.world.boardText() },
    ];
  }

  /** Records the state after the statement at `row`, unless an atomic method is running. */
  record(row: number): boolean {
    const { frames, world } = this.runtime;
    if (frames.some((frame) => this.frames.isAtomic(frame))) return false;
    if (this.traceItems.length >= MAX_TRACE_ITEMS) throw new ExecutionLimitError('trace');
    this.runtime.collectGarbage();
    this.traceItems.push({
      line: row + 1,
      callLines: frames.slice(1).flatMap(({ callRow }) => (callRow === undefined ? [] : [callRow + 1])),
      ...this.frames.variablesOf(frames.at(-1) as F),
      turtles: world.turtleTraces(),
      board: world.boardText(),
    });
    for (const frame of frames) this.varsAtLastStep.set(frame, this.frames.variablesOf(frame).vars);
    return true;
  }

  /** Whether the turtles, the board, and the running frame's variables are as they were at the last step. */
  showsState(): boolean {
    this.runtime.collectGarbage();
    const last = this.traceItems.at(-1) as TraceItem;
    const { frames, world } = this.runtime;
    const frame = frames.at(-1) as F;
    return (
      last.board === world.boardText() &&
      fastDeepEqual(last.turtles, world.turtleTraces()) &&
      fastDeepEqual(this.varsAtLastStep.get(frame), this.frames.variablesOf(frame).vars)
    );
  }
}
