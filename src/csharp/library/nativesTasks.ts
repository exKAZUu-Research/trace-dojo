import type { Evaluator } from '../evaluator';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { exceptionMessage } from '../objects';
import { CsThrow, type ExceptionState, type Runtime } from '../runtime';
import {
  awaitedFailure,
  blockingFailures,
  cancellationTokenOf,
  isCancellationException,
  TASK_STATUS,
  taskObject,
  type TaskState,
} from '../tasks';
import type { NamedType, Type } from '../types';
import { CsBox, CsObject, CsStruct, isString, stringText, type Value } from '../values';
import { iterate } from './iteration';
import { isCanceled, tokenSource, unregister, whenCanceled } from './nativesCancellation';
import { ListState } from './nativesCollections';
import { evaluatorOf, fail, failOutOfRange, libraryType, newArray, typeArgument } from './support';

const TASK = 'System.Threading.Tasks.Task';
const TASK_OF = 'System.Threading.Tasks.Task`1';
const STATUS = { completed: TASK_STATUS.ranToCompletion, faulted: TASK_STATUS.faulted, canceled: TASK_STATUS.canceled };
const ALREADY_COMPLETED = 'An attempt was made to transition a task to a final state when it had already completed.';

function stateOf(task: Value): TaskState {
  return ((task instanceof CsBox ? task.value : task) as CsObject).native as TaskState;
}

/** The task inside a task's awaiter, a `ValueTask`, or a configured awaitable, which keep it in their one field. */
function innerTask(value: Value): TaskState {
  return stateOf((value as CsStruct).fields[0]);
}

function newTask(call: NativeCall, resultType?: Type): { state: TaskState; object: CsObject } {
  const state = call.frame.runtime.scheduler.newTask();
  const type = resultType ? libraryType(call, TASK, [resultType]) : libraryType(call, TASK);
  return { state, object: taskObject(type, state) };
}

function completedTask(call: NativeCall, result: Value, resultType?: Type): CsObject {
  const { state, object } = newTask(call, resultType);
  state.complete(result);
  return object;
}

/** A blocking wait, as `Wait()` and `Result` make: the other work runs until the task is done. */
function waitFor(call: NativeCall, state: TaskState): void {
  evaluatorOf(call).waitFor(state);
}

/**
 * What `Wait()` and `Result` throw for a task that did not complete: an AggregateException of a faulted task's
 * exceptions, or of a new TaskCanceledException for a canceled one.
 */
function throwIfFailed(call: NativeCall, state: TaskState): void {
  if (state.status !== 'faulted' && state.status !== 'canceled') return;
  throw new CsThrow(
    aggregateOf(
      call.frame.runtime,
      blockingFailures(call.frame.runtime, state).map((thrown) => thrown.exception)
    )
  );
}

/** An AggregateException of exceptions, whose message lists theirs, as .NET's does. */
function aggregateOf(runtime: Runtime, inner: CsObject[]): CsObject {
  const messages = inner.map((exception) => ` (${exceptionMessage(exception)})`).join('');
  const exception = runtime.createException(
    'System.AggregateException',
    `One or more errors occurred.${messages}`,
    inner[0]
  );
  (exception.native as AggregateState).innerExceptions = inner;
  return exception;
}

interface AggregateState extends ExceptionState {
  innerExceptions?: CsObject[];
}

/** `GetResult()` of an awaiter: the result of its task, waiting for it, or its first exception. */
function getResult(call: NativeCall, state: TaskState): Value {
  if (!state.isDone) waitFor(call, state);
  const failure = awaitedFailure(call.frame.runtime, state);
  if (failure) throw failure;
  return state.result;
}

function taskStates(call: NativeCall, tasks: Value): TaskState[] {
  if (tasks === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'tasks');
  const states = [...iterate(call, tasks, 'tasks')].map((task) => {
    if (task === undefined) fail('System.ArgumentException', 'The tasks argument included a null value.', 'tasks');
    return stateOf(task);
  });
  return states;
}

/** `Task.WhenAll`: done when every task is, faulted with their exceptions if any faulted, else canceled if any was. */
function whenAll(call: NativeCall, tasks: Value, resultType: Type | undefined): CsObject {
  const states = taskStates(call, tasks);
  const { state, object } = newTask(call, resultType ? { kind: 'array', element: resultType, rank: 1 } : undefined);
  let remaining = states.length;
  // .NET 10 gathers the exceptions in the order the tasks faulted.
  const faulted: CsThrow[] = [];
  const settle = (): void => {
    if (faulted.length > 0) state.fault(faulted);
    else if (states.some((task) => task.status === 'canceled')) state.cancel(undefined);
    else
      state.complete(
        resultType
          ? newArray(
              call,
              resultType,
              states.map((task) => task.result)
            )
          : undefined
      );
  };
  if (remaining === 0) settle();
  for (const task of states)
    task.whenDone(() => {
      faulted.push(...task.exceptions);
      remaining--;
      if (remaining === 0) settle();
    });
  return object;
}

