import type { FunctionInfo, IODoCore } from './core';
import { isScalarType, slotDisplayType } from './displayTypes';
import type { Machine, RunState } from './machine';
import { DisplayAbort, type Runtime, type TraceFrame } from './runtime';
import { Env, type IODo, type PreparedBlock, type Slot } from './values';
import type { VisibleScope } from './visibleScope';

export interface DoFrame {
  k: 'do';
  code: IODoCore;
  env: Env;
  index: number;
  mark: number;
  traceFrame: TraceFrame;
  pushedTraceFrame: boolean;
  prefix: PreparedBlock;
  discardResult: boolean;
  tailCalled?: boolean;
  silent?: boolean;
  result?: Slot;
}

export interface TraceContext {
  env: Env;
  prefixEnv: Env;
  visible: VisibleScope;
  row: number | undefined;
}

export function runBlock(machine: Machine, state: RunState, action: IODo): void {
  const runtime = machine.runtime;
  const prefix = prepareBlock(machine, action);
  runtime.allocate(action.code.size);
  const env = new Env(action.code.size, action.env);
  const { traceFrame, pushed } = enterCallFrame(machine, env.invocation());
  const frame: DoFrame = {
    k: 'do',
    code: action.code,
    env,
    index: 0,
    mark: 0,
    traceFrame,
    pushedTraceFrame: pushed,
    prefix,
    discardResult: ioResultIsDiscarded(machine),
  };
  frame.traceFrame.contexts.push({ env, prefixEnv: prefix.env, visible: action.code.entryVisible, row: undefined });
  machine.stack.push(frame);
  if (action.code.bindingRow !== undefined && action.env !== traceFrame.invocation) {
    runtime.steps.stepBinding(
      action.code.bindingRow,
      storesAnswer(runtime, env, action.code.entryVisible, action.code.bindingNames ?? [], frame.traceFrame)
    );
  }
  startStatement(machine, state, frame);
}

export function enterCallFrame(
  machine: Machine,
  invocation: Env | undefined
): { traceFrame: TraceFrame; pushed: boolean } {
  const runtime = machine.runtime;
  const top = runtime.frames.at(-1);
  if (top && top.invocation === invocation) {
    markSilentCaller(machine, top);
    return { traceFrame: top, pushed: false };
  }
  let callRow = top?.currentRow();
  const callers = top && tailSelfCallers(machine, top, invocation?.info);
  if (callers && top) {
    callRow = top.callRow;
    for (const caller of callers) caller.tailCalled = true;
    runtime.popFrame(top, false);
  }
  return { traceFrame: runtime.pushFrame(invocation, callRow), pushed: true };
}

export function prepareBlock(machine: Machine, action: IODo): PreparedBlock {
  if (action.prepared) return action.prepared;
  machine.runtime.allocate(action.code.size);
  const env = new Env(action.code.size, action.env);
  const actions = new Map<number, Slot>();
  let end = 0;
  for (const [index, stmt] of action.code.stmts.entries()) {
    machine.runtime.spend();
    if (stmt.kind === 'let') {
      for (const bind of stmt.binds) env.slots[bind.index] = machine.makeLetSlot(bind.expr, env);
    } else {
      actions.set(index, machine.makeSlot(stmt.expr, env));
    }
    end = index + 1;
    if (stmt.kind === 'bind') break;
  }
  action.prepared = { env, actions, end };
  return action.prepared;
}

export function markTailSelfCall(machine: Machine, info: FunctionInfo | undefined): void {
  const top = machine.runtime.frames.at(-1);
  if (!info || top?.info !== info || top === machine.runtime.frames[0]) return;
  let index = machine.stack.length - 1;
  while (machine.stack[index]?.k === 'update' || machine.stack[index]?.k === 'functionResult') index--;
  if (machine.stack[index]?.k !== 'runIO') return;
  const callers = tailSelfCallers(machine, top, info, index - 1);
  if (callers) callers[0].silent = true;
}

function markSilentCaller(machine: Machine, top: TraceFrame): void {
  const caller = machine.stack.at(-1);
  if (caller?.k !== 'do' || caller.traceFrame !== top || caller.index !== caller.code.stmts.length - 1) return;
  const stmt = caller.code.stmts[caller.index];
  if (stmt.kind === 'exp' && stmt.onlyCalls) caller.silent = true;
}

function ioResultIsDiscarded(machine: Machine): boolean {
  for (let index = machine.stack.length - 1; index >= 0; index--) {
    const frame = machine.stack[index];
    if (frame.k === 'ioScope') continue;
    if (frame.k === 'base' || frame.k === 'ioThen') return true;
    if (frame.k !== 'do') return false;
    const stmt = frame.code.stmts[frame.index];
    return stmt.kind === 'exp' && (frame.index + 1 < frame.code.stmts.length || frame.discardResult);
  }
  return false;
}

