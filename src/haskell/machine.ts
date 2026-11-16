import { CONS_CON, NIL_CON } from './builtinTypes';
import type { CaseCore, Core } from './core';
import type { ConInfo } from './entities';
import { type DoFrame, finishMatch, runBlock, statementDone, unwindBlock } from './ioBlocks';
import type { Primitive } from './primitives';
import type { Runtime } from './runtime';
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

export type Frame =
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

  constructor(readonly runtime: Runtime) {}

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

  // code-gauge-allow functionNcss 35 -- The main loop dispatches on the machine mode and handles limits and exceptions in one place.
  private run(start: RunStart): Slot {
    const { stack } = this;
    const base = stack.length;
    stack.push({ k: 'base' });
    const state = new RunState(start);
    if (start.mode === 'runSlotIO') stack.push({ k: 'runIO' });
    try {
      for (;;) {
        switch (state.mode) {
          case 'eval': {
            this.stepEval(state);
            break;
          }
          case 'enter': {
            this.stepEnter(state);
            break;
          }
          case 'apply': {
            this.stepApply(state);
            break;
          }
          case 'primNext': {
            this.stepPrim(state);
            break;
          }
          case 'return': {
            if (this.stepReturn(state)) return state.value;
            break;
          }
          case 'io': {
            this.stepIO(state);
            break;
          }
          case 'ioDone': {
            if (this.stepIODone(state)) return state.value;
            break;
          }
        }
      }
    } catch (error) {
      this.unwind(base);
      throw error;
    }
  }

  /** Evaluates one node of code: a value returns, and other nodes push what they continue with. */
  // code-gauge-allow functionNcss 47 -- One short case per kind of code node.
  private stepEval(state: RunState): void {
    const { code, env } = state;
    switch (code.k) {
      case 'local': {
        state.enter((env as Env).at(code.depth).slots[code.index] as Slot);
        return;
      }
      case 'global': {
        state.enter(this.runtime.global(code.global));
        return;
      }
      case 'lit':
      case 'str':
      case 'lam':
      case 'con':
      case 'prim':
      case 'iodo': {
        state.returnValue(code.k === 'str' ? unpackString(code.value, 0) : this.makeSlot(code, env));
        return;
      }
      case 'app': {
        this.stack.push({ k: 'apply', args: code.args.map((arg) => this.makeSlot(arg, env)) });
        state.code = code.fn;
        return;
      }
      case 'frame': {
        this.runtime.allocate(code.size);
        state.env = new Env(code.size, env, code.info);
        state.code = code.body;
        return;
      }
      case 'let': {
        const target = env as Env;
        for (const bind of code.binds) target.slots[bind.index] = this.makeLetSlot(bind.expr, target);
        state.code = code.body;
        return;
      }
      case 'case':
      case 'charCase': {
        this.stack.push(
          code.k === 'case'
            ? { k: 'case', core: code, env: env as Env }
            : { k: 'charCase', core: code, env: env as Env }
        );
        state.code = code.scrut;
        return;
      }
      case 'method':
      case 'super': {
        this.stack.push({ k: code.k, index: code.index });
        state.code = code.dict;
        return;
      }
      case 'dict': {
        state.returnValue(
          this.runtime.makeDict(
            code.instance,
            code.args.map((arg) => this.makeSlot(arg, env))
          )
        );
        return;
      }
      case 'error': {
        throw new HaskellException(code.message, code.kind === 'patternMatch' ? 'PatternMatchFail' : 'ErrorCall');
      }
    }
  }

  /** Enters a slot: a value returns, and a pending thunk is evaluated with a frame that updates it. */
  private stepEnter(state: RunState): void {
    const slot = state.value;
    if (!(slot instanceof Thunk)) {
      state.mode = 'return';
      return;
    }
    if (slot.state === 'done') {
      state.returnValue(slot.value as Value);
      return;
    }
    if (slot.state === 'evaluating') throw loopError();
    slot.state = 'evaluating';
    this.stack.push({ k: 'update', thunk: slot, code: slot.code, env: slot.env, native: slot.native });
    if (!slot.native) {
      state.evaluate(slot.code as Core, slot.env);
      return;
    }
    const result = slot.native();
    if (result instanceof TailCall) state.applyTo(result.fn, result.args);
    else state.enter(result);
  }

  /** Applies a function to arguments: a call when it has them all, a partial application when it lacks some. */
  private stepApply(state: RunState): void {
    let { fn, args } = state;
    if (fn instanceof Partial) {
      state.applyTo(fn.fn, [...fn.args, ...args]);
      return;
    }
    if (!(fn instanceof Closure) && !(fn instanceof PrimFn)) {
      throw new TypeError(`Applying a non-function value: ${describeValue(fn)}`);
    }
    const arity = fn.arity;
    if (args.length < arity) {
      state.returnValue(new Partial(fn, args));
      return;
    }
    if (args.length > arity) {
      this.stack.push({ k: 'apply', args: args.slice(arity) });
      args = args.slice(0, arity);
    }
    if (fn instanceof PrimFn) {
      this.stack.push({ k: 'prim', prim: fn.prim, args: [...args], position: 0 });
      state.mode = 'primNext';
      return;
    }
    // A call of a Haskell function counts as an operation; a primitive's cost is its own to charge.
    this.runtime.spend();
    this.runtime.allocate(fn.lam.size);
    const frameEnv = new Env(fn.lam.size, fn.env, fn.lam.info);
    for (let index = 0; index < arity; index++) frameEnv.slots[index] = args[index];
    state.evaluate(fn.lam.body, frameEnv);
  }

  /** Forces a primitive's strict arguments one by one, then runs it. */
  private stepPrim(state: RunState): void {
    const frame = this.stack.at(-1) as Extract<Frame, { k: 'prim' }>;
    const strict = frame.prim.strict;
    while (frame.position < frame.args.length) {
      const arg = frame.args[frame.position];
      const isStrict = strict === 'all' || strict.includes(frame.position);
      if (isStrict && arg instanceof Thunk) {
        if (arg.state !== 'done') {
          state.enter(arg);
          return;
        }
        frame.args[frame.position] = arg.value as Value;
      }
      frame.position++;
    }
    this.stack.pop();
    const result = frame.prim.fn(frame.args, this.runtime);
    if (result instanceof TailCall) state.applyTo(result.fn, result.args);
    else state.enter(result);
  }

  /** Delivers a value to the frame on top of the stack, telling whether it reached the base of this run. */
  // code-gauge-allow functionNcss 41 -- One short case per kind of frame a value returns to.
  private stepReturn(state: RunState): boolean {
    const frame = this.stack.pop() as Frame;
    switch (frame.k) {
      case 'base': {
        return true;
      }
      case 'update': {
        const thunk = frame.thunk;
        thunk.state = 'done';
        thunk.value = state.value as Value;
        thunk.code = undefined;
        thunk.env = undefined;
        thunk.native = undefined;
        return false;
      }
      case 'apply': {
        state.applyTo(state.value as Value, frame.args);
        return false;
      }
      case 'case': {
        this.selectAlternative(state, frame.core, frame.env);
        return false;
      }
      case 'charCase': {
        state.evaluate(state.value === frame.core.value ? frame.core.matched : frame.core.unmatched, frame.env);
        return false;
      }
      case 'method':
      case 'super': {
        const dict = state.value as Dict;
        state.enter(frame.k === 'method' ? dict.methods[frame.index] : dict.supers[frame.index]);
        return false;
      }
      case 'prim': {
        frame.args[frame.position] = state.value as Value;
        frame.position++;
        this.stack.push(frame);
        state.mode = 'primNext';
        return false;
      }
      case 'runIO': {
        state.mode = 'io';
        return false;
      }
      case 'doMatch': {
        finishMatch(this, state, frame.frame);
        return false;
      }
      default: {
        throw new Error(`A value returned to an IO frame (${frame.k})`);
      }
    }
  }

  private selectAlternative(state: RunState, core: CaseCore, env: Env): void {
    const scrutinee = state.value as ConValue;
    if (core.bindIndex !== undefined) env.slots[core.bindIndex] = scrutinee;
    const alt = core.alts.get(scrutinee.con.tag);
    if (alt) {
      const { slots } = alt;
      for (let index = 0; index < slots.length; index++) {
        if (slots[index] >= 0) env.slots[slots[index]] = scrutinee.fields[index];
      }
      state.evaluate(alt.body, env);
      return;
    }
    if (!core.default) throw new Error(`No alternative for ${scrutinee.con.name}`);
    state.evaluate(core.default, env);
  }

  /** Runs an `IO` action: its result goes to the frame below, and a composed action runs its parts in turn. */
  private stepIO(state: RunState): void {
    const action = state.value as Value;
    this.runtime.spend();
    if (action instanceof IOReturn) {
      state.ioResult(action.value);
    } else if (action instanceof IOBind || action instanceof IOThen) {
      this.stack.push(
        action instanceof IOBind ? { k: 'ioBind', next: action.next } : { k: 'ioThen', next: action.next },
        { k: 'runIO' }
      );
      state.enter(action.action);
    } else if (action instanceof IOPrim) {
      const result = action.run();
      if (result instanceof RunNext) {
        this.stack.push({ k: 'runIO' });
        state.enter(result.action);
      } else {
        state.ioResult(result);
      }
    } else if (action instanceof IODo) {
      runBlock(this, state, action);
    } else {
      throw new Error(`Running a non-IO value: ${describeValue(action)}`);
    }
  }

  /** Delivers an action's result to the frame on top of the stack, telling whether it reached the base of this run. */
  private stepIODone(state: RunState): boolean {
    const frame = this.stack.pop() as Frame;
    switch (frame.k) {
      case 'base': {
        return true;
      }
      case 'ioBind': {
        this.stack.push({ k: 'runIO' }, { k: 'apply', args: [state.value] });
        state.enter(frame.next);
        return false;
      }
      case 'ioThen': {
        this.stack.push({ k: 'runIO' });
        state.enter(frame.next);
        return false;
      }
      case 'do': {
        statementDone(this, state, frame);
        return false;
      }
      default: {
        throw new Error(`An IO result returned to a pure frame (${frame.k})`);
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
        unwindBlock(this, frame);
      }
    }
  }
}