/** `Task.WhenAny`: done with the first task that is done, in the order the tasks were given. */
function whenAny(call: NativeCall, tasks: Value, resultType: Type): CsObject {
  const states = taskStates(call, tasks);
  if (states.length === 0) fail('System.ArgumentException', 'The tasks argument contains no tasks.', 'tasks');
  const { state, object } = newTask(call, resultType);
  for (const task of states) task.whenDone(() => state.complete(task.object));
  return object;
}

/**
 * Runs a task's work, which settles the task with its result, the task it returns when it unwraps one, its exception,
 * or its cancellation: an OperationCanceledException of the task's own canceled token cancels it, as does any one
 * when it unwraps a task, as .NET's `Task.Run` of an async function does.
 */
function runWork(evaluator: Evaluator, state: TaskState, invoke: () => Value, unwraps: boolean): void {
  if (state.isDone) return;
  state.pendingStatus = TASK_STATUS.running;
  let result: Value;
  try {
    result = invoke();
  } catch (error) {
    const thrown = evaluator.asThrow(error);
    if (!thrown) throw error;
    const exception = thrown.exception;
    const token = cancellationTokenOf(exception);
    if (isCancellationException(exception) && (unwraps || (isCanceled(state.token) && token === state.token)))
      state.cancel(token, thrown);
    else state.fault([thrown]);
    return;
  }
  if (!unwraps) state.complete(result);
  // An unwrapping task whose function returns no task is canceled, as .NET's proxy for a null task is.
  else if (result === undefined) state.cancel(undefined);
  else {
    const inner = stateOf(result);
    inner.whenDone(() => state.settleAs(inner));
  }
}

/**
 * Queues a task's work, as `Task.Run` and `StartNew` do: canceling its token before the work starts cancels the task,
 * and a token canceled already cancels it at once.
 */
function queueWork(call: NativeCall, state: TaskState, token: Value, invoke: () => Value, unwraps: boolean): void {
  const evaluator = evaluatorOf(call);
  const source = token === undefined ? undefined : tokenSource(token);
  state.token = source;
  state.pendingStatus = TASK_STATUS.waitingToRun;
  const id = whenCanceled(source, () => state.cancel(source));
  if (state.isDone) return;
  call.frame.runtime.scheduler.queue(() => {
    unregister(source, id);
    runWork(evaluator, state, invoke, unwraps);
  });
}

/** `Task.Run`: queues the function, whose task completes with its result, or with the task it returns. */
function run(call: NativeCall, work: Value, resultType: Type | undefined, unwraps: boolean, token?: Value): CsObject {
  if (work === undefined)
    fail('System.ArgumentNullException', 'Value cannot be null.', unwraps ? 'function' : 'action');
  const { state, object } = newTask(call, resultType);
  const evaluator = evaluatorOf(call);
  const frame = call.frame;
  queueWork(call, state, token, () => evaluator.invokeDelegate(frame, work, [], undefined), unwraps);
  return object;
}

/** `Task.Delay`: a task that a timer completes, which canceling its token cancels instead. */
function delay(call: NativeCall, milliseconds: number, paramName: string, token?: Value): CsObject {
  if (milliseconds < -1)
    failOutOfRange(
      call,
      paramName,
      'The value needs to be either -1 (signifying an infinite timeout), 0 or a positive integer.'
    );
  const { state, object } = newTask(call);
  const source = token === undefined ? undefined : tokenSource(token);
  const scheduler = call.frame.runtime.scheduler;
  if (isCanceled(source)) state.cancel(source);
  else if (milliseconds === 0) state.complete(undefined);
  else {
    let id = 0;
    const timer =
      milliseconds > 0
        ? scheduler.delay(milliseconds, () => {
            unregister(source, id);
            state.complete(undefined);
          })
        : undefined;
    id = whenCanceled(source, () => {
      if (timer) scheduler.cancelTimer(timer);
      // The task is canceled at once, but its continuations run later, after the code that canceled it.
      state.runContinuation = (run) => scheduler.queue(run);
      state.cancel(source);
    });
  }
  return object;
}

function timeSpanMilliseconds(span: Value): number {
  return Number(((span as CsStruct).fields[0] as bigint) / 10_000n);
}

function exceptionThrow(exception: Value): CsThrow {
  if (exception === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'exception');
  return new CsThrow(exception as CsObject);
}

/** The awaiter natives of a type whose one field holds its task. */
function awaiterNatives(prefix: string): Record<string, NativeMethod> {
  return {
    [`${prefix}.get_IsCompleted`]: (_call, receiver) => innerTask(receiver).isDone,
    [`${prefix}.GetResult`]: (call, receiver) => getResult(call, innerTask(receiver)),
    [`${prefix}.OnCompleted`]: onCompleted,
    [`${prefix}.UnsafeOnCompleted`]: onCompleted,
  };
}

