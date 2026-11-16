import type { TurtleState } from '../interpreter/turtleWorld';
import type { Core, IODoCore, LocalRef } from './core';
import type { Frame } from './machine';
import type { Runtime } from './runtime';
import {
  Closure,
  ConValue,
  Dict,
  type Env,
  IOBind,
  IODo,
  IOPrim,
  IOReturn,
  IOThen,
  Partial,
  type Slot,
  Thunk,
  TurtleValue,
  untypedSlot,
} from './values';

const freeCache = new WeakMap<Core, LocalRef[]>();

/** The variables a piece of code reads from its environment, relative to the frame it runs in. */
export function freeVarsOf(code: Core): LocalRef[] {
  const pending: { code: Core; visited: boolean }[] = [{ code, visited: false }];
  while (pending.length > 0) {
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
  if (code.k === 'iodo') {
    for (const stmt of code.stmts)
      for (const visible of stmt.visible) add({ depth: visible.depth, index: visible.index });
  }
  return [...refs.values()];
}

/** The code nested in a node, each telling whether it runs in a frame of its own. */
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
    case 'method':
    case 'super': {
      return outer([code.dict]);
    }
    case 'iodo': {
      return outer(
        code.stmts.flatMap((stmt) =>
          stmt.kind === 'let'
            ? stmt.binds.map((bind) => bind.expr)
            : [stmt.expr, ...(stmt.kind === 'bind' && stmt.matcher ? [stmt.matcher] : [])]
        )
      );
    }
    default: {
      return [];
    }
  }
}

function outer(codes: Core[]): [Core, boolean][] {
  return codes.map((child) => [child, false]);
}

const liveCache = new WeakMap<IODoCore, LocalRef[][]>();

/** The variables that a block's statements after the one at `index` read. */
function liveAfter(block: IODoCore, index: number): LocalRef[] {
  let byIndex = liveCache.get(block);
  if (!byIndex) {
    byIndex = [];
    let live: LocalRef[] = [];
    for (let position = block.stmts.length - 1; position >= 0; position--) {
      byIndex[position] = live;
      const stmt = block.stmts[position];
      const own =
        stmt.kind === 'let'
          ? stmt.binds.flatMap((bind) => freeVarsOf(bind.expr))
          : [...freeVarsOf(stmt.expr), ...(stmt.kind === 'bind' && stmt.matcher ? freeVarsOf(stmt.matcher) : [])];
      live = [...live, ...own];
    }
    liveCache.set(block, byIndex);
  }
  return byIndex[index] ?? [];
}

/** The turtles that the program's live variables and pending computations reach. */
export function markReachable(runtime: Runtime, checkTime: () => void): Set<TurtleState> {
  const reached = new Set<TurtleState>();
  const seen = new Set<object>();
  const pending: Slot[] = [];
  const push = (slot: Slot | undefined): void => {
    slot = slot === undefined ? undefined : untypedSlot(slot);
    if (slot !== undefined && typeof slot === 'object' && !seen.has(slot)) pending.push(slot);
  };
  pushRoots(runtime, push);
  while (pending.length > 0) {
    const value = pending.pop() as Slot;
    if (typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    checkTime();
    if (value instanceof TurtleValue) reached.add(value.turtle);
    else pushReferences(value, push);
  }
  return reached;
}

type Push = (slot: Slot | undefined) => void;

function pushRefs(refs: readonly LocalRef[], env: Env | undefined, push: Push): void {
  if (!env) return;
  for (const ref of refs) push(env.at(ref.depth).slots[ref.index]);
}

/** The roots: the variables each trace frame's running statement sees, and what the evaluator's stack holds. */
function pushRoots(runtime: Runtime, push: Push): void {
  for (const frame of runtime.frames) {
    // Blocks sharing an environment can shadow a turtle like Java assignment; a local call has a separate
    // environment and must keep its caller's locals alive even when the caller never reads them again.
    for (const [index, context] of frame.contexts.entries()) {
      if (context.env !== frame.contexts[index + 1]?.env || !context.block || context.index === undefined) {
        for (const visible of context.visible) push(context.env.at(visible.depth).slots[visible.index]);
      } else {
        pushRefs(liveAfter(context.block, context.index), context.env, push);
      }
    }
  }
  const scannedEnvs = new Set<Env>();
  for (const frame of runtime.machine.stack) pushStackFrame(frame, scannedEnvs, push);
}

// code-gauge-allow functionCognitiveComplexity 17 -- One branch per kind of evaluator frame that holds values.
function pushStackFrame(frame: Frame, scannedEnvs: Set<Env>, push: Push): void {
  if (frame.k === 'update' && frame.code) pushRefs(freeVarsOf(frame.code), frame.env, push);
  else if (frame.k === 'apply' || frame.k === 'prim') for (const arg of frame.args) push(arg);
  else if (frame.k === 'ioBind' || frame.k === 'ioThen') push(frame.next);
  else if (frame.k === 'do') push(frame.result);
  else if (frame.k === 'case' || frame.k === 'charCase') {
    for (let current: Env | undefined = frame.env; current && !scannedEnvs.has(current); current = current.parent) {
      scannedEnvs.add(current);
      for (const slot of current.slots) push(slot);
    }
  }
}

/** Pushes what a value refers to: a closure or a thunk only the variables its code reads. */
// code-gauge-allow functionCognitiveComplexity 22 -- One branch per kind of runtime value.
// code-gauge-allow functionNcss 39 -- One branch per kind of runtime value.
function pushReferences(value: object, push: Push): void {
  if (value instanceof ConValue) {
    for (const field of value.fields) push(field);
  } else if (value instanceof Thunk) {
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