export type Mode = 'eval' | 'enter' | 'apply' | 'primNext' | 'return' | 'io' | 'ioDone';

type RunStart =
  | { mode: 'eval'; code: Core; env: Env | undefined }
  | { mode: 'enter'; slot: Slot }
  | { mode: 'apply'; fn: Value; args: Slot[] }
  | { mode: 'runSlotIO'; slot: Slot };

/** What one level of evaluation is doing: evaluating code, entering a slot, applying a function, or running IO. */
export class RunState {
  mode: Mode;
  code = undefined as unknown as Core;
  env: Env | undefined;
  value = undefined as unknown as Slot;
  fn = undefined as unknown as Value;
  args: Slot[] = [];

  constructor(start: RunStart) {
    switch (start.mode) {
      case 'eval': {
        this.mode = 'eval';
        this.code = start.code;
        this.env = start.env;
        break;
      }
      case 'apply': {
        this.mode = 'apply';
        this.fn = start.fn;
        this.args = start.args;
        break;
      }
      default: {
        this.mode = 'enter';
        this.value = start.slot;
      }
    }
  }

  evaluate(code: Core, env: Env | undefined): void {
    this.mode = 'eval';
    this.code = code;
    this.env = env;
  }

  enter(slot: Slot): void {
    this.mode = 'enter';
    this.value = slot;
  }

  returnValue(value: Slot): void {
    this.mode = 'return';
    this.value = value;
  }

  applyTo(fn: Value, args: Slot[]): void {
    this.mode = 'apply';
    this.fn = fn;
    this.args = args;
  }

  ioResult(value: Slot): void {
    this.mode = 'ioDone';
    this.value = value;
  }
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null) return value.constructor.name;
  return typeof value;
}