const onCompleted: NativeMethod = (call, receiver, [continuation]) => {
  if (continuation === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'continuation');
  const evaluator = evaluatorOf(call);
  innerTask(receiver).whenDone(() => evaluator.invokeDelegate(call.frame, continuation as Value, [], undefined));
};

function wrapping(call: NativeCall, fullName: string, receiver: Value, args: Type[] = []): CsStruct {
  return new CsStruct(libraryType(call, fullName, args), [receiver]);
}

function resultTypeOf(receiver: Value): Type {
  return ((receiver as CsObject).type as NamedType).args[0];
}

function taskStatus(state: TaskState): number {
  return state.status === 'pending' ? state.pendingStatus : STATUS[state.status];
}

defineNatives({
  [`${TASK}.get_CompletedTask`]: (call) => completedTask(call, undefined),
  [`${TASK}.get_Status`]: (_call, receiver) => taskStatus(stateOf(receiver)),
  [`${TASK}.get_IsCompleted`]: (_call, receiver) => stateOf(receiver).isDone,
  [`${TASK}.get_IsCompletedSuccessfully`]: (_call, receiver) => stateOf(receiver).status === 'completed',
  [`${TASK}.get_IsFaulted`]: (_call, receiver) => stateOf(receiver).status === 'faulted',
  [`${TASK}.get_IsCanceled`]: (_call, receiver) => stateOf(receiver).status === 'canceled',
  [`${TASK}.get_Exception`]: (call, receiver) => {
    const state = stateOf(receiver);
    return state.status === 'faulted'
      ? aggregateOf(
          call.frame.runtime,
          state.exceptions.map((thrown) => thrown.exception)
        )
      : undefined;
  },
  [`${TASK}.get_Id`]: (_call, receiver) => stateOf(receiver).id,
  [`${TASK}.get_CurrentId`]: () => {},
  [`${TASK}.GetAwaiter`]: (call, receiver) => wrapping(call, 'System.Runtime.CompilerServices.TaskAwaiter', receiver),
  [`${TASK}.ConfigureAwait`]: (call, receiver) =>
    wrapping(call, 'System.Runtime.CompilerServices.ConfiguredTaskAwaitable', receiver),
  [`${TASK}.Wait()`]: (call, receiver) => {
    const state = stateOf(receiver);
    waitFor(call, state);
    throwIfFailed(call, state);
  },
  [`${TASK}.Wait(int)`]: (call, receiver, [timeout]) => waitWithTimeout(call, stateOf(receiver), timeout as number),
  [`${TASK}.Wait(TimeSpan)`]: (call, receiver, [timeout]) =>
    waitWithTimeout(call, stateOf(receiver), timeSpanMilliseconds(timeout as Value)),
  [`${TASK}.Dispose`]: () => {},
  [`${TASK}.Delay(int)`]: (call, _receiver, [milliseconds]) => delay(call, milliseconds as number, 'millisecondsDelay'),
  [`${TASK}.Delay(TimeSpan)`]: (call, _receiver, [span]) => delay(call, timeSpanMilliseconds(span as Value), 'delay'),
  [`${TASK}.Delay(int, CancellationToken)`]: (call, _receiver, [milliseconds, token]) =>
    delay(call, milliseconds as number, 'millisecondsDelay', token as Value),
  [`${TASK}.Delay(TimeSpan, CancellationToken)`]: (call, _receiver, [span, token]) =>
    delay(call, timeSpanMilliseconds(span as Value), 'delay', token as Value),
  [`${TASK}.Run(Action)`]: (call, _receiver, [action]) => run(call, action as Value, undefined, false),
  [`${TASK}.Run(Action, CancellationToken)`]: (call, _receiver, [action, token]) =>
    run(call, action as Value, undefined, false, token as Value),
  [`${TASK}.Run(Func<TResult>)`]: (call, _receiver, [work]) => run(call, work as Value, typeArgument(call), false),
  [`${TASK}.Run(Func<TResult>, CancellationToken)`]: (call, _receiver, [work, token]) =>
    run(call, work as Value, typeArgument(call), false, token as Value),
  [`${TASK}.Run(Func<Task?>)`]: (call, _receiver, [work]) => run(call, work as Value, undefined, true),
  [`${TASK}.Run(Func<Task?>, CancellationToken)`]: (call, _receiver, [work, token]) =>
    run(call, work as Value, undefined, true, token as Value),
  [`${TASK}.Run(Func<Task<TResult>?>)`]: (call, _receiver, [work]) =>
    run(call, work as Value, typeArgument(call), true),
  [`${TASK}.Run(Func<Task<TResult>?>, CancellationToken)`]: (call, _receiver, [work, token]) =>
    run(call, work as Value, typeArgument(call), true, token as Value),
  [`${TASK}.FromCanceled`]: (call, _receiver, [token]) => {
    const source = tokenSource(token as Value);
    if (!isCanceled(source))
      failOutOfRange(call, 'cancellationToken', 'Specified argument was out of the range of valid values.');
    const { state, object } = newTask(call, call.typeArgs[0]);
    state.cancel(source);
    return object;
  },
  [`${TASK}.FromResult`]: (call, _receiver, [result]) => completedTask(call, result as Value, typeArgument(call)),
  [`${TASK}.FromException(Exception)`]: (call, _receiver, [exception]) => {
    const { state, object } = newTask(call, call.typeArgs[0]);
    state.fault([exceptionThrow(exception as Value)]);
    return object;
  },
  [`${TASK}.WhenAll(Task[])`]: (call, _receiver, [tasks]) => whenAll(call, tasks as Value, undefined),
  [`${TASK}.WhenAll(IEnumerable<Task>)`]: (call, _receiver, [tasks]) => whenAll(call, tasks as Value, undefined),
  [`${TASK}.WhenAll(Task<TResult>[])`]: (call, _receiver, [tasks]) => whenAll(call, tasks as Value, typeArgument(call)),
  [`${TASK}.WhenAll(IEnumerable<Task<TResult>>)`]: (call, _receiver, [tasks]) =>
    whenAll(call, tasks as Value, typeArgument(call)),
  [`${TASK}.WhenAny(Task[])`]: (call, _receiver, [tasks]) => whenAny(call, tasks as Value, libraryType(call, TASK)),
  [`${TASK}.WhenAny(IEnumerable<Task>)`]: (call, _receiver, [tasks]) =>
    whenAny(call, tasks as Value, libraryType(call, TASK)),
  [`${TASK}.WhenAny(Task<TResult>[])`]: (call, _receiver, [tasks]) =>
    whenAny(call, tasks as Value, libraryType(call, TASK, [typeArgument(call)])),
  [`${TASK}.WhenAny(IEnumerable<Task<TResult>>)`]: (call, _receiver, [tasks]) =>
    whenAny(call, tasks as Value, libraryType(call, TASK, [typeArgument(call)])),
  [`${TASK}.WaitAll`]: (call, _receiver, [tasks]) => {
    const states = taskStates(call, tasks as Value);
    call.frame.runtime.scheduler.runUntil(() => states.every((state) => state.isDone));
    const exceptions = states.flatMap((state) => blockingFailures(call.frame.runtime, state));
    if (exceptions.length > 0)
      throw new CsThrow(
        aggregateOf(
          call.frame.runtime,
          exceptions.map((thrown) => thrown.exception)
        )
      );
  },
  [`${TASK}.WaitAny`]: (call, _receiver, [tasks]) => {
    const states = taskStates(call, tasks as Value);
    call.frame.runtime.scheduler.runUntil(() => states.some((state) => state.isDone));
    return states.findIndex((state) => state.isDone);
  },
  [`${TASK}.Yield`]: (call) => new CsStruct(libraryType(call, 'System.Runtime.CompilerServices.YieldAwaitable'), []),
  [`${TASK_OF}.get_Result`]: (call, receiver) => {
    const state = stateOf(receiver);
    waitFor(call, state);
    throwIfFailed(call, state);
    return state.result;
  },
  [`${TASK_OF}.GetAwaiter`]: (call, receiver) =>
    wrapping(call, 'System.Runtime.CompilerServices.TaskAwaiter', receiver, [resultTypeOf(receiver)]),
  [`${TASK_OF}.ConfigureAwait`]: (call, receiver) =>
    wrapping(call, 'System.Runtime.CompilerServices.ConfiguredTaskAwaitable', receiver, [resultTypeOf(receiver)]),
});

