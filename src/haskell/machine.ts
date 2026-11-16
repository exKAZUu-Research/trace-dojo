import { ExecutionLimitError } from '../interpreter/limits';
import { CONS_CON, NIL_CON } from './builtinTypes';
import type { CaseCore, Core, IODoCore, IOStmt, VisibleVar } from './core';
import type { ConInfo } from './entities';
import type { Primitive } from './primitives';
import type { Runtime, TraceFrame } from './runtime';
import {
  Closure,
  ConValue,
  type Dict,
  Env,
  HaskellException,
  IOBind,
  IODo,
  IOPrim,
  IOReturn,
  IOThen,
  Partial,
  PrimFn,
  type Slot,
  Thunk,
  type Value,
} from './values';

type Frame =
  | { k: 'update'; thunk: Thunk; code: Core | undefined; env: Env | undefined; native?: () => Slot | TailCall }
  | { k: 'apply'; args: Slot[] }
  | { k: 'case'; core: CaseCore; env: Env }
  | { k: 'charCase'; core: Extract<Core, { k: 'charCase' }>; env: Env }
  | { k: 'method'; index: number }
  | { k: 'super'; index: number }
  | { k: 'prim'; prim: Primitive; args: Slot[]; position: number }
  | { k: 'runIO' }
  | { k: 'ioBind'; next: Slot }
  | { k: 'ioThen'; next: Slot }
  | DoFrame
  | { k: 'doMatch'; frame: DoFrame }
  | { k: 'base' };

interface DoFrame {
  k: 'do';
  code: IODoCore;
  env: Env;
  index: number;
  mark: number;
  traceFrame: TraceFrame;
  pushedTraceFrame: boolean;
  /** Whether the block's last statement made a tail call that took over its trace frame. */
  tailCalled?: boolean;
  /** Whether the block's last statement called a local function whose blocks recorded its steps. */
  silent?: boolean;
  result?: Slot;
}

const nullaryCache = new WeakMap<ConInfo, ConValue>();

export function nullary(con: ConInfo): ConValue {
  let value = nullaryCache.get(con);
  if (!value) {
    value = new ConValue(con, []);
    nullaryCache.set(con, value);
  }
  return value;
}

export const NIL = (): ConValue => nullary(NIL_CON);

export function cons(head: Slot, tail: Slot): ConValue {
  return new ConValue(CONS_CON, [head, tail]);
}

/** A string literal's characters from `index` on, unpacked one cell at a time as they are demanded. */
export function unpackString(text: string, index: number): Value {
  if (index >= text.length) return NIL();
  const code = text.codePointAt(index) as number;
  const char = String.fromCodePoint(code);
  const next = index + char.length;
  return cons(char, next >= text.length ? NIL() : new Thunk(undefined, undefined, () => unpackString(text, next)));
}

const primFnCache = new WeakMap<Primitive, PrimFn>();

function primFn(prim: Primitive): PrimFn {
  let fn = primFnCache.get(prim);
  if (!fn) {
    fn = new PrimFn(prim);
    primFnCache.set(prim, fn);
  }
  return fn;
}

/** A primitive's request to apply a function in its place, as a tail call. */
export class TailCall {
  constructor(
    readonly fn: Value,
    readonly args: Slot[]
  ) {}
}

/** An `IO` primitive's request to run another action in its place. */
export class RunNext {
  constructor(readonly action: Slot) {}
}

/** The result of a primitive: a value or slot, or a function to apply in its place. */
export type PrimResult = Slot | TailCall;

/** Thrown when a thunk demands its own value, which GHC reports as `<<loop>>`. */
function loopError(): HaskellException {
  return new HaskellException('<<loop>>', 'NonTermination');
}

/**
 * Evaluates Core with an explicit stack, so that deep recursion in a program does not exhaust the host's stack.
 * Evaluation may nest (a primitive forcing a value), each level running until the stack returns to its base.
 */
export class Machine {
  readonly stack: Frame[] = [];

  constructor(private readonly runtime: Runtime) {}

  /** Evaluates a slot to weak head normal form. */
  force(slot: Slot): Value {
    if (!(slot instanceof Thunk)) return slot;
    if (slot.state === 'done') return slot.value as Value;
    return this.run({ mode: 'enter', slot }) as Value;
  }

  evaluate(code: Core, env: Env | undefined): Value {
    return this.run({ mode: 'eval', code, env }) as Value;
  }