// code-gauge-allow functionCognitiveComplexity 20 -- One stack walk checks tail statements through their owning call scope.
function tailSelfCallers(
  machine: Machine,
  frame: TraceFrame,
  info: FunctionInfo | undefined,
  start = machine.stack.length - 1
): DoFrame[] | undefined {
  if (!info || info !== frame.info || frame === machine.runtime.frames[0]) return undefined;
  const blocks: DoFrame[] = [];
  for (let index = start; index >= 0; index--) {
    const candidate = machine.stack[index];
    if (candidate.k === 'ioScope' && candidate.frame === frame) return blocks.length > 0 ? blocks : undefined;
    if (candidate.k !== 'do' || candidate.traceFrame !== frame || candidate.tailCalled) return undefined;
    const stmt = candidate.code.stmts[candidate.index];
    if (candidate.index !== candidate.code.stmts.length - 1 || stmt.kind !== 'exp') return undefined;
    if (blocks.length === 0 && !stmt.onlyCalls) return undefined;
    blocks.push(candidate);
    if (candidate.pushedTraceFrame) return blocks;
  }
  return undefined;
}

function startStatement(machine: Machine, state: RunState, frame: DoFrame): void {
  do {
    const stmt = frame.code.stmts[frame.index];
    const context = frame.traceFrame.contexts.at(-1) as TraceContext;
    context.visible = stmt.visible;
    context.row = stmt.row;
    frame.mark = machine.runtime.steps.statementMark();
    if (stmt.kind !== 'let') {
      machine.stack.push({ k: 'runIO' });
      state.enter(frame.prefix.actions.get(frame.index) ?? machine.makeSlot(stmt.expr, frame.env));
      return;
    }
    machine.runtime.spend();
    for (const bind of stmt.binds) {
      frame.env.slots[bind.index] =
        frame.index < frame.prefix.end ? frame.prefix.env.slots[bind.index] : machine.makeLetSlot(bind.expr, frame.env);
    }
    completeStatement(machine, frame);
  } while (advanceStatement(machine, state, frame));
}

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

export function finishMatch(machine: Machine, state: RunState, frame: DoFrame): void {
  if (frame.index + 1 < frame.code.stmts.length) frame.result = undefined;
  completeStatement(machine, frame);
  afterStatement(machine, state, frame);
}

function completeStatement(machine: Machine, frame: DoFrame): void {
  const stmt = frame.code.stmts[frame.index];
  if ((stmt.kind === 'exp' || stmt.kind === 'let') && stmt.noStep) return;
  if (frame.tailCalled || frame.silent) return;
  machine.runtime.steps.completeStatement(stmt.row, stmt.kind !== 'let' && stmt.onlyCalls, frame.mark);
}

function afterStatement(machine: Machine, state: RunState, frame: DoFrame): void {
  if (advanceStatement(machine, state, frame)) startStatement(machine, state, frame);
}

function advanceStatement(machine: Machine, state: RunState, frame: DoFrame): boolean {
  machine.runtime.endPreviewStatement(frame, frame.traceFrame);
  frame.index++;
  if (frame.index < frame.code.stmts.length) return true;
  machine.stack.pop();
  unwindBlock(machine, frame);
  state.ioResult(frame.result as Slot);
  return false;
}

export function unwindBlock(machine: Machine, frame: DoFrame): void {
  const runtime = machine.runtime;
  runtime.endPreviewStatement(frame, frame.traceFrame);
  if (frame.tailCalled) return;
  if (!frame.pushedTraceFrame) frame.traceFrame.contexts.pop();
  else if (runtime.frames[0] !== frame.traceFrame) runtime.popFrame(frame.traceFrame);
}

function storesAnswer(
  runtime: Runtime,
  env: Env,
  visible: VisibleScope,
  names: readonly string[],
  frame: TraceFrame
): boolean {
  return !!runtime.steps.recorder && names.some((name) => bindingDisplaysAnswer(runtime, env, visible, name, frame));
}

function bindingDisplaysAnswer(
  runtime: Runtime,
  env: Env,
  visible: VisibleScope,
  name: string,
  frame: TraceFrame
): boolean {
  try {
    const candidate = runtime.withDisplayBudget(20_000, () => {
      runtime.spend();
      const binding = visible.bindings.get(name);
      if (!binding) return;
      const ownerEnv = env.at(visible.level - binding.level);
      const slot = ownerEnv.slots[binding.index];
      if (slot === undefined) return;
      const type = slotDisplayType(slot, binding.type);
      return { slot, type, scalar: isScalarType(type), previewOwner: binding.previewOwner, ownerEnv };
    });
    return (
      candidate !== undefined &&
      (candidate.scalar ||
        runtime.displaysAnswer?.(name, candidate.slot, candidate.type, {
          owner: candidate.previewOwner,
          frame,
          scope: runtime.previewScope(frame, candidate.ownerEnv),
        }) === true)
    );
  } catch (error) {
    if (error instanceof DisplayAbort) return false;
    throw error;
  }
}