function waitWithTimeout(call: NativeCall, state: TaskState, milliseconds: number): boolean {
  if (milliseconds < -1)
    failOutOfRange(
      call,
      'millisecondsTimeout',
      'The value needs to be either -1 (signifying an infinite timeout), 0 or a positive integer.'
    );
  if (!state.isDone && milliseconds !== 0) {
    let expired = false;
    if (milliseconds > 0) call.frame.runtime.scheduler.delay(milliseconds, () => (expired = true));
    call.frame.runtime.scheduler.runUntil(() => state.isDone || expired);
  }
  throwIfFailed(call, state);
  return state.isDone;
}

// ---- TaskCompletionSource ----

for (const prefix of ['System.Threading.Tasks.TaskCompletionSource', 'System.Threading.Tasks.TaskCompletionSource`1']) {
  const isGeneric = prefix.endsWith('`1');
  defineNatives({
    [`${prefix}..ctor`]: (call, receiver) => {
      const resultType = isGeneric ? ((receiver as CsObject).type as NamedType).args[0] : undefined;
      (receiver as CsObject).native = newTask(call, resultType).object;
    },
    [`${prefix}.get_Task`]: (_call, receiver) => (receiver as CsObject).native as CsObject,
    [`${prefix}.SetResult`]: (_call, receiver, [result]) => {
      if (!stateOf((receiver as CsObject).native as CsObject).complete(result as Value))
        fail('System.InvalidOperationException', ALREADY_COMPLETED);
    },
    [`${prefix}.TrySetResult`]: (_call, receiver, [result]) =>
      stateOf((receiver as CsObject).native as CsObject).complete(result as Value),
    [`${prefix}.SetException`]: (_call, receiver, [exception]) => {
      if (!stateOf((receiver as CsObject).native as CsObject).fault([exceptionThrow(exception as Value)]))
        fail('System.InvalidOperationException', ALREADY_COMPLETED);
    },
    [`${prefix}.TrySetException`]: (_call, receiver, [exception]) =>
      stateOf((receiver as CsObject).native as CsObject).fault([exceptionThrow(exception as Value)]),
    [`${prefix}.SetCanceled`]: (_call, receiver, [token]) => {
      const source = token === undefined ? undefined : tokenSource(token as Value);
      if (!stateOf((receiver as CsObject).native as CsObject).cancel(source))
        fail('System.InvalidOperationException', ALREADY_COMPLETED);
    },
    [`${prefix}.TrySetCanceled`]: (_call, receiver, [token]) =>
      stateOf((receiver as CsObject).native as CsObject).cancel(
        token === undefined ? undefined : tokenSource(token as Value)
      ),
  });
}

