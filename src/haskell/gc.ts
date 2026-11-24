import type { TurtleState } from '../interpreter/turtleWorld';
import type { Core, IOStmt, LocalRef } from './core';
import type { Frame } from './machine';
import type { Runtime } from './runtime';
import { chargeTypeWork } from './typeWorkBudget';
import {
  Closure,
  ConValue,
  Dict,
  type Env,
  IOBind,
  IOCall,
  IODo,
  IOPrim,
  IOReturn,
  IOThen,
  Partial,
  type PreparedBlock,
  RefValue,
  type Slot,
  Thunk,
  TurtleValue,
  untypedSlot,
} from './values';
import { visibleVariables } from './visibleScope';

const freeCache = new WeakMap<Core, LocalRef[]>();

export function freeVarsOf(code: Core): LocalRef[] {
  const pending: { code: Core; visited: boolean }[] = [{ code, visited: false }];
  while (pending.length > 0) {
    chargeTypeWork();
    const current = pending.pop()!;
    if (freeCache.has(current.code)) continue;
    const children = childCodes(current.code);
    if (!current.visited) {
      pending.push({ code: current.code, visited: true });
      for (const [child] of children) if (!freeCache.has(child)) pending.push({ code: child, visited: false });
      continue;
    }
    freeCache.set(current.code, cachedNodeReferences(current.code, children));
  }
  return freeCache.get(code)!;
}

function cachedNodeReferences(code: Core, children: [Core, boolean][]): LocalRef[] {
  const refs = new Map<string, LocalRef>();
  const add = (ref: LocalRef): void => {
    refs.set(`${ref.depth}:${ref.index}`, ref);
  };
  if (code.k === 'local') add({ depth: code.depth, index: code.index });
  for (const [child, inner] of children) {
    for (const ref of freeCache.get(child)!) {
      if (!inner) add(ref);
      else if (ref.depth > 0) add({ depth: ref.depth - 1, index: ref.index });
    }
  }
  if (code.k !== 'iodo') return [...refs.values()];
  for (const stmt of code.stmts) {
    for (const ref of visibleVariables(stmt.visible)) {
      if (ref.depth > 0) add({ depth: ref.depth - 1, index: ref.index });
    }
  }
  return [...refs.values()];
}

function childCodes(code: Core): [Core, boolean][] {
  switch (code.k) {
    case 'app': {
      return outer([code.fn, ...code.args]);
    }
    case 'lam':
    case 'frame': {
      return [[code.body, true]];
    }
    case 'let': {
      return outer([...code.binds.map((bind) => bind.expr), code.body]);
    }
    case 'case': {
      return outer([
        code.scrut,
        ...[...code.alts.values()].map((alt) => alt.body),
        ...(code.default ? [code.default] : []),
      ]);
    }
    case 'charCase': {
      return outer([code.scrut, code.matched, code.unmatched]);
    }
    case 'con':
    case 'dict': {
      return outer(code.args);
    }
    case 'deferredDo': {
      return outer(code.ordinary ? [code.ordinary, code.io] : [code.io]);
    }
    case 'method':
    case 'super': {
      return outer([code.dict]);
    }
    case 'iodo': {
      return code.stmts.flatMap(statementCodes).map((child) => [child, true]);
    }
    default: {
      return [];
    }
  }
}

function outer(codes: Core[]): [Core, boolean][] {
  return codes.map((child) => [child, false]);
}

function statementCodes(stmt: IOStmt): Core[] {
  return stmt.kind === 'let'
    ? stmt.binds.map((bind) => bind.expr)
    : [stmt.expr, ...(stmt.kind === 'bind' && stmt.matcher ? [stmt.matcher] : [])];
}

