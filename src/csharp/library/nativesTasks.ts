import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { CsThrow, type ExceptionState, type Runtime } from '../runtime';
import { taskObject, type TaskState } from '../tasks';
import type { NamedType, Type } from '../types';
import { CsBox, CsObject, CsStruct, isString, stringText, type Value } from '../values';
import { iterate } from './iteration';
import { ListState } from './nativesCollections';
import { evaluatorOf, fail, failOutOfRange, libraryType, newArray, typeArgument } from './support';

const TASK = 'System.Threading.Tasks.Task';
const TASK_OF = 'System.Threading.Tasks.Task`1';
const STATUS = { pending: 1, completed: 5, faulted: 7 } as const;
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

/** What `Wait()` and `Result` throw for a faulted task: an AggregateException of its exceptions. */
function throwAggregate(call: NativeCall, state: TaskState): never {
  throw new CsThrow(
    aggregateOf(
      call.frame.runtime,
      state.exceptions.map((thrown) => thrown.exception)
    )
  );
}

/** An AggregateException of exceptions, whose message lists theirs, as .NET's does. */
function aggregateOf(runtime: Runtime, inner: CsObject[]): CsObject {
  const messages = inner.map((exception) => ` (${(exception.native as ExceptionState).message ?? ''})`).join('');
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
  if (state.status === 'faulted') throw state.exceptions[0];
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

/** `Task.WhenAll`: done when every task is, faulted with their exceptions in order if any faulted. */
function whenAll(call: NativeCall, tasks: Value, resultType: Type | undefined): CsObject {
  const states = taskStates(call, tasks);
  const { state, object } = newTask(call, resultType ? { kind: 'array', element: resultType, rank: 1 } : undefined);
  let remaining = states.length;
  const settle = (): void => {
    const faulted = states.flatMap((task) => task.exceptions);
    if (faulted.length > 0) state.fault(faulted);
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

/** `Task.Run`: queues the function, whose task completes with its result, or with the task it returns. */
function run(call: NativeCall, work: Value, resultType: Type | undefined, unwraps: boolean): CsObject {
  if (work === undefined) fail('System.ArgumentNullException', 'Value cannot be null.', 'function');
  const { state, object } = newTask(call, resultType);
  const evaluator = evaluatorOf(call);
  call.frame.runtime.scheduler.queue(() => {
    let result: Value;
    try {
      result = evaluator.invokeDelegate(call.frame, work, [], undefined);
    } catch (error) {
      const thrown = evaluator.asThrow(error);
      if (!thrown) throw error;
      state.fault([thrown]);
      return;
    }
    if (!unwraps) {
      state.complete(result);
      return;
    }
    if (result === undefined) {
      state.complete(undefined);
      return;
    }
    const inner = stateOf(result);
    inner.whenDone(() => (inner.status === 'faulted' ? state.fault(inner.exceptions) : state.complete(inner.result)));
  });
  return object;
}

function delay(call: NativeCall, milliseconds: number, paramName: string): CsObject {
  if (milliseconds < -1)
    failOutOfRange(
      call,
      paramName,
      'The value needs to be either -1 (signifying an infinite timeout), 0 or a positive integer.'
    );
  const { state, object } = newTask(call);
  if (milliseconds === 0) state.complete(undefined);
  else if (milliseconds > 0) call.frame.runtime.scheduler.delay(milliseconds, () => state.complete(undefined));
  return object;
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
  return STATUS[state.status];
}

defineNatives({
  [`${TASK}.get_CompletedTask`]: (call) => completedTask(call, undefined),
  [`${TASK}.get_Status`]: (_call, receiver) => taskStatus(stateOf(receiver)),
  [`${TASK}.get_IsCompleted`]: (_call, receiver) => stateOf(receiver).isDone,
  [`${TASK}.get_IsCompletedSuccessfully`]: (_call, receiver) => stateOf(receiver).status === 'completed',
  [`${TASK}.get_IsFaulted`]: (_call, receiver) => stateOf(receiver).status === 'faulted',
  [`${TASK}.get_IsCanceled`]: () => false,
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
    if (state.status === 'faulted') throwAggregate(call, state);
  },
  [`${TASK}.Wait(int)`]: (call, receiver, [timeout]) => waitWithTimeout(call, stateOf(receiver), timeout as number),
  [`${TASK}.Wait(TimeSpan)`]: (call, receiver, [timeout]) =>
    waitWithTimeout(call, stateOf(receiver), Number(((timeout as CsStruct).fields[0] as bigint) / 10_000n)),
  [`${TASK}.Dispose`]: () => {},
  [`${TASK}.Delay(int)`]: (call, _receiver, [milliseconds]) => delay(call, milliseconds as number, 'millisecondsDelay'),
  [`${TASK}.Delay(TimeSpan)`]: (call, _receiver, [span]) =>
    delay(call, Number(((span as CsStruct).fields[0] as bigint) / 10_000n), 'delay'),
  [`${TASK}.Run(Action)`]: (call, _receiver, [action]) => run(call, action as Value, undefined, false),
  [`${TASK}.Run(Func<TResult>)`]: (call, _receiver, [work]) => run(call, work as Value, typeArgument(call), false),
  [`${TASK}.Run(Func<Task?>)`]: (call, _receiver, [work]) => run(call, work as Value, undefined, true),
  [`${TASK}.Run(Func<Task<TResult>?>)`]: (call, _receiver, [work]) =>
    run(call, work as Value, typeArgument(call), true),
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
    const exceptions = states.flatMap((state) => state.exceptions);
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
    if (state.status === 'faulted') throwAggregate(call, state);
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
  if (state.status === 'faulted') throwAggregate(call, state);
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
  });
}

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
  const listed = inner.map((exception) => ` (${(exception.native as ExceptionState).message ?? ''})`).join('');
  const state: AggregateState = {
    message: `${base}${listed}`,
    inner: inner[0],
    wasThrown: false,
    innerExceptions: inner,
  };
  (receiver as CsObject).native = state;
}