  apply(fn: Value, args: Slot[]): Value {
    return this.run({ mode: 'apply', fn, args }) as Value;
  }

  /** Runs an `IO` action to its end, returning its result. */
  runIO(action: Slot): Slot {
    return this.run({ mode: 'runSlotIO', slot: action });
  }

  /** Creates the slot for an argument or binding: a value when it needs no evaluation, else a thunk. */
  makeSlot(code: Core, env: Env | undefined): Slot {
    switch (code.k) {
      case 'local': {
        return (env as Env).at(code.depth).slots[code.index] as Slot;
      }
      case 'lit': {
        return code.value;
      }
      case 'lam': {
        return new Closure(code, env);
      }
      case 'global': {
        return this.runtime.global(code.global);
      }
      case 'prim': {
        return primFn(code.prim);
      }
      case 'con': {
        if (code.args.length === 0) return nullary(code.con);
        this.runtime.allocate(code.args.length);
        return new ConValue(
          code.con,
          code.args.map((arg) => this.makeSlot(arg, env))
        );
      }
      case 'iodo': {
        return new IODo(code, env as Env);
      }
      default: {
        return new Thunk(code, env);
      }
    }
  }

  /**
   * Creates the slot of a `let` binding, which may refer to bindings of the same group not yet made: only code that
   * reads no variables when it is made is evaluated at once.
   */
  makeLetSlot(code: Core, env: Env): Slot {
    if (code.k === 'lit' || code.k === 'lam' || code.k === 'global' || code.k === 'prim' || code.k === 'iodo') {
      return this.makeSlot(code, env);
    }
    return new Thunk(code, env);
  }