export function markReachable(
  runtime: Runtime,
  checkTime: () => void,
  temporaryRoots: readonly Slot[] = []
): Set<TurtleState> {
  const reached = new Set<TurtleState>();
  const seen = new Set<object>();
  const pending: Slot[] = [];
  const push = (slot: Slot | undefined): void => {
    slot = slot === undefined ? undefined : untypedSlot(slot);
    if (slot !== undefined && typeof slot === 'object' && !seen.has(slot)) pending.push(slot);
  };
  for (const root of temporaryRoots) {
    checkTime();
    push(root);
  }
  pushRoots(runtime, push);
  while (pending.length > 0) {
    const value = pending.pop() as Slot;
    if (typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    checkTime();
    if (value instanceof TurtleValue) reached.add(value.turtle);
    else pushReferences(runtime, value, push);
  }
  return reached;
}

type Push = (slot: Slot | undefined) => void;

function pushRefs(refs: Iterable<LocalRef>, env: Env | undefined, push: Push): void {
  if (!env) return;
  for (const ref of refs) {
    chargeTypeWork();
    push(env.at(ref.depth).slots[ref.index]);
  }
}

function pushRoots(runtime: Runtime, push: Push): void {
  for (const frame of runtime.frames) {
    for (const context of frame.contexts) {
      for (const visible of visibleVariables(context.visible)) push(context.env.at(visible.depth).slots[visible.index]);
    }
  }
  const scannedEnvs = new Set<Env>();
  for (const frame of runtime.machine.stack) pushStackFrame(frame, scannedEnvs, push);
}

// code-gauge-allow functionCognitiveComplexity -- One branch per kind of live evaluator frame that holds values, including pending IO results.
function pushStackFrame(frame: Frame, scannedEnvs: Set<Env>, push: Push): void {
  if (frame.k === 'update' && frame.code) pushRefs(freeVarsOf(frame.code), frame.env, push);
  else if (frame.k === 'apply' || frame.k === 'prim') for (const arg of frame.args) push(arg);
  else if (frame.k === 'ioBind' || frame.k === 'ioThen') push(frame.next);
  else if (frame.k === 'do' && !frame.tailCalled) {
    if (!frame.discardResult) push(frame.result);
    pushPreparedActions(frame.prefix, push, frame.index);
  } else if (frame.k === 'deferredDo') {
    push(frame.ordinary);
    push(frame.action);
  } else if (frame.k === 'case' || frame.k === 'charCase') {
    for (let current: Env | undefined = frame.env; current && !scannedEnvs.has(current); current = current.parent) {
      scannedEnvs.add(current);
      for (const slot of current.slots) push(slot);
    }
  }
}

// code-gauge-allow functionCognitiveComplexity -- One branch per kind of runtime value.
// code-gauge-allow functionNcss -- One branch per kind of runtime value.
function pushReferences(runtime: Runtime, value: object, push: Push): void {
  if (value instanceof ConValue) {
    for (const field of value.fields) push(field);
    for (const dict of value.dicts ?? []) push(dict);
  } else if (value instanceof RefValue) {
    push(value.value);
  } else if (value instanceof Thunk) {
    for (const root of runtime.previewRoots(value) ?? []) push(root);
    if (value.state === 'done') push(value.value);
    else if (value.code) pushRefs(freeVarsOf(value.code), value.env, push);
    else push(value.target);
  } else if (value instanceof Closure) {
    pushRefs(freeVarsOf(value.lam), value.env, push);
  } else if (value instanceof Partial) {
    push(value.fn);
    for (const arg of value.args) push(arg);
  } else if (value instanceof IODo) {
    pushRefs(freeVarsOf(value.code), value.env, push);
    pushPreparedActions(value.prepared, push);
  } else if (value instanceof IOCall) {
    push(value.action);
  } else if (value instanceof IOBind || value instanceof IOThen) {
    push(value.action);
    push(value.next);
  } else if (value instanceof IOReturn) {
    push(value.value);
  } else if (value instanceof IOPrim) {
    for (const ref of value.refs) push(ref);
  } else if (value instanceof Dict) {
    for (const slot of [...value.methods, ...value.supers, ...value.args]) push(slot);
  }
}

function pushPreparedActions(block: PreparedBlock | undefined, push: Push, start = 0): void {
  if (!block) return;
  for (const [index, action] of block.actions) if (index >= start) push(action);
}

export function thunkReferences(thunk: Thunk): readonly Slot[] | undefined {
  if (!thunk.code || !thunk.env) return thunk.target === undefined ? undefined : [thunk.target];
  const roots: Slot[] = [];
  pushRefs(freeVarsOf(thunk.code), thunk.env, (slot) => {
    if (slot !== undefined) roots.push(slot);
  });
  return roots.length > 0 ? roots : undefined;
}
