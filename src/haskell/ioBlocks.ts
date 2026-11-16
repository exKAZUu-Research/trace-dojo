import type { IODoCore, VisibleVar } from './core';
import type { Machine, RunState } from './machine';
import type { TraceFrame } from './runtime';
import type { Env, IODo, Slot } from './values';

/** An `IO` block running its statements, one at a time, on the evaluator's stack. */
export interface DoFrame {
  k: 'do';
  code: IODoCore;
  env: Env;
  index: number;
  /** The steps recorded before the running statement started, which tell whether its calls showed it. */
  mark: number;
  traceFrame: TraceFrame;
  /** Whether this block started its trace frame, which ends with it. */
  pushedTraceFrame: boolean;
  /** Whether the block's last statement made a tail call that took over its trace frame. */
  tailCalled?: boolean;
  /** Whether the block's last statement called a local function whose blocks recorded its steps. */
  silent?: boolean;
  result?: Slot;
}

/** Where a trace frame's running statement is: the block's environment and the variables the statement sees. */
export interface TraceContext {
  env: Env;
  visible: VisibleVar[];
  row: number | undefined;
  /** The block and the statement running in this context. */
  block?: IODoCore;
  index?: number;
}

/**
 * Starts an `IO` block. A block of another call than the running frame's starts a trace frame, which a function
 * calling itself as its last statement (a loop written as recursion) takes over instead.
 */
export function runBlock(machine: Machine, state: RunState, action: IODo): void {
  const runtime = machine.runtime;
  const invocation = action.env.invocation();
  const top = runtime.frames.at(-1);
  let traceFrame = top;
  let pushed = false;
  if (!top || top.invocation !== invocation) {
    let callRow = top?.currentRow();
    const callers = top && tailSelfCallers(machine, top, invocation);
    if (callers && top) {
      callRow = top.callRow;
      for (const caller of callers) caller.tailCalled = true;
      runtime.popFrame(top, false);
    }
    traceFrame = runtime.pushFrame(invocation, callRow);
    pushed = true;
  } else {
    markSilentCaller(machine, top);
  }
  const frame: DoFrame = {
    k: 'do',
    code: action.code,
    env: action.env,
    index: 0,
    mark: 0,
    traceFrame: traceFrame as TraceFrame,
    pushedTraceFrame: pushed,
  };
  frame.traceFrame.contexts.push({ env: action.env, visible: action.code.entryVisible, row: undefined });
  machine.stack.push(frame);
  if (action.code.bindingRow !== undefined) {
    runtime.steps.stepBinding(action.code.bindingRow, action.code.bindingStoresAnswer ?? false);
  }
  startStatement(machine, state, frame);
}

/**
 * A local function or action called as a block's last statement (a loop written as recursion) shows its work in its
 * own steps, so the call records no step of its own when it returns.
 */
function markSilentCaller(machine: Machine, top: TraceFrame): void {
  const caller = machine.stack.at(-1);
  if (caller?.k !== 'do' || caller.traceFrame !== top || caller.index !== caller.code.stmts.length - 1) return;
  const stmt = caller.code.stmts[caller.index];
  if (stmt.kind === 'exp' && stmt.onlyCalls) caller.silent = true;
}

/**
 * The blocks of `frame` when each is running its last statement and the innermost one calls the same function as
 * `invocation`: a tail call.
 */
function tailSelfCallers(machine: Machine, frame: TraceFrame, invocation: Env | undefined): DoFrame[] | undefined {
  const info = invocation?.info;
  if (!info || info !== frame.info || frame === machine.runtime.frames[0]) return undefined;
  const blocks: DoFrame[] = [];
  for (let index = machine.stack.length - 1; index >= 0; index--) {
    const candidate = machine.stack[index];
    if (candidate.k !== 'do' || candidate.traceFrame !== frame || candidate.tailCalled) return undefined;
    const stmt = candidate.code.stmts[candidate.index];
    if (candidate.index !== candidate.code.stmts.length - 1 || stmt.kind !== 'exp') return undefined;
    if (blocks.length === 0 && !stmt.onlyCalls) return undefined;
    blocks.push(candidate);
    // The block that started the call's frame encloses all its others.
    if (candidate.pushedTraceFrame) return blocks;
  }
  return undefined;
}

function startStatement(machine: Machine, state: RunState, frame: DoFrame): void {
  const stmt = frame.code.stmts[frame.index];
  const context = frame.traceFrame.contexts.at(-1) as TraceContext;
  context.visible = stmt.visible;
  context.row = stmt.row;
  context.block = frame.code;
  context.index = frame.index;
  frame.mark = machine.runtime.steps.statementMark();
  if (stmt.kind === 'let') {
    for (const bind of stmt.binds) frame.env.slots[bind.index] = machine.makeLetSlot(bind.expr, frame.env);
    completeStatement(machine, frame);
    afterStatement(machine, state, frame);
    return;
  }
  machine.stack.push({ k: 'runIO' });
  state.enter(machine.makeSlot(stmt.expr, frame.env));
}

/** Receives a statement's result: binds it, matching its pattern if it has one, then moves on. */
export function statementDone(machine: Machine, state: RunState, frame: DoFrame): void {
  const stmt = frame.code.stmts[frame.index];
  machine.stack.push(frame);
  frame.result = state.value;
  if (stmt.kind === 'bind') {
    frame.env.slots[stmt.slot] = state.value;
    if (stmt.matcher) {
      machine.stack.push({ k: 'doMatch', frame });
      state.evaluate(stmt.matcher, frame.env);
      return;
    }
  }
  finishMatch(machine, state, frame);
}

/** Completes a statement whose pattern matched, and moves on. */
export function finishMatch(machine: Machine, state: RunState, frame: DoFrame): void {
  completeStatement(machine, frame);
  afterStatement(machine, state, frame);
}

function completeStatement(machine: Machine, frame: DoFrame): void {
  const stmt = frame.code.stmts[frame.index];
  if ((stmt.kind === 'exp' || stmt.kind === 'let') && stmt.noStep) return;
  if (frame.tailCalled || frame.silent) return;
  machine.runtime.steps.completeStatement(stmt.row, stmt.kind !== 'let' && stmt.onlyCalls, frame.mark);
}

/** Starts the next statement, or ends the block with the last statement's result. */
function afterStatement(machine: Machine, state: RunState, frame: DoFrame): void {
  frame.index++;
  if (frame.index < frame.code.stmts.length) {
    // Only the last statement's result is the block's; an earlier one must not keep what it reaches alive.
    frame.result = undefined;
    startStatement(machine, state, frame);
    return;
  }
  machine.stack.pop();
  unwindBlock(machine, frame);
  state.ioResult(frame.result as Slot);
}

/** Leaves a block's trace context, keeping the entry point's frame, which shows the program's final variables. */
export function unwindBlock(machine: Machine, frame: DoFrame): void {
  const runtime = machine.runtime;
  if (frame.tailCalled) return;
  if (!frame.pushedTraceFrame) frame.traceFrame.contexts.pop();
  else if (runtime.frames[0] !== frame.traceFrame) runtime.popFrame(frame.traceFrame);
}