  private run(start: RunStart): Slot {
    const { stack } = this;
    const base = stack.length;
    stack.push({ k: 'base' });
    let mode: Mode = start.mode === 'runSlotIO' ? 'enter' : start.mode;
    let code: Core = start.mode === 'eval' ? start.code : (undefined as unknown as Core);
    let env: Env | undefined = start.mode === 'eval' ? start.env : undefined;
    let value: Slot =
      start.mode === 'enter' || start.mode === 'runSlotIO' ? start.slot : (undefined as unknown as Slot);
    let fn: Value = start.mode === 'apply' ? start.fn : (undefined as unknown as Value);
    let args: Slot[] = start.mode === 'apply' ? start.args : [];
    if (start.mode === 'runSlotIO') stack.push({ k: 'runIO' });
    const runtime = this.runtime;
    for (;;) {
      try {
        for (;;) {
          switch (mode) {
            case 'eval': {
              switch (code.k) {
                case 'local': {
                  value = (env as Env).at(code.depth).slots[code.index] as Slot;
                  mode = 'enter';
                  break;
                }
                case 'global': {
                  value = runtime.global(code.global);
                  mode = 'enter';
                  break;
                }
                case 'lit': {
                  value = code.value;
                  mode = 'return';
                  break;
                }
                case 'str': {
                  value = unpackString(code.value, 0);
                  mode = 'return';
                  break;
                }
                case 'app': {
                  stack.push({ k: 'apply', args: code.args.map((arg) => this.makeSlot(arg, env)) });
                  code = code.fn;
                  break;
                }
                case 'lam': {
                  value = new Closure(code, env);
                  mode = 'return';
                  break;
                }
                case 'frame': {
                  runtime.allocate(code.size);
                  env = new Env(code.size, env, code.info);
                  code = code.body;
                  break;
                }
                case 'let': {
                  const target = env as Env;
                  for (const bind of code.binds) target.slots[bind.index] = this.makeLetSlot(bind.expr, target);
                  code = code.body;
                  break;
                }
                case 'case': {
                  stack.push({ k: 'case', core: code, env: env as Env });
                  code = code.scrut;
                  break;
                }
                case 'charCase': {
                  stack.push({ k: 'charCase', core: code, env: env as Env });
                  code = code.scrut;
                  break;
                }
                case 'con': {
                  value = this.makeSlot(code, env);
                  mode = 'return';
                  break;
                }
                case 'prim': {
                  value = primFn(code.prim);
                  mode = 'return';
                  break;
                }
                case 'method': {
                  stack.push({ k: 'method', index: code.index });
                  code = code.dict;
                  break;
                }
                case 'super': {
                  stack.push({ k: 'super', index: code.index });
                  code = code.dict;
                  break;
                }
                case 'dict': {
                  value = runtime.makeDict(
                    code.instance,
                    code.args.map((arg) => this.makeSlot(arg, env))
                  );
                  mode = 'return';
                  break;
                }
                case 'error': {
                  throw new HaskellException(
                    code.message,
                    code.kind === 'patternMatch' ? 'PatternMatchFail' : 'ErrorCall'
                  );
                }
                case 'iodo': {
                  value = new IODo(code, env as Env);
                  mode = 'return';
                  break;
                }
              }
              break;
            }
            case 'enter': {
              const slot = value;
              if (!(slot instanceof Thunk)) {
                mode = 'return';
                break;
              }
              if (slot.state === 'done') {
                value = slot.value as Value;
                mode = 'return';
                break;
              }
              if (slot.state === 'evaluating') throw loopError();
              slot.state = 'evaluating';
              stack.push({ k: 'update', thunk: slot, code: slot.code, env: slot.env, native: slot.native });
              if (slot.native) {
                const result = slot.native();
                if (result instanceof TailCall) {
                  fn = result.fn;
                  args = result.args;
                  mode = 'apply';
                } else {
                  value = result;
                  mode = 'enter';
                }
                break;
              }
              code = slot.code as Core;
              env = slot.env;
              mode = 'eval';
              break;
            }
            case 'apply': {
              runtime.spend();
              if (fn instanceof Closure) {
                const arity = fn.lam.arity;
                if (args.length < arity) {
                  value = new Partial(fn, args);
                  mode = 'return';
                  break;
                }
                if (args.length > arity) {
                  stack.push({ k: 'apply', args: args.slice(arity) });
                  args = args.slice(0, arity);
                }
                runtime.allocate(fn.lam.size);
                const frameEnv = new Env(fn.lam.size, fn.env, fn.lam.info);
                for (let index = 0; index < arity; index++) frameEnv.slots[index] = args[index];
                env = frameEnv;
                code = fn.lam.body;
                mode = 'eval';
                break;
              }
              if (fn instanceof Partial) {
                args = [...fn.args, ...args];
                fn = fn.fn;
                break;
              }
              if (fn instanceof PrimFn) {
                const arity = fn.prim.arity;
                if (args.length < arity) {
                  value = new Partial(fn, args);
                  mode = 'return';
                  break;
                }
                if (args.length > arity) {
                  stack.push({ k: 'apply', args: args.slice(arity) });
                  args = args.slice(0, arity);
                }
                stack.push({ k: 'prim', prim: fn.prim, args: [...args], position: 0 });
                value = undefined as unknown as Slot;
                mode = 'primNext';
                break;
              }
              throw new Error(`Applying a non-function value: ${describeValue(fn)}`);
            }
            case 'primNext': {
              const frame = stack.at(-1) as Extract<Frame, { k: 'prim' }>;
              const strict = frame.prim.strict;
              while (frame.position < frame.args.length) {
                const position = frame.position;
                const isStrict = strict === 'all' || strict.includes(position);
                const arg = frame.args[position];
                if (isStrict && arg instanceof Thunk && arg.state !== 'done') break;
                if (isStrict && arg instanceof Thunk) frame.args[position] = arg.value as Value;
                frame.position++;
              }
              if (frame.position < frame.args.length) {
                value = frame.args[frame.position];
                mode = 'enter';
                break;
              }
              stack.pop();
              const result = frame.prim.fn(frame.args, runtime);
              if (result instanceof TailCall) {
                fn = result.fn;
                args = result.args;
                mode = 'apply';
                break;
              }
              value = result;
              mode = 'enter';
              break;
            }
            case 'return': {
              const frame = stack.pop() as Frame;
              switch (frame.k) {
                case 'base': {
                  return value;
                }
                case 'update': {
                  const thunk = frame.thunk;
                  thunk.state = 'done';
                  thunk.value = value as Value;
                  thunk.code = undefined;
                  thunk.env = undefined;
                  thunk.native = undefined;
                  break;
                }
                case 'apply': {
                  fn = value as Value;
                  args = frame.args;
                  mode = 'apply';
                  break;
                }
                case 'case': {
                  const scrutinee = value as ConValue;
                  const { core } = frame;
                  if (core.bindIndex !== undefined) frame.env.slots[core.bindIndex] = scrutinee;
                  const alt = core.alts.get(scrutinee.con.tag);
                  if (alt) {
                    const { slots } = alt;
                    for (let index = 0; index < slots.length; index++) {
                      if (slots[index] >= 0) frame.env.slots[slots[index]] = scrutinee.fields[index];
                    }
                    code = alt.body;
                  } else if (core.default) {
                    code = core.default;
                  } else {
                    throw new Error(`No alternative for ${scrutinee.con.name}`);
                  }
                  env = frame.env;
                  mode = 'eval';
                  break;
                }
                case 'charCase': {
                  code = value === frame.core.value ? frame.core.matched : frame.core.unmatched;
                  env = frame.env;
                  mode = 'eval';
                  break;
                }
                case 'method': {
                  value = (value as Dict).methods[frame.index];
                  mode = 'enter';
                  break;
                }
                case 'super': {
                  value = (value as Dict).supers[frame.index];
                  mode = 'enter';
                  break;
                }
                case 'prim': {
                  frame.args[frame.position] = value as Value;
                  frame.position++;
                  stack.push(frame);
                  mode = 'primNext';
                  break;
                }
                case 'runIO': {
                  mode = 'io';
                  break;
                }
                case 'doMatch': {
                  this.completeStatement(frame.frame);
                  ({ mode, value } = this.afterStatement(frame.frame));
                  break;
                }
                default: {
                  throw new Error(`A value returned to an IO frame (${frame.k})`);
                }
              }
              break;
            }
            case 'io': {
              const action = value as Value;
              runtime.spend();
              if (action instanceof IOReturn) {
                value = action.value;
                mode = 'ioDone';
              } else if (action instanceof IOBind) {
                stack.push({ k: 'ioBind', next: action.next }, { k: 'runIO' });
                value = action.action;
                mode = 'enter';
              } else if (action instanceof IOThen) {
                stack.push({ k: 'ioThen', next: action.next }, { k: 'runIO' });
                value = action.action;
                mode = 'enter';
              } else if (action instanceof IOPrim) {
                const result = action.run();
                if (result instanceof RunNext) {
                  stack.push({ k: 'runIO' });
                  value = result.action;
                  mode = 'enter';
                } else {
                  value = result;
                  mode = 'ioDone';
                }
              } else if (action instanceof IODo) {
                ({ mode, value } = this.startDo(action));
              } else {
                throw new Error(`Running a non-IO value: ${describeValue(action)}`);
              }
              break;
            }
            case 'ioDone': {
              const frame = stack.pop() as Frame;
              switch (frame.k) {
                case 'base': {
                  return value;
                }
                case 'ioBind': {
                  stack.push({ k: 'runIO' }, { k: 'apply', args: [value] });
                  value = frame.next;
                  mode = 'enter';
                  break;
                }
                case 'ioThen': {
                  stack.push({ k: 'runIO' });
                  value = frame.next;
                  mode = 'enter';
                  break;
                }
                case 'do': {
                  ({ mode, value, code, env } = this.statementDone(frame, value));
                  break;
                }
                default: {
                  throw new Error(`An IO result returned to a pure frame (${frame.k})`);
                }
              }
              break;
            }
          }
        }
      } catch (error) {
        this.unwind(base);
        throw error;
      }
    }
  }