// ---- Continuations, task factories, and created tasks ----

const CONTINUATION = {
  notOnRanToCompletion: 0x1_00_00,
  notOnFaulted: 0x2_00_00,
  notOnCanceled: 0x4_00_00,
  executeSynchronously: 0x8_00_00,
} as const;

/** Whether a continuation's options let it run after its antecedent ended as it did. */
function continuationRuns(options: number, antecedent: TaskState): boolean {
  if (antecedent.status === 'completed') return (options & CONTINUATION.notOnRanToCompletion) === 0;
  if (antecedent.status === 'faulted') return (options & CONTINUATION.notOnFaulted) === 0;
  return (options & CONTINUATION.notOnCanceled) === 0;
}

/**
 * `ContinueWith`: a task of the continuation, which runs with the antecedent when it ends, queued as .NET runs it on
 * the thread pool, or at once with `ExecuteSynchronously`. Options that exclude how the antecedent ended, or the
 * continuation's token canceled first, cancel it instead.
 */
function continueWith(
  call: NativeCall,
  receiver: Value,
  continuation: Value,
  resultType: Type | undefined,
  token?: Value,
  options = 0
): CsObject {
  if (continuation === undefined)
    fail(
      'System.ArgumentNullException',
      'Value cannot be null.',
      resultType ? 'continuationFunction' : 'continuationAction'
    );
  const antecedent = stateOf(receiver);
  const { state, object } = newTask(call, resultType);
  const source = token === undefined ? undefined : tokenSource(token);
  state.token = source;
  const id = whenCanceled(source, () => state.cancel(source));
  const evaluator = evaluatorOf(call);
  const frame = call.frame;
  antecedent.whenDone(() => {
    if (state.isDone) return;
    if (!continuationRuns(options, antecedent)) {
      unregister(source, id);
      state.cancel(undefined);
      return;
    }
    const start = (): void => {
      unregister(source, id);
      runWork(evaluator, state, () => evaluator.invokeDelegate(frame, continuation, [receiver], undefined), false);
    };
    if ((options & CONTINUATION.executeSynchronously) === 0) frame.runtime.scheduler.queue(start);
    else start();
  });
  return object;
}

/** The overloads of `ContinueWith` of a task type, with a token or options after the continuation. */
function continueWithNatives(prefix: string, action: string, func: string): Record<string, NativeMethod> {
  const resultOf = typeArgument;
  return {
    [`${prefix}.ContinueWith(${action})`]: (call, receiver, [work]) =>
      continueWith(call, receiver, work as Value, undefined),
    [`${prefix}.ContinueWith(${action}, CancellationToken)`]: (call, receiver, [work, token]) =>
      continueWith(call, receiver, work as Value, undefined, token as Value),
    [`${prefix}.ContinueWith(${action}, TaskContinuationOptions)`]: (call, receiver, [work, options]) =>
      continueWith(call, receiver, work as Value, undefined, undefined, options as number),
    [`${prefix}.ContinueWith(${func})`]: (call, receiver, [work]) =>
      continueWith(call, receiver, work as Value, resultOf(call)),
    [`${prefix}.ContinueWith(${func}, CancellationToken)`]: (call, receiver, [work, token]) =>
      continueWith(call, receiver, work as Value, resultOf(call), token as Value),
    [`${prefix}.ContinueWith(${func}, TaskContinuationOptions)`]: (call, receiver, [work, options]) =>
      continueWith(call, receiver, work as Value, resultOf(call), undefined, options as number),
  };
}

