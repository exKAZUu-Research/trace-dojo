// code-gauge-allow-file fileNcss -- Machine states and frames share one evaluator stack.
import { CONS_CON, NIL_CON } from './builtinTypes';
import type { CaseCore, Core, FunctionInfo } from './core';
import type { TypeHint } from './displayTypeHints';
import {
  bindDisplayTypes,
  constructorFieldHint,
  contextualDisplayHint,
  methodTypeHint,
  slotTypeHint,
  thunkTypeHint,
  typedSlot,
} from './displayTypes';
import type { ConInfo } from './entities';
import {
  type DoFrame,
  enterCallFrame,
  finishMatch,
  markTailSelfCall,
  prepareBlock,
  runBlock,
  statementDone,
  unwindBlock,
} from './ioBlocks';
import type { Primitive } from './primitives';
import { RecursionBudget } from './recursionBudget';
import type { Runtime, TraceFrame } from './runtime';
import {
  Closure,
  ConValue,
  type Dict,
  Env,
  HaskellException,
  IOBind,
  IOCall,
  IODo,
  IOPrim,
  IOReturn,
  IOThen,
  isIOAction,
  Partial,
  PrimFn,
  type Slot,
  Thunk,
  untypedSlot,
  type Value,
} from './values';

export type Frame =
  | {
      k: 'update';
      thunk: Thunk;
      code: Core | undefined;
      env: Env | undefined;
      native?: () => Slot | TailCall;
      target: Thunk | undefined;
    }
  | { k: 'apply'; args: Slot[]; displayType?: TypeHint }
  | {
      k: 'functionResult';
      info: FunctionInfo | undefined;
      invocation: Env;
      atomicScope: FunctionInfo | undefined;
      owners: WeakMap<Env | FunctionInfo, FunctionInfo>;
    }
  | { k: 'ioScope'; frame: TraceFrame }
  | { k: 'case'; core: CaseCore; env: Env; displayType: TypeHint | undefined }
  | { k: 'charCase'; core: Extract<Core, { k: 'charCase' }>; env: Env }
  | { k: 'method'; index: number }
  | { k: 'super'; index: number }
  | { k: 'deferredDo'; action: IODo; ordinary: Slot }
  | { k: 'prim'; prim: Primitive; args: Slot[]; position: number }
  | { k: 'runIO' }
  | { k: 'ioBind'; next: Slot }
  | { k: 'ioThen'; next: Slot }
  | DoFrame
  | { k: 'doMatch'; frame: DoFrame }
  | { k: 'base' };

const atomicInfos = new WeakMap<FunctionInfo, FunctionInfo>();

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