  /** Pops the frames above `base` after an exception, resetting the thunks they were evaluating. */
  private unwind(base: number): void {
    const { stack } = this;
    while (stack.length > base) {
      const frame = stack.pop() as Frame;
      if (frame.k === 'update') {
        frame.thunk.state = 'pending';
        frame.thunk.code = frame.code;
        frame.thunk.env = frame.env;
        frame.thunk.native = frame.native;
      } else if (frame.k === 'do') {
        this.leaveDo(frame);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // IO blocks

  private startDo(action: IODo): { mode: Mode; value: Slot } {
    const runtime = this.runtime;
    const invocation = action.env.invocation();
    const top = runtime.frames.at(-1);
    let traceFrame = top;
    let pushed = false;
    if (!top || top.invocation !== invocation) {
      let callRow = top?.currentRow();
      const callers = top && this.tailSelfCaller(top, invocation);
      if (callers && top) {
        // A function calling itself as its last statement loops: its new call takes the old one's place in the trace.
        callRow = top.callRow;
        for (const caller of callers) caller.tailCalled = true;
        runtime.popFrame(top, false);
      }
      traceFrame = runtime.pushFrame(invocation, callRow);
      pushed = true;
    } else {
      // A local function or action called as a block's last statement (a loop written as recursion) shows its work
      // in its own steps, so the call records no step of its own when it returns.
      const caller = this.stack.at(-1);
      if (caller?.k === 'do' && caller.traceFrame === top && caller.index === caller.code.stmts.length - 1) {
        const stmt = caller.code.stmts[caller.index];
        if (stmt.kind === 'exp' && stmt.onlyCalls) caller.silent = true;
      }
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
    this.stack.push(frame);
    if (action.code.bindingRow !== undefined) {
      runtime.steps.stepBinding(action.code.bindingRow, action.code.bindingStoresAnswer ?? false);
    }
    return this.startStatement(frame);
  }

  /**
   * The blocks of `frame` when each is running its last statement and the innermost one calls the same function as
   * `invocation`: a tail call, which a loop written as recursion makes.
   */
  private tailSelfCaller(frame: TraceFrame, invocation: Env | undefined): DoFrame[] | undefined {
    const info = invocation?.info;
    if (!info || info !== frame.info || frame === this.runtime.frames[0]) return undefined;
    const blocks: DoFrame[] = [];
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const candidate = this.stack[index];
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

  private startStatement(frame: DoFrame): { mode: Mode; value: Slot } {
    const stmt = frame.code.stmts[frame.index];
    const context = frame.traceFrame.contexts.at(-1) as TraceContext;
    context.visible = stmt.visible;
    context.row = stmt.row;
    context.block = frame.code;
    context.index = frame.index;
    frame.mark = this.runtime.steps.statementMark();
    if (stmt.kind === 'let') {
      for (const bind of stmt.binds) frame.env.slots[bind.index] = this.makeLetSlot(bind.expr, frame.env);
      this.completeStatement(frame);
      return this.afterStatement(frame);
    }
    this.stack.push({ k: 'runIO' });
    return { mode: 'enter', value: this.makeSlot(stmt.expr, frame.env) };
  }

  /** Receives a statement's result: binds it, matching its pattern if it has one, then moves on. */
  private statementDone(frame: DoFrame, result: Slot): { mode: Mode; value: Slot; code: Core; env: Env | undefined } {
    const stmt = frame.code.stmts[frame.index];
    this.stack.push(frame);
    frame.result = result;
    if (stmt.kind === 'bind') {
      frame.env.slots[stmt.slot] = result;
      if (stmt.matcher) {
        this.stack.push({ k: 'doMatch', frame });
        return { mode: 'eval', value: result, code: stmt.matcher, env: frame.env };
      }
    }
    this.completeStatement(frame);
    const next = this.afterStatement(frame);
    return { ...next, code: undefined as unknown as Core, env: undefined };
  }

  private completeStatement(frame: DoFrame): void {
    const stmt = frame.code.stmts[frame.index] as IOStmt;
    if ((stmt.kind === 'exp' || stmt.kind === 'let') && stmt.noStep) return;
    if (frame.tailCalled || frame.silent) return;
    this.runtime.steps.completeStatement(stmt.row, stmt.kind !== 'let' && stmt.onlyCalls, frame.mark);
  }

  /** Starts the next statement, or ends the block with the last statement's result. */
  private afterStatement(frame: DoFrame): { mode: Mode; value: Slot } {
    frame.index++;
    if (frame.index < frame.code.stmts.length) {
      // Only the last statement's result is the block's; an earlier one must not keep what it reaches alive.
      frame.result = undefined;
      return this.startStatement(frame);
    }
    this.stack.pop();
    this.leaveDo(frame);
    return { mode: 'ioDone', value: frame.result as Slot };
  }

  /** Leaves a block's trace context, keeping the entry point's frame, which shows the program's final variables. */
  private leaveDo(frame: DoFrame): void {
    const runtime = this.runtime;
    if (frame.tailCalled) return;
    if (!frame.pushedTraceFrame) frame.traceFrame.contexts.pop();
    else if (runtime.frames[0] !== frame.traceFrame) runtime.popFrame(frame.traceFrame);
  }
}

export interface TraceContext {
  env: Env;
  visible: VisibleVar[];
  row: number | undefined;
  /** The block and the statement running in this context. */
  block?: IODoCore;
  index?: number;
}

type Mode = 'eval' | 'enter' | 'apply' | 'primNext' | 'return' | 'io' | 'ioDone';

type RunStart =
  | { mode: 'eval'; code: Core; env: Env | undefined }
  | { mode: 'enter'; slot: Slot }
  | { mode: 'apply'; fn: Value; args: Slot[] }
  | { mode: 'runSlotIO'; slot: Slot };

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null) return value.constructor.name;
  return typeof value;
}

export function checkStackLimit(length: number): void {
  if (length > 5_000_000) throw new ExecutionLimitError('operations');
}