/** `Task.Factory.StartNew`: queues the work as `Task.Run` does, without unwrapping a task that it returns. */
function startNew(
  call: NativeCall,
  work: Value,
  resultType: Type | undefined,
  state: { value: Value } | undefined,
  token?: Value
): CsObject {
  if (work === undefined)
    fail('System.ArgumentNullException', 'Value cannot be null.', resultType ? 'function' : 'action');
  const { state: task, object } = newTask(call, resultType);
  const evaluator = evaluatorOf(call);
  const frame = call.frame;
  task.asyncState = state?.value;
  const args = state ? [state.value] : [];
  queueWork(call, task, token, () => evaluator.invokeDelegate(frame, work, args, undefined), false);
  return object;
}

function startNewNatives(): Record<string, NativeMethod> {
  const factory = 'System.Threading.Tasks.TaskFactory';
  const natives: Record<string, NativeMethod> = {};
  const kinds: [string, (call: NativeCall) => Type | undefined][] = [
    ['Action', () => {}],
    ['Func<TResult>', (call) => typeArgument(call)],
  ];
  for (const [work, resultOf] of kinds) {
    natives[`${factory}.StartNew(${work})`] = (call, _receiver, [fn]) =>
      startNew(call, fn as Value, resultOf(call), undefined);
    natives[`${factory}.StartNew(${work}, CancellationToken)`] = (call, _receiver, [fn, token]) =>
      startNew(call, fn as Value, resultOf(call), undefined, token as Value);
    natives[`${factory}.StartNew(${work}, TaskCreationOptions)`] = (call, _receiver, [fn]) =>
      startNew(call, fn as Value, resultOf(call), undefined);
    const withState = work === 'Action' ? 'Action<object?>' : 'Func<object?, TResult>';
    natives[`${factory}.StartNew(${withState}, object?)`] = (call, _receiver, [fn, state]) =>
      startNew(call, fn as Value, resultOf(call), { value: state as Value });
    natives[`${factory}.StartNew(${withState}, object?, CancellationToken)`] = (call, _receiver, [fn, state, token]) =>
      startNew(call, fn as Value, resultOf(call), { value: state as Value }, token as Value);
    natives[`${factory}.StartNew(${withState}, object?, TaskCreationOptions)`] = (call, _receiver, [fn, state]) =>
      startNew(call, fn as Value, resultOf(call), { value: state as Value });
  }
  return natives;
}

/** The work of tasks made with a constructor that have not started, which `Start` queues and `RunSynchronously` runs. */
const unstartedWork = new WeakMap<TaskState, () => Value>();

