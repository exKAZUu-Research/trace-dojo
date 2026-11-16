import type { TurtleState } from '../interpreter/turtleWorld';
import type { Core, IODoCore, LocalRef } from './core';
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
} from './values';

const freeCache = new WeakMap<Core, LocalRef[]>();

/** The variables a piece of code reads from its environment, relative to the frame it runs in. */
export function freeVarsOf(code: Core): LocalRef[] {
  const cached = freeCache.get(code);
  if (cached) return cached;
  const refs = new Map<string, LocalRef>();
  const add = (ref: LocalRef): void => {
    refs.set(`${ref.depth}:${ref.index}`, ref);
  };
  const addShifted = (inner: LocalRef[]): void => {
    for (const ref of inner) if (ref.depth > 0) add({ depth: ref.depth - 1, index: ref.index });
  };
  switch (code.k) {
    case 'local': {
      add({ depth: code.depth, index: code.index });
      break;
    }
    case 'app': {
      for (const ref of freeVarsOf(code.fn)) add(ref);
      for (const arg of code.args) for (const ref of freeVarsOf(arg)) add(ref);
      break;
    }
    case 'lam':
    case 'frame': {
      addShifted(freeVarsOf(code.body));
      break;
    }
    case 'let': {
      for (const bind of code.binds) for (const ref of freeVarsOf(bind.expr)) add(ref);
      for (const ref of freeVarsOf(code.body)) add(ref);
      break;
    }
    case 'case': {
      for (const ref of freeVarsOf(code.scrut)) add(ref);
      for (const alt of code.alts.values()) for (const ref of freeVarsOf(alt.body)) add(ref);
      if (code.default) for (const ref of freeVarsOf(code.default)) add(ref);
      break;
    }
    case 'charCase': {
      for (const part of [code.scrut, code.matched, code.unmatched]) for (const ref of freeVarsOf(part)) add(ref);
      break;
    }
    case 'con':
    case 'dict': {
      for (const arg of code.args) for (const ref of freeVarsOf(arg)) add(ref);
      break;
    }
    case 'method':
    case 'super': {
      for (const ref of freeVarsOf(code.dict)) add(ref);
      break;
    }
    case 'iodo': {
      for (const stmt of code.stmts) {
        if (stmt.kind === 'let') for (const bind of stmt.binds) for (const ref of freeVarsOf(bind.expr)) add(ref);
        else {
          for (const ref of freeVarsOf(stmt.expr)) add(ref);
          if (stmt.kind === 'bind' && stmt.matcher) for (const ref of freeVarsOf(stmt.matcher)) add(ref);
        }
        for (const visible of stmt.visible) add({ depth: visible.depth, index: visible.index });
      }
      break;
    }
    default: {
      break;
    }
  }
  const result = [...refs.values()];
  freeCache.set(code, result);
  return result;
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
export function markReachable(runtime: Runtime): Set<TurtleState> {
  const reached = new Set<TurtleState>();
  const seen = new Set<object>();
  const pending: Slot[] = [];
  const scannedEnvs = new Set<Env>();
  const push = (slot: Slot | undefined): void => {
    if (slot !== undefined && typeof slot === 'object' && !seen.has(slot)) pending.push(slot);
  };
  const pushRefs = (refs: readonly LocalRef[], env: Env | undefined): void => {
    if (!env) return;
    for (const ref of refs) push(env.at(ref.depth).slots[ref.index]);
  };
  const pushEnv = (env: Env | undefined): void => {
    for (let current = env; current && !scannedEnvs.has(current); current = current.parent) {
      scannedEnvs.add(current);
      for (const slot of current.slots) push(slot);
    }
  };
  for (const frame of runtime.frames) {
    // The running statement's variables are live, as a Java method's locals are. A block that waits for an inner
    // block of the same call keeps only what its later statements use: a variable the inner block hides by a new
    // one of the same name is as gone as one a Java assignment overwrote.
    for (const [index, context] of frame.contexts.entries()) {
      if (index === frame.contexts.length - 1 || !context.block || context.index === undefined) {
        for (const visible of context.visible) push(context.env.at(visible.depth).slots[visible.index]);
      } else {
        pushRefs(liveAfter(context.block, context.index), context.env);
      }
    }
  }
  for (const frame of runtime.machine.stack) {
    switch (frame.k) {
      case 'update': {
        if (frame.code) pushRefs(freeVarsOf(frame.code), frame.env);
        break;
      }
      case 'apply':
      case 'prim': {
        for (const arg of frame.args) push(arg);
        break;
      }
      case 'case':
      case 'charCase': {
        pushEnv(frame.env);
        break;
      }
      case 'ioBind':
      case 'ioThen': {
        push(frame.next);
        break;
      }
      case 'do': {
        push(frame.result);
        break;
      }
      default: {
        break;
      }
    }
  }
  while (pending.length > 0) {
    const value = pending.pop() as Slot;
    if (typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    runtime.spend();
    if (value instanceof TurtleValue) reached.add(value.turtle);
    else if (value instanceof ConValue) for (const field of value.fields) push(field);
    else if (value instanceof Thunk) {
      if (value.state === 'done') push(value.value);
      else if (value.code) pushRefs(freeVarsOf(value.code), value.env);
    } else if (value instanceof Closure) pushRefs(freeVarsOf(value.lam), value.env);
    else if (value instanceof Partial) {
      push(value.fn);
      for (const arg of value.args) push(arg);
    } else if (value instanceof IODo) pushRefs(freeVarsOf(value.code), value.env);
    else if (value instanceof IOBind || value instanceof IOThen) {
      push(value.action);
      push(value.next);
    } else if (value instanceof IOReturn) push(value.value);
    else if (value instanceof IOPrim) for (const ref of value.refs) push(ref);
    else if (value instanceof Dict) {
      for (const method of value.methods) push(method);
      for (const sup of value.supers) push(sup);
      for (const arg of value.args) push(arg);
    }
  }
  return reached;
}
