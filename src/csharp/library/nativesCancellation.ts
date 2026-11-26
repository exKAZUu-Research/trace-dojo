import { defineNatives, type NativeCall } from '../natives';
import { CsThrow, type Runtime } from '../runtime';
import { type CancellationExceptionState, taskObject, type TaskState, type Timer } from '../tasks';
import { type CsArray, CsBox, CsObject, CsStruct, type Value } from '../values';
import { exceptionConstructor } from './nativesCore';
import { evaluatorOf, fail, failOutOfRange, libraryType } from './support';

const SOURCE = 'System.Threading.CancellationTokenSource';
const TOKEN = 'System.Threading.CancellationToken';
const REGISTRATION = 'System.Threading.CancellationTokenRegistration';
const DISPOSED = 'The CancellationTokenSource has been disposed.';

/** The state of a CancellationTokenSource: whether it was canceled, and the callbacks its cancellation runs. */
class CancellationState {
  isCanceled = false;
  isDisposed = false;
  /** The timer of `CancelAfter`, which a later `CancelAfter`, `TryReset`, or `Dispose` replaces or stops. */
  timer: Timer | undefined;
  private readonly callbacks = new Map<number, () => void>();
  private nextId = 1;

  register(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  unregister(id: number): boolean {
    return this.callbacks.delete(id);
  }

  /** Marks the source canceled and takes its callbacks, which .NET runs in the reverse order of registration. */
  takeCallbacks(): (() => void)[] {
    this.isCanceled = true;
    const callbacks = [...this.callbacks.values()].toReversed();
    this.callbacks.clear();
    return callbacks;
  }
}

function stateOf(source: CsObject): CancellationState {
  return source.native as CancellationState;
}

/** The source of a CancellationToken, which keeps it in its one field; `default` and `None` have none. */
export function tokenSource(token: Value): CsObject | undefined {
  const value = token instanceof CsBox ? token.value : token;
  return (value as CsStruct).fields[0] as CsObject | undefined;
}

export function isCanceled(source: CsObject | undefined): boolean {
  return source !== undefined && stateOf(source).isCanceled;
}

export function tokenOf(call: NativeCall, source: CsObject | undefined): CsStruct {
  return new CsStruct(libraryType(call, TOKEN), [source]);
}

function newSource(call: NativeCall): CsObject {
  const source = new CsObject(libraryType(call, SOURCE), []);
  source.native = new CancellationState();
  return source;
}

/** The canceled source of `new CancellationToken(true)`, one per run, as .NET shares one for all such tokens. */
const canceledSources = new WeakMap<Runtime, CsObject>();

function canceledSource(call: NativeCall): CsObject {
  const runtime = call.frame.runtime;
  let source = canceledSources.get(runtime);
  if (!source) {
    source = newSource(call);
    stateOf(source).isCanceled = true;
    canceledSources.set(runtime, source);
  }
  return source;
}

/**
 * Runs a callback when a token's source is canceled: at once when it is, never for a token that cannot be canceled.
 * Returns the registration's id, or 0 when there is nothing to unregister.
 */
export function whenCanceled(source: CsObject | undefined, callback: () => void): number {
  if (!source) return 0;
  const state = stateOf(source);
  if (state.isCanceled) {
    callback();
    return 0;
  }
  return state.register(callback);
}

export function unregister(source: CsObject | undefined, id: number): void {
  if (source && id !== 0) stateOf(source).unregister(id);
}

/**
 * Cancels a source: its callbacks run on the canceling thread, all of them even when some throw, after which an
 * AggregateException carries their exceptions, as .NET's `Cancel()` does.
 */
function cancel(call: NativeCall, source: CsObject): void {
  const state = stateOf(source);
  if (state.isCanceled) return;
  stopTimer(call, state);
  const evaluator = evaluatorOf(call);
  const thrown: CsObject[] = [];
  for (const callback of state.takeCallbacks()) {
    try {
      callback();
    } catch (error) {
      const exception = evaluator.asThrow(error);
      if (!exception) throw error;
      thrown.push(exception.exception);
    }
  }
  if (thrown.length > 0) {
    const messages = thrown.map((exception) => ` (${evaluator.exceptionMessageOf(exception)})`).join('');
    const aggregate = call.frame.runtime.createException(
      'System.AggregateException',
      `One or more errors occurred.${messages}`,
      thrown[0]
    );
    (aggregate.native as { innerExceptions?: CsObject[] }).innerExceptions = thrown;
    throw new CsThrow(aggregate);
  }
}

function stopTimer(call: NativeCall, state: CancellationState): void {
  if (state.timer) call.frame.runtime.scheduler.cancelTimer(state.timer);
  state.timer = undefined;
}

function liveState(receiver: Value): CancellationState {
  const state = stateOf(receiver as CsObject);
  if (state.isDisposed) fail('System.ObjectDisposedException', DISPOSED);
  return state;
}

/** The milliseconds of a delay that .NET takes as a timeout: -1 for none, otherwise not negative. */
export function delayMilliseconds(call: NativeCall, span: Value, paramName: string): number {
  const ticks = ((span instanceof CsBox ? span.value : span) as CsStruct).fields[0] as bigint;
  const milliseconds = ticks / 10_000n;
  if (milliseconds < -1n || milliseconds > 4_294_967_294n)
    failOutOfRange(call, paramName, 'Specified argument was out of the range of valid values.');
  return Number(milliseconds);
}

function cancelAfter(call: NativeCall, receiver: Value, milliseconds: number, paramName: string): void {
  const state = liveState(receiver);
  if (milliseconds < -1) failOutOfRange(call, paramName, 'Specified argument was out of the range of valid values.');
  if (state.isCanceled) return;
  stopTimer(call, state);
  if (milliseconds === -1) return;
  const source = receiver as CsObject;
  state.timer = call.frame.runtime.scheduler.delay(milliseconds, () => {
    state.timer = undefined;
    cancel(call, source);
  });
}

/** A source canceled when any of the tokens' sources is, or at once when one already is. */
export function linkedSource(call: NativeCall, tokens: Value[]): CsObject {
  const linked = newSource(call);
  for (const token of tokens) {
    const source = tokenSource(token);
    whenCanceled(source, () => cancel(call, linked));
  }
  return linked;
}

function registration(call: NativeCall, receiver: Value, callback: () => void): CsStruct {
  const source = tokenSource(receiver);
  const id = whenCanceled(source, callback);
  return new CsStruct(libraryType(call, REGISTRATION), [id === 0 ? undefined : source, BigInt(id)]);
}

/** The exception that `ThrowIfCancellationRequested` throws, which names the token's source. */
export function canceledException(runtime: Runtime, source: CsObject | undefined): CsThrow {
  const exception = runtime.createException('System.OperationCanceledException', undefined);
  (exception.native as CancellationExceptionState).token = source;
  return new CsThrow(exception);
}

const hashCodes = new WeakMap<CsObject, number>();
let nextHashCode = 1;

defineNatives({
  [`${SOURCE}..ctor()`]: (_call, receiver) => {
    (receiver as CsObject).native = new CancellationState();
  },
  [`${SOURCE}..ctor(int)`]: (call, receiver, [milliseconds]) => {
    (receiver as CsObject).native = new CancellationState();
    cancelAfter(call, receiver, milliseconds as number, 'millisecondsDelay');
  },
  [`${SOURCE}..ctor(TimeSpan)`]: (call, receiver, [span]) => {
    (receiver as CsObject).native = new CancellationState();
    cancelAfter(call, receiver, delayMilliseconds(call, span as Value, 'delay'), 'delay');
  },
  [`${SOURCE}.get_IsCancellationRequested`]: (_call, receiver) => stateOf(receiver as CsObject).isCanceled,
  [`${SOURCE}.get_Token`]: (call, receiver) => {
    liveState(receiver);
    return tokenOf(call, receiver as CsObject);
  },
  [`${SOURCE}.Cancel`]: (call, receiver) => {
    liveState(receiver);
    cancel(call, receiver as CsObject);
  },
  [`${SOURCE}.CancelAsync`]: (call, receiver) => {
    liveState(receiver);
    cancel(call, receiver as CsObject);
    const task = call.frame.runtime.scheduler.newTask();
    task.complete(undefined);
    return taskObject(libraryType(call, 'System.Threading.Tasks.Task'), task);
  },
  [`${SOURCE}.CancelAfter(int)`]: (call, receiver, [milliseconds]) => {
    cancelAfter(call, receiver, milliseconds as number, 'millisecondsDelay');
  },
  [`${SOURCE}.CancelAfter(TimeSpan)`]: (call, receiver, [span]) => {
    cancelAfter(call, receiver, delayMilliseconds(call, span as Value, 'delay'), 'delay');
  },
  [`${SOURCE}.TryReset`]: (call, receiver) => {
    const state = liveState(receiver);
    if (state.isCanceled) return false;
    stopTimer(call, state);
    return true;
  },
  [`${SOURCE}.Dispose`]: (call, receiver) => {
    const state = stateOf(receiver as CsObject);
    stopTimer(call, state);
    state.isDisposed = true;
  },
  [`${SOURCE}.CreateLinkedTokenSource(CancellationToken)`]: (call, _receiver, [token]) =>
    linkedSource(call, [token as Value]),
  [`${SOURCE}.CreateLinkedTokenSource(CancellationToken, CancellationToken)`]: (call, _receiver, [first, second]) =>
    linkedSource(call, [first as Value, second as Value]),
  [`${SOURCE}.CreateLinkedTokenSource(CancellationToken[])`]: (call, _receiver, [tokens]) => {
    if (tokens === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'tokens');
    return linkedSource(call, (tokens as CsArray).values);
  },

  [`${TOKEN}..ctor(bool)`]: (call, receiver, [canceled]) => {
    (receiver as CsStruct).fields[0] = canceled ? canceledSource(call) : undefined;
  },
  [`${TOKEN}.get_None`]: (call) => tokenOf(call, undefined),
  [`${TOKEN}.get_IsCancellationRequested`]: (_call, receiver) => isCanceled(tokenSource(receiver)),
  [`${TOKEN}.get_CanBeCanceled`]: (_call, receiver) => tokenSource(receiver) !== undefined,
  [`${TOKEN}.ThrowIfCancellationRequested`]: (call, receiver) => {
    const source = tokenSource(receiver);
    if (isCanceled(source)) throw canceledException(call.frame.runtime, source);
  },
  [`${TOKEN}.Register(Action)`]: (call, receiver, [callback]) =>
    registerDelegate(call, receiver, callback as Value, []),
  [`${TOKEN}.Register(Action, bool)`]: (call, receiver, [callback]) =>
    registerDelegate(call, receiver, callback as Value, []),
  [`${TOKEN}.Register(Action<object?>, object?)`]: (call, receiver, [callback, state]) =>
    registerDelegate(call, receiver, callback as Value, [state as Value]),
  [`${TOKEN}.Equals(CancellationToken)`]: (_call, receiver, [other]) =>
    tokenSource(receiver) === tokenSource(other as Value),
  [`${TOKEN}.Equals(object?)`]: (call, receiver, [other]) =>
    isToken(call, other as Value) && tokenSource(receiver) === tokenSource(other as Value),
  [`${TOKEN}.GetHashCode`]: (_call, receiver) => {
    const source = tokenSource(receiver);
    if (!source) return 0;
    let code = hashCodes.get(source);
    if (code === undefined) {
      code = nextHashCode++;
      hashCodes.set(source, code);
    }
    return code;
  },
  [`${TOKEN}.op_Equality`]: (_call, _receiver, [left, right]) =>
    tokenSource(left as Value) === tokenSource(right as Value),
  [`${TOKEN}.op_Inequality`]: (_call, _receiver, [left, right]) =>
    tokenSource(left as Value) !== tokenSource(right as Value),

  [`${REGISTRATION}.get_Token`]: (call, receiver) => tokenOf(call, (receiver as CsStruct).fields[0] as CsObject),
  [`${REGISTRATION}.Dispose`]: (_call, receiver) => {
    unregisterRegistration(receiver);
  },
  [`${REGISTRATION}.Unregister`]: (_call, receiver) => unregisterRegistration(receiver),
  [`${REGISTRATION}.Equals(CancellationTokenRegistration)`]: (_call, receiver, [other]) =>
    sameRegistration(receiver, other as Value),
  [`${REGISTRATION}.Equals(object?)`]: (call, receiver, [other]) => {
    const value = other instanceof CsBox ? other.value : other;
    return (
      value instanceof CsStruct &&
      value.type.symbol === libraryType(call, REGISTRATION).symbol &&
      sameRegistration(receiver, value)
    );
  },
  [`${REGISTRATION}.GetHashCode`]: (_call, receiver) => Number((receiver as CsStruct).fields[1] as bigint),
});

function isToken(call: NativeCall, value: Value): boolean {
  const unboxed = value instanceof CsBox ? value.value : value;
  return unboxed instanceof CsStruct && unboxed.type.symbol === libraryType(call, TOKEN).symbol;
}

function sameRegistration(first: Value, second: Value): boolean {
  const [a, b] = [first as CsStruct, (second instanceof CsBox ? second.value : second) as CsStruct];
  return a.fields[0] === b.fields[0] && a.fields[1] === b.fields[1];
}

function unregisterRegistration(receiver: Value): boolean {
  const [source, id] = (receiver as CsStruct).fields as [CsObject | undefined, bigint];
  return source !== undefined && stateOf(source).unregister(Number(id));
}

function registerDelegate(call: NativeCall, receiver: Value, callback: Value, args: Value[]): CsStruct {
  if (callback === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'callback');
  const evaluator = evaluatorOf(call);
  const frame = call.frame;
  return registration(call, receiver, () => evaluator.invokeDelegate(frame, callback, args, undefined));
}

// ---- OperationCanceledException ----

defineNatives({
  'System.OperationCanceledException..ctor': (call, receiver, args) => {
    exceptionConstructor(call, receiver, args);
    const native = (receiver as CsObject).native as CancellationExceptionState;
    for (const [index, parameter] of call.method.parameters.entries()) {
      if (parameter.name === 'token') native.token = tokenSource(args[index] as Value);
      if (parameter.name === 'task' && args[index] !== undefined) {
        native.task = args[index] as CsObject;
        native.token = (native.task.native as TaskState).token;
      }
    }
  },
  'System.OperationCanceledException.get_CancellationToken': (call, receiver) =>
    tokenOf(call, ((receiver as CsObject).native as CancellationExceptionState).token),
  'System.Threading.Tasks.TaskCanceledException.get_Task': (_call, receiver) =>
    ((receiver as CsObject).native as CancellationExceptionState).task,
});