/** `new Task(...)`: a task in the `Created` state with its work, canceled at once by a canceled token. */
const createTask: NativeMethod = (call, receiver, args) => {
  const object = receiver as CsObject;
  const state = call.frame.runtime.scheduler.newTask();
  object.native = state;
  state.object = object;
  state.pendingStatus = TASK_STATUS.created;
  const [work] = args as Value[];
  if (work === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', call.method.parameters[0].name);
  const takesState = call.method.parameters[1]?.name === 'state';
  state.asyncState = takesState ? (args[1] as Value) : undefined;
  const source = !takesState && args.length > 1 ? tokenSource(args[1] as Value) : undefined;
  state.token = source;
  const evaluator = evaluatorOf(call);
  const frame = call.frame;
  unstartedWork.set(state, () =>
    evaluator.invokeDelegate(frame, work, takesState ? [state.asyncState] : [], undefined)
  );
  whenCanceled(source, () => state.cancel(source));
};

function takeUnstartedWork(state: TaskState): () => Value {
  const work = unstartedWork.get(state);
  if (!work || state.isDone) {
    const reason = state.isDone
      ? 'Start may not be called on a task that has completed.'
      : state.pendingStatus === TASK_STATUS.waitingForActivation
        ? 'Start may not be called on a promise-style task.'
        : 'Start may not be called on a task that was already started.';
    fail('System.InvalidOperationException', reason);
  }
  unstartedWork.delete(state);
  return work;
}

/** `Unwrap`: a task that ends as the task the outer one returns ends, or as the outer one if it did not complete. */
function unwrap(call: NativeCall, receiver: Value, resultType: Type | undefined): CsObject {
  const outer = stateOf(receiver);
  const { state, object } = newTask(call, resultType);
  outer.whenDone(() => {
    if (outer.status !== 'completed') state.settleAs(outer);
    else if (outer.result === undefined) state.cancel(undefined);
    else {
      const inner = stateOf(outer.result);
      inner.whenDone(() => state.settleAs(inner));
    }
  });
  return object;
}

defineNatives({
  ...continueWithNatives(TASK, 'Action<Task>', 'Func<Task, TResult>'),
  ...continueWithNatives(TASK_OF, 'Action<Task<TResult>>', 'Func<Task<TResult>, TNewResult>'),
  ...startNewNatives(),
  [`${TASK}.get_Factory`]: (call) => {
    const factory = new CsObject(libraryType(call, 'System.Threading.Tasks.TaskFactory'), []);
    return factory;
  },
  [`${TASK}.get_AsyncState`]: (_call, receiver) => stateOf(receiver).asyncState,
  [`${TASK}..ctor`]: createTask,
  [`${TASK_OF}..ctor`]: createTask,
  [`${TASK}.Start`]: (call, receiver) => {
    const state = stateOf(receiver);
    const work = takeUnstartedWork(state);
    state.pendingStatus = TASK_STATUS.waitingToRun;
    const evaluator = evaluatorOf(call);
    call.frame.runtime.scheduler.queue(() => runWork(evaluator, state, work, false));
  },
  [`${TASK}.RunSynchronously`]: (call, receiver) => {
    const state = stateOf(receiver);
    runWork(evaluatorOf(call), state, takeUnstartedWork(state), false);
  },
  'System.Threading.Tasks.TaskExtensions.Unwrap(Task<Task>)': (call, _receiver, [task]) =>
    unwrap(call, task as Value, undefined),
  'System.Threading.Tasks.TaskExtensions.Unwrap(Task<Task<TResult>>)': (call, _receiver, [task]) =>
    unwrap(call, task as Value, typeArgument(call)),
});

// ---- ValueTask ----

for (const prefix of ['System.Threading.Tasks.ValueTask', 'System.Threading.Tasks.ValueTask`1']) {
  const isGeneric = prefix.endsWith('`1');
  const resultTypeOfValueTask = (receiver: Value): Type[] =>
    isGeneric ? [((receiver as CsStruct).type as NamedType).args[0]] : [];
  defineNatives({
    [`${prefix}..ctor(${isGeneric ? 'Task<TResult>' : 'Task'})`]: (_call, receiver, [task]) => {
      if (task === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'task');
      (receiver as CsStruct).fields[0] = task as Value;
    },
    [`${prefix}.get_IsCompleted`]: (_call, receiver) => valueTaskState(receiver).isDone,
    [`${prefix}.get_IsCompletedSuccessfully`]: (_call, receiver) => valueTaskState(receiver).status === 'completed',
    [`${prefix}.get_IsFaulted`]: (_call, receiver) => valueTaskState(receiver).status === 'faulted',
    [`${prefix}.GetAwaiter`]: (call, receiver) =>
      wrapping(
        call,
        `System.Runtime.CompilerServices.ValueTaskAwaiter`,
        valueTaskObject(call, receiver),
        resultTypeOfValueTask(receiver)
      ),
    [`${prefix}.ConfigureAwait`]: (call, receiver) =>
      wrapping(
        call,
        'System.Runtime.CompilerServices.ConfiguredTaskAwaitable',
        valueTaskObject(call, receiver),
        resultTypeOfValueTask(receiver)
      ),
    [`${prefix}.AsTask`]: (call, receiver) => valueTaskObject(call, receiver),
  });
}

defineNatives({
  'System.Threading.Tasks.ValueTask.get_CompletedTask': (call) =>
    new CsStruct(libraryType(call, 'System.Threading.Tasks.ValueTask'), [completedTask(call, undefined)]),
  'System.Threading.Tasks.ValueTask.FromResult': (call, _receiver, [result]) =>
    new CsStruct(libraryType(call, 'System.Threading.Tasks.ValueTask', [typeArgument(call)]), [
      completedTask(call, result as Value, typeArgument(call)),
    ]),
  'System.Threading.Tasks.ValueTask`1..ctor(TResult)': (call, receiver, [result]) => {
    const resultType = ((receiver as CsStruct).type as NamedType).args[0];
    (receiver as CsStruct).fields[0] = completedTask(call, result as Value, resultType);
  },
  'System.Threading.Tasks.ValueTask`1.get_Result': (call, receiver) => {
    const state = valueTaskState(receiver);
    return getResult(call, state);
  },
});

/** The task a ValueTask wraps; `default(ValueTask)` wraps none and is a completed one. */
function valueTaskObject(call: NativeCall, receiver: Value): CsObject {
  const task = (receiver as CsStruct).fields[0];
  if (task instanceof CsObject) return task;
  const type = (receiver as CsStruct).type as NamedType;
  return completedTask(call, undefined, type.args[0]);
}

function valueTaskState(receiver: Value): TaskState {
  const task = (receiver as CsStruct).fields[0];
  if (task instanceof CsObject) return task.native as TaskState;
  const done = { isDone: true, status: 'completed', result: undefined, exceptions: [] } as unknown as TaskState;
  return done;
}

// ---- Awaiters ----

defineNatives({
  ...awaiterNatives('System.Runtime.CompilerServices.TaskAwaiter'),
  ...awaiterNatives('System.Runtime.CompilerServices.TaskAwaiter`1'),
  ...awaiterNatives('System.Runtime.CompilerServices.ValueTaskAwaiter'),
  ...awaiterNatives('System.Runtime.CompilerServices.ValueTaskAwaiter`1'),
  ...awaiterNatives('System.Runtime.CompilerServices.ConfiguredTaskAwaitable+ConfiguredTaskAwaiter'),
  ...awaiterNatives('System.Runtime.CompilerServices.ConfiguredTaskAwaitable`1+ConfiguredTaskAwaiter'),
  'System.Runtime.CompilerServices.ConfiguredTaskAwaitable.GetAwaiter': (call, receiver) =>
    wrapping(
      call,
      'System.Runtime.CompilerServices.ConfiguredTaskAwaitable+ConfiguredTaskAwaiter',
      (receiver as CsStruct).fields[0]
    ),
  'System.Runtime.CompilerServices.ConfiguredTaskAwaitable`1.GetAwaiter': (call, receiver) =>
    wrapping(
      call,
      'System.Runtime.CompilerServices.ConfiguredTaskAwaitable`1+ConfiguredTaskAwaiter',
      (receiver as CsStruct).fields[0],
      ((receiver as CsStruct).type as NamedType).args
    ),
  'System.Runtime.CompilerServices.YieldAwaitable.GetAwaiter': (call) =>
    new CsStruct(libraryType(call, 'System.Runtime.CompilerServices.YieldAwaitable+YieldAwaiter'), []),
  'System.Runtime.CompilerServices.YieldAwaitable+YieldAwaiter.get_IsCompleted': () => false,
  'System.Runtime.CompilerServices.YieldAwaitable+YieldAwaiter.GetResult': () => {},
  'System.Runtime.CompilerServices.YieldAwaitable+YieldAwaiter.OnCompleted': (call, _receiver, [continuation]) => {
    const evaluator = evaluatorOf(call);
    call.frame.runtime.scheduler.queue(() =>
      evaluator.invokeDelegate(call.frame, continuation as Value, [], undefined)
    );
  },
  'System.Runtime.CompilerServices.YieldAwaitable+YieldAwaiter.UnsafeOnCompleted': (
    call,
    _receiver,
    [continuation]
  ) => {
    const evaluator = evaluatorOf(call);
    call.frame.runtime.scheduler.queue(() =>
      evaluator.invokeDelegate(call.frame, continuation as Value, [], undefined)
    );
  },
});

// ---- AggregateException ----

defineNatives({
  'System.AggregateException..ctor()': (_call, receiver) => {
    setAggregate(receiver, undefined, []);
  },
  'System.AggregateException..ctor(string?)': (_call, receiver, [message]) => {
    setAggregate(receiver, message as Value, []);
  },
  'System.AggregateException..ctor(Exception[])': (_call, receiver, [inner]) => {
    setAggregate(receiver, undefined, (inner as { values: Value[] }).values as CsObject[]);
  },
  'System.AggregateException..ctor(string?, Exception[])': (_call, receiver, [message, inner]) => {
    setAggregate(receiver, message as Value, (inner as { values: Value[] }).values as CsObject[]);
  },
  'System.AggregateException.get_InnerExceptions': (call, receiver) => {
    const inner = ((receiver as CsObject).native as AggregateState).innerExceptions ?? [];
    const exceptionType = libraryType(call, 'System.Exception');
    const collection = new CsObject(
      libraryType(call, 'System.Collections.ObjectModel.ReadOnlyCollection', [exceptionType]),
      []
    );
    collection.native = new ListState([...inner], exceptionType);
    return collection;
  },
  'System.AggregateException.Flatten': (_call, receiver) => receiver as CsObject,
  'System.AggregateException.get_Message': (_call, receiver) =>
    ((receiver as CsObject).native as ExceptionState).message ?? '',
});

function setAggregate(receiver: Value, message: Value, inner: CsObject[]): void {
  const base = isString(message) ? stringText(message) : 'One or more errors occurred.';
  const listed = inner.map((exception) => ` (${exceptionMessage(exception)})`).join('');
  const state: AggregateState = {
    message: `${base}${listed}`,
    inner: inner[0],
    wasThrown: false,
    innerExceptions: inner,
  };
  (receiver as CsObject).native = state;
}