export function unpackString(text: string | readonly string[], index: number): Value {
  if (index >= text.length) return NIL();
  const char = typeof text === 'string' ? String.fromCodePoint(text.codePointAt(index) as number) : text[index];
  const next = index + (typeof text === 'string' ? char.length : 1);
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

export class TailCall {
  constructor(
    readonly fn: Value,
    readonly args: Slot[]
  ) {}
}

export class RunNext {
  constructor(readonly action: Slot) {}
}

export type PrimResult = Slot | TailCall;

/**
 * Evaluates Core with an explicit stack, so that deep recursion in a program does not exhaust the host's stack.
 * Evaluation may nest (a primitive forcing a value), each level running until the stack returns to its base.
 */
export class Machine {
  private readonly nativeCalls = new RecursionBudget(() => this.runtime.evaluationLimitError());
  readonly stack: Frame[] = [];

  constructor(readonly runtime: Runtime) {}

  force(slot: Slot): Value {
    slot = untypedSlot(slot);
    if (!(slot instanceof Thunk)) return slot;
    this.runtime.consumePreview(slot);
    if (slot.state === 'done') return slot.value as Value;
    return this.run({ mode: 'enter', slot }) as Value;
  }

  apply(fn: Value, args: Slot[]): Value {
    return this.run({ mode: 'apply', fn, args }) as Value;
  }

  runIO(action: Slot): void {
    this.run({ mode: 'runSlotIO', slot: action });
  }

  /** Runs an IO action to its end inside a primitive, as `catch` and `runST` do, giving its result. */
  runIOValue(action: Slot): Slot {
    return this.run({ mode: 'runSlotIO', slot: action });
  }

  makeSlot(code: Core, env: Env | undefined): Slot {
    return typedSlot(
      this.makeUntypedSlot(code, env),
      this.runtime.steps.recorder ? contextualDisplayHint(code.displayType, env) : code.displayType
    );
  }

  private makeUntypedSlot(code: Core, env: Env | undefined): Slot {
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
        const slots = code.args.map((arg) => this.makeLetSlot(arg, env));
        if (code.con.context?.length) {
          return new ConValue(code.con, slots.slice(0, code.con.arity), slots.slice(code.con.arity));
        }
        return new ConValue(code.con, slots);
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
  makeLetSlot(code: Core, env: Env | undefined): Slot {
    if (code.k === 'lit' || code.k === 'lam' || code.k === 'global' || code.k === 'prim' || code.k === 'iodo') {
      return this.makeSlot(code, env);
    }
    return typedSlot(
      new Thunk(code, env),
      this.runtime.steps.recorder ? contextualDisplayHint(code.displayType, env) : code.displayType
    );
  }

  private run(start: RunStart): Slot {
    return this.nativeCalls.run(() => this.runCore(start));
  }

  // code-gauge-allow functionNcss -- The main loop dispatches on the machine mode and handles limits and exceptions in one place.
  private runCore(start: RunStart): Slot {
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

  // code-gauge-allow functionNcss -- One short case per kind of code node.
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
        state.returnValue(code.k === 'str' ? unpackString(code.value, 0) : untypedSlot(this.makeSlot(code, env)));
        return;
      }
      case 'app': {
        this.runtime.allocate(code.args.length);
        this.stack.push({ k: 'apply', args: code.args.map((arg) => this.makeSlot(arg, env)) });
        state.code = code.fn;
        return;
      }
      case 'frame': {
        this.runtime.allocate(code.size);
        state.env = new Env(code.size, env, code.info);
        if (code.functionResult || code.atomicScope) this.pushFunctionResult(code.info, state.env, code.atomicScope);
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
            ? { k: 'case', core: code, env: env as Env, displayType: this.scrutineeDisplayType(code.scrut, env) }
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
      case 'deferredDo': {
        this.beginDeferredDo(state, code, env);
        return;
      }
      case 'dict': {
        this.runtime.allocate(code.args.length);
        state.returnValue(
          this.runtime.makeDict(
            code.instance,
            code.args.map((arg) => this.makeSlot(arg, env))
          )
        );
        return;
      }
      case 'error': {
        throw new HaskellException(
          code.message,
          /Non-exhaustive (patterns|guards)/.test(code.message) ? { kind: 'pattern' } : undefined
        );
      }
    }
  }

  private beginDeferredDo(state: RunState, code: Extract<Core, { k: 'deferredDo' }>, env: Env | undefined): void {
    const action = new IODo(code.io, env as Env);
    if (this.consumerRunsIO()) {
      state.returnValue(action);
      return;
    }
    const ordinary = code.ordinary
      ? this.makeSlot(code.ordinary, env)
      : prepareBlock(this, action).actions.values().next().value;
    if (ordinary === undefined) throw new Error('A deferred IO block requires an action');
    this.stack.push({ k: 'deferredDo', action, ordinary });
    state.enter(ordinary);
  }

  private consumerRunsIO(): boolean {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const frame = this.stack[index];
      if (frame.k === 'functionResult') continue;
      this.runtime.spend();
      if (frame.k !== 'update') return frame.k === 'runIO';
    }
    return false;
  }

  // code-gauge-allow functionNcss -- Keep thunk entry, its rollback frame and preview accounting in one transition.
  private stepEnter(state: RunState): void {
    const entered = state.value;
    const slot = untypedSlot(entered);
    if (slot instanceof Thunk) this.runtime.consumePreview(slot);
    state.value = slot;
    if (slot instanceof Thunk && slot.state === 'evaluating') throw this.runtime.evaluationLimitError();
    this.inheritTypeHint(entered);
    if (!(slot instanceof Thunk)) {
      state.mode = 'return';
      return;
    }
    if (slot.state === 'done') {
      state.returnValue(slot.value as Value);
      return;
    }
    this.squeezeUpdateFrame(slot);
    slot.state = 'evaluating';
    this.stack.push({
      k: 'update',
      thunk: slot,
      code: slot.code,
      env: slot.env,
      native: slot.native,
      target: slot.target,
    });
    this.runtime.beginPreview(slot);
    if (slot.target) {
      state.enter(slot.target);
      return;
    }
    this.runtime.spend();
    if (!slot.native) {
      state.evaluate(slot.code as Core, slot.env);
      return;
    }
    const result = slot.native();
    if (result instanceof TailCall) state.applyTo(result.fn, result.args);
    else state.enter(result);
  }

  /**
   * Drops the update frame on top of the stack, if any, when an expression is entered: the thunk it updates takes the entered
   * thunk's value, as GHC's stack squeezing does. Without it, a loop whose each step ends by entering the next step's
   * thunk (such as `seq n (go (n + 1))`) keeps a frame per step. Indirection updates remain
   * to memoize resolved aliases.
   */
  private squeezeUpdateFrame(entered: Thunk): void {
    const top = this.stack.at(-1);
    if (top?.k !== 'update') return;
    if (entered.target) return;
    top.thunk.redirect(entered);
    this.stack.pop();
    this.runtime.endPreview(top.thunk);
  }

  // code-gauge-allow functionNcss -- Application dispatch keeps partial, primitive and closure entry on the same stack.
  private stepApply(state: RunState): void {
    let { fn, args } = state;
    if (fn instanceof Partial) {
      this.runtime.allocate(fn.args.length + args.length);
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
      this.runtime.allocate(args.length);
      this.stack.push({ k: 'apply', args: args.slice(arity) });
      args = args.slice(0, arity);
    }
    const info = fn instanceof Closure ? fn.lam.info : fn.info;
    const atomicScope = fn.atomicScope ?? (info?.isAtomic ? info : undefined);
    if (fn instanceof PrimFn) {
      if (atomicScope) this.pushFunctionResult(fn.info, new Env(0, undefined, fn.info), atomicScope);
      this.runtime.allocate(args.length);
      this.stack.push({ k: 'prim', prim: fn.prim, args: [...args], position: 0 });
      state.mode = 'primNext';
      return;
    }
    // A call counts as an operation, as does a primitive's (in `stepPrim`), which may charge more for its own work.
    this.runtime.spend();
    this.runtime.allocate(fn.lam.size);
    if (!fn.atomicScope || this.inAtomicScope()) markTailSelfCall(this, fn.lam.info);
    const frameEnv = new Env(fn.lam.size, fn.env, fn.lam.info);
    for (let index = 0; index < arity; index++) frameEnv.slots[index] = args[index];
    bindDisplayTypes(frameEnv, fn.lam.displayConstraints ?? [], fn.lam.displayParameters ?? [], args, this.runtime);
    if (fn.lam.functionResult || atomicScope) this.pushFunctionResult(fn.lam.info, frameEnv, atomicScope);
    state.evaluate(fn.lam.body, frameEnv);
  }

  private stepPrim(state: RunState): void {
    const frame = this.stack.at(-1) as Extract<Frame, { k: 'prim' }>;
    const strict = frame.prim.strict;
    while (frame.position < frame.args.length) {
      const arg = untypedSlot(frame.args[frame.position]);
      const isStrict = strict === 'all' || strict.includes(frame.position);
      if (isStrict) frame.args[frame.position] = arg;
      if (isStrict && arg instanceof Thunk) {
        this.runtime.consumePreview(arg);
        if (arg.state !== 'done') {
          state.enter(arg);
          return;
        }
        frame.args[frame.position] = arg.value as Value;
      }
      frame.position++;
    }
    this.stack.pop();
    this.runtime.spend();
    const result = frame.prim.fn(frame.args, this.runtime);
    if (result instanceof TailCall) state.applyTo(result.fn, result.args);
    else state.enter(result);
  }

  // code-gauge-allow functionNcss -- One short case per kind of frame a value returns to.
  private stepReturn(state: RunState): boolean {
    const frame = this.stack.pop() as Frame;
    switch (frame.k) {
      case 'base': {
        return true;
      }
      case 'functionResult': {
        state.returnValue(this.nameFunctionResult(state.value, frame));
        return false;
      }
      case 'update': {
        frame.thunk.update(state.value as Value);
        this.runtime.endPreview(frame.thunk);
        return false;
      }
      case 'apply': {
        if (frame.displayType)
          this.inheritTypeHint(
            typedSlot(state.value as Value, {
              tag: 'applicationType',
              parent: frame.displayType,
              arguments: frame.args.length,
            })
          );
        state.applyTo(state.value as Value, frame.args);
        return false;
      }
      case 'case': {
        this.selectAlternative(state, frame.core, frame.env, frame.displayType);
        return false;
      }
      case 'charCase': {
        state.evaluate(state.value === frame.core.value ? frame.core.matched : frame.core.unmatched, frame.env);
        return false;
      }
      case 'method':
      case 'super': {
        const dict = state.value as Dict;
        state.enter(
          frame.k === 'method' && this.runtime.steps.recorder
            ? typedSlot(dict.methods[frame.index], methodTypeHint(dict, frame.index, this.runtime))
            : frame.k === 'method'
              ? dict.methods[frame.index]
              : dict.supers[frame.index]
        );
        return false;
      }
      case 'deferredDo': {
        this.inheritTypeHint(frame.ordinary);
        if (isIOAction(state.value)) state.returnValue(frame.action);
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

  private pushFunctionResult(
    info: FunctionInfo | undefined,
    invocation: Env,
    atomicScope = info?.isAtomic ? info : undefined
  ): void {
    if (!info && !atomicScope) return;
    const top = this.stack.at(-1);
    const frame =
      top?.k === 'functionResult'
        ? top
        : {
            k: 'functionResult' as const,
            info,
            invocation,
            atomicScope,
            owners: new WeakMap<Env | FunctionInfo, FunctionInfo>(),
          };
    frame.info = info ?? frame.info;
    frame.invocation = invocation;
    frame.atomicScope ??= atomicScope;
    if (info) {
      frame.owners.set(invocation, info);
      if (info.patternOwner) frame.owners.set(info.patternOwner, info);
    }
    if (frame !== top) this.stack.push(frame);
  }

  private nameFunctionResult(value: Slot, frame: Extract<Frame, { k: 'functionResult' }>): Slot {
    if (value instanceof Closure || value instanceof PrimFn) return this.namedCallable(value, frame);
    if (value instanceof Partial) {
      const fn = this.namedCallable(value.fn, frame);
      return fn === value.fn ? value : new Partial(fn, value.args);
    }
    if (frame.atomicScope && isIOAction(value)) {
      const scope = frame.invocation.info?.isAtomic
        ? frame.invocation
        : new Env(0, frame.invocation, this.atomicInfo(frame.atomicScope));
      return new IOCall(value, scope);
    }
    return value;
  }

  private namedCallable(value: Closure | PrimFn, frame: Extract<Frame, { k: 'functionResult' }>): Closure | PrimFn {
    const original = value instanceof Closure ? value.lam.info : value.info;
    const owner = value instanceof Closure ? value.env?.invocation() : undefined;
    const source =
      original ?? (owner ? (frame.owners.get(owner) ?? (owner.info && frame.owners.get(owner.info))) : frame.info);
    const scope = value.atomicScope ?? frame.atomicScope;
    if (source === original && scope === value.atomicScope) return value;
    return value instanceof Closure
      ? new Closure({ ...value.lam, info: source }, value.env, scope)
      : new PrimFn(value.prim, source, scope);
  }

  private atomicInfo(source: FunctionInfo): FunctionInfo {
    if (source.isAtomic) return source;
    let atomic = atomicInfos.get(source);
    if (!atomic) {
      atomic = { ...source, isAtomic: true };
      atomicInfos.set(source, atomic);
    }
    return atomic;
  }

  private inheritTypeHint(slot: Slot): void {
    let index = this.stack.length - 1;
    while (this.stack[index]?.k === 'functionResult') index--;
    const top = this.stack[index];
    if (!this.runtime.steps.recorder) return;
    if (top?.k === 'apply') {
      top.displayType = slotTypeHint(slot, top.displayType);
      return;
    }
    if (top?.k !== 'update') return;
    const hint = thunkTypeHint(top.thunk);
    hint.value = slotTypeHint(slot, hint.value);
  }

  private scrutineeDisplayType(code: Core, env: Env | undefined): TypeHint | undefined {
    if (!this.runtime.steps.recorder) return;
    return code.k === 'local'
      ? slotTypeHint((env as Env).at(code.depth).slots[code.index] as Slot, code.displayType)
      : code.displayType;
  }

  private selectAlternative(state: RunState, core: CaseCore, env: Env, type: TypeHint | undefined): void {
    const scrutinee = state.value as ConValue;
    if (core.bindIndex !== undefined) env.slots[core.bindIndex] = typedSlot(scrutinee, type);
    // A case without alternatives only evaluates its scrutinee, which may be of any type, as `!x` does.
    if (core.alts.size === 0 && core.default) {
      state.evaluate(core.default, env);
      return;
    }
    const alt = core.alts.get(scrutinee.con.tag);
    if (alt) {
      const { slots, dictSlots } = alt;
      if (dictSlots) for (const [index, slot] of dictSlots.entries()) env.slots[slot] = scrutinee.dicts![index];
      for (let index = 0; index < slots.length; index++) {
        if (slots[index] >= 0)
          env.slots[slots[index]] = typedSlot(
            scrutinee.fields[index],
            type ? constructorFieldHint(scrutinee.con, type, index) : undefined
          );
      }
      state.evaluate(alt.body, env);
      return;
    }
    if (!core.default) throw new Error(`No alternative for ${scrutinee.con.name}`);
    state.evaluate(core.default, env);
  }

  // code-gauge-allow functionCognitiveComplexity -- One branch dispatches each IO representation and its call scope.
  private stepIO(state: RunState): void {
    const action = state.value as Value;
    if (action instanceof IOCall) {
      if (!this.inAtomicScope()) {
        const scope = enterCallFrame(this, action.invocation);
        if (scope.pushed) this.stack.push({ k: 'ioScope', frame: scope.traceFrame });
      }
      this.stack.push({ k: 'runIO' });
      state.enter(action.action);
      return;
    }
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

  private stepIODone(state: RunState): boolean {
    const frame = this.stack.pop() as Frame;
    switch (frame.k) {
      case 'base': {
        return true;
      }
      case 'ioScope': {
        this.runtime.popFrame(frame.frame);
        return false;
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

  private inAtomicScope(): boolean {
    return this.runtime.frames.some((frame) => frame.isAtomic);
  }

  private unwind(base: number): void {
    const { stack } = this;
    while (stack.length > base) {
      const frame = stack.pop() as Frame;
      if (frame.k === 'update') {
        frame.thunk.state = 'pending';
        frame.thunk.code = frame.code;
        frame.thunk.env = frame.env;
        frame.thunk.native = frame.native;
        frame.thunk.target = frame.target;
        this.runtime.endPreview(frame.thunk, true);
      } else if (frame.k === 'do') {
        unwindBlock(this, frame);
      } else if (frame.k === 'ioScope' && this.runtime.frames[0] !== frame.frame) {
        this.runtime.popFrame(frame.frame);
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
