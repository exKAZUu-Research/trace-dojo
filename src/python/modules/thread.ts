import { copyKeywords, keywordMap } from '../callArguments';
import { monotonicNanoseconds, nanosecondsToSeconds } from '../clock';
import { addressOf } from '../conversions';
import { builtin, method, redeclareMethods } from '../define';
import { registerThreadLocalAccess } from '../descriptors';
import { defineNew } from '../instances';
import { registerModule, registerSharedAttributes, setBuiltinFunctionModule } from '../modules';
import { argument } from '../nativeArgs';
import { toIndex } from '../numbers';
import { bindValue, callValue, isTruthy } from '../objects';
import { currentRuntime } from '../runtimeContext';
import {
  type Blocking,
  blockingBuiltin,
  blockingMethod,
  currentThreadKey,
  type PyThreadState,
  registerThreadLocalMap,
  schedulerOf,
  suspendingCall,
  WaitRequest,
} from '../threads';
import { toFloat } from '../typeNumbers';
import {
  exceptionClassNamed,
  newTuple,
  None,
  objectClass,
  pyError,
  stringValue,
  typeError,
  typeName,
  valueError,
} from '../types';
import {
  AttributeMap,
  type Kwargs,
  type PyBuiltinFunction,
  PyDict,
  PyError,
  type PyObject,
  PyOpaque,
  PyTuple,
  type PyValue,
} from '../values';
import { builtinClassWithBase } from './moduleClasses';
import { systemExitError } from './sys';

/** The largest timeout CPython's locks accept, in seconds. */
export const TIMEOUT_MAX = 9_223_372_036;

interface LockState {
  owner: PyThreadState | undefined;
  /** How many times the owner acquired a reentrant lock. */
  count: number;
}

const lockClass = builtinClassWithBase('lock', objectClass, '_thread');
lockClass.typeName = '_thread.lock';
const rlockClass = builtinClassWithBase('RLock', objectClass, '_thread');
rlockClass.typeName = '_thread.RLock';
const handleClass = builtinClassWithBase('_ThreadHandle', objectClass, '_thread');

const stateOf = (self: PyValue): LockState => (self as PyOpaque).data as LockState;

export function newLock(): PyOpaque {
  return new PyOpaque(lockClass, 'lock', { owner: undefined, count: 0 } satisfies LockState);
}

lockClass.construct = (_cls, args, kwargs) => {
  if (kwargs && kwargs.size > 0) throw typeError('lock() takes no keyword arguments');
  if (args.length > 0) throw typeError(`lock expected 0 arguments, got ${args.length}`);
  return newLock();
};
rlockClass.construct = () => new PyOpaque(rlockClass, 'RLock', { owner: undefined, count: 0 } satisfies LockState);

/** The deadline of `acquire(blocking, timeout)`, or undefined to wait forever, checking the arguments as CPython does. */
function acquireDeadline(args: PyValue[], kwargs: Kwargs): bigint | undefined | false {
  const blocking = argument(args, kwargs, 0, 'blocking');
  const timeoutValue = argument(args, kwargs, 1, 'timeout');
  const timeout = timeoutValue === undefined ? -1 : toFloat(timeoutValue);
  const blocks = blocking === undefined || isTruthy(blocking);
  if (!blocks && timeout !== -1) throw valueError("can't specify a timeout for a non-blocking call");
  if (timeout < 0 && timeout !== -1) throw valueError('timeout value must be a non-negative number');
  if (timeout > TIMEOUT_MAX) throw pyError('OverflowError', 'timeout value is too large');
  if (!blocks) return false;
  if (timeout === -1) return undefined;
  return schedulerOf().now() + BigInt(Math.ceil(timeout * 1e9));
}

/** Acquires a lock for the current thread, waiting until it is free or the deadline passes. */
function* acquire(state: LockState, deadline: bigint | undefined | false, reentrant: boolean): Blocking<boolean> {
  const scheduler = schedulerOf();
  const me = scheduler.current;
  if (reentrant && state.owner === me) {
    state.count++;
    return true;
  }
  while (state.owner !== undefined) {
    if (deadline === false || (deadline !== undefined && scheduler.now() >= deadline)) return false;
    yield new WaitRequest(() => state.owner === undefined, deadline);
  }
  state.owner = me;
  state.count = 1;
  return true;
}

function release(state: LockState, reentrant: boolean): void {
  if (reentrant) {
    if (state.owner !== schedulerOf().current) throw pyError('RuntimeError', 'cannot release un-acquired lock');
    state.count--;
    if (state.count > 0) return;
  } else if (state.owner === undefined) {
    throw pyError('RuntimeError', 'release unlocked lock');
  }
  state.owner = undefined;
  state.count = 0;
}

for (const [cls, reentrant] of [
  [lockClass, false],
  [rlockClass, true],
] as const) {
  for (const name of ['acquire', 'acquire_lock']) {
    blockingMethod(
      cls,
      name,
      'takes',
      [0, 2],
      (self, args, kwargs) => acquire(stateOf(self), acquireDeadline(args, kwargs), reentrant),
      ['blocking', 'timeout']
    );
  }
  blockingMethod(cls, '__enter__', 'none', [0, 0], (self) => acquire(stateOf(self), undefined, reentrant));
  for (const name of ['release', 'release_lock']) {
    method(cls, name, 'none', 0, 0, (self) => {
      release(stateOf(self), reentrant);
      return None;
    });
  }
  method(cls, '__exit__', 'expected', 0, 3, (self) => {
    release(stateOf(self), reentrant);
    return None;
  });
  method(cls, 'locked', 'none', 0, 0, (self) => stateOf(self).owner !== undefined);
}
method(lockClass, '__repr__', 'none', 0, 0, (self) => {
  const locked = stateOf(self).owner === undefined ? 'unlocked' : 'locked';
  return `<${locked} _thread.lock object at ${addressOf(self as PyOpaque)}>`;
});
method(rlockClass, '__repr__', 'none', 0, 0, (self) => {
  const { owner, count } = stateOf(self);
  const locked = owner === undefined ? 'unlocked' : 'locked';
  return `<${locked} _thread.RLock object owner=${owner?.ident ?? 0} count=${count} at ${addressOf(self as PyOpaque)}>`;
});
method(rlockClass, '_is_owned', 'none', 0, 0, (self) => stateOf(self).owner === schedulerOf().current);
method(rlockClass, '_release_save', 'none', 0, 0, (self) => {
  const state = stateOf(self);
  if (state.owner !== schedulerOf().current) throw pyError('RuntimeError', 'cannot release un-acquired lock');
  const saved = newTuple([BigInt(state.count), state.owner.ident]);
  state.owner = undefined;
  state.count = 0;
  return saved;
});
blockingMethod(rlockClass, '_acquire_restore', 'one', [1, 1], function* (self, [saved]) {
  const state = stateOf(self);
  yield* acquire(state, undefined, false);
  state.count = Number((saved as unknown as { items: bigint[] }).items[0]);
  return None;
});

// Threads -------------------------------------------------------------------------------------------------------------

const threadOf = (self: PyValue): PyThreadState => (self as PyOpaque).data as PyThreadState;

/** Runs a thread's function, whose uncaught exception CPython only reports on stderr. */
function* threadBody(fn: PyValue, args: PyValue[], kwargs: Kwargs): Generator<PyValue, PyValue, PyValue> {
  try {
    const call = suspendingCall(fn, args, kwargs);
    if (call) yield* call;
    else callValue(fn, args, kwargs);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
  }
  return None;
}

/** Starts a thread running `fn`, then lets it run before the starting thread goes on, as CPython's start() waits. */
function* startThread(fn: PyValue, args: PyValue[], kwargs: Kwargs, daemon: boolean): Blocking<PyThreadState> {
  const thread = schedulerOf().start(threadBody(fn, args, kwargs), daemon);
  yield new WaitRequest(() => true);
  return thread;
}

method(handleClass, 'is_done', 'none', 0, 0, (self) => threadOf(self).finished);
method(handleClass, 'ident', 'none', 0, 0, (self) => threadOf(self).ident);
blockingMethod(handleClass, 'join', 'expected', [0, 1], function* (self, [timeout]) {
  const thread = threadOf(self);
  const scheduler = schedulerOf();
  if (thread === scheduler.current) throw pyError('RuntimeError', 'Cannot join current thread');
  const deadline =
    timeout === undefined || timeout === None
      ? undefined
      : scheduler.now() + BigInt(Math.ceil(Math.max(toFloat(timeout), 0) * 1e9));
  while (!thread.finished && (deadline === undefined || scheduler.now() < deadline)) {
    yield new WaitRequest(() => thread.finished, deadline);
  }
  return None;
});

/** The stack size each run's `stack_size()` last set, which the threads of this interpreter do not use. */
const stackSizes = new WeakMap<object, bigint>();
/** The smallest stack and the page size that pthreads accept for one on the machine whose CPython this matches. */
const THREAD_STACK_MIN = 53_248n;
const PAGE_SIZE = 16_384n;

/** `_thread.stack_size([size])`: sets the size, 0 when omitted, and returns the previous one. */
function stackSize(args: PyValue[]): PyValue {
  const runtime = currentRuntime();
  const size = args.length === 0 ? 0n : toIndex(args[0]);
  const previous = stackSizes.get(runtime) ?? 0n;
  if (size !== 0n) {
    if (size < THREAD_STACK_MIN) throw valueError(`size must be at least ${THREAD_STACK_MIN} bytes`);
    if (size % PAGE_SIZE !== 0n) throw valueError(`size not valid: ${size} bytes`);
  }
  stackSizes.set(runtime, size);
  return previous;
}

/** `_thread.start_new_thread(function, args, kwargs)` and its old name `start_new`. */
function startNewThread(name: string): PyValue {
  return blockingBuiltin(name, 'expected', [2, 3], function* ([fn, args, kwargs]) {
    if (!(args instanceof PyTuple)) throw typeError('2nd arg must be a tuple');
    if (kwargs !== undefined && !(kwargs instanceof PyDict)) throw typeError('optional 3rd arg must be a dictionary');
    const named = kwargs && keywordMap(kwargs.store.ordered().map((entry) => [entry.key, entry.value]));
    // The threads `start_new_thread` starts are not waited for at the end, like daemon threads.
    const thread = yield* startThread(fn, [...args.items], named, true);
    return thread.ident;
  });
}

/** `_thread.exit()`, which raises SystemExit, ending a thread quietly. */
function exitThread(): PyValue {
  throw systemExitError(undefined);
}

// Thread-local storage (`_thread._local`) -----------------------------------------------------------------------------

interface LocalState {
  readonly args: PyValue[];
  readonly kwargs: Map<string, PyValue> | undefined;
  readonly dicts: Map<object, Map<string, PyValue>>;
}

export const threadLocalClass = builtinClassWithBase('_local', objectClass, '_thread');
threadLocalClass.typeName = '_thread._local';
threadLocalClass.construct = undefined;

defineNew(threadLocalClass, (cls, args, kwargs) => {
  if ((args.length > 0 || (kwargs && kwargs.size > 0)) && cls.lookup('__init__') === objectClass.dict.get('__init__')) {
    throw typeError('Initialization arguments are not supported');
  }
  const runtime = currentRuntime();
  const dicts = new Map<object, Map<string, PyValue>>([[currentThreadKey(runtime), new AttributeMap()]]);
  registerThreadLocalMap(dicts, runtime);
  const instance = new PyOpaque(cls, '_local', {
    args: [...args],
    kwargs: kwargs && copyKeywords(kwargs),
    dicts,
  } satisfies LocalState);
  if (cls.flags.definesDel) runtime.finalizer.track(instance);
  return instance;
});

redeclareMethods(threadLocalClass, objectClass, ['__getattribute__', '__setattr__', '__delattr__']);

function localStateOf(value: PyObject): LocalState {
  return (value as PyOpaque).data as LocalState;
}

registerThreadLocalAccess({
  isThreadLocal: (value) => value instanceof PyOpaque && value.cls.isSubclassOf(threadLocalClass),
  peekDict: (value) => localStateOf(value).dicts.get(currentThreadKey()),
  ensureDict: (value) => {
    const runtime = currentRuntime();
    const key = currentThreadKey(runtime);
    const state = localStateOf(value);
    let dict = state.dicts.get(key);
    if (dict !== undefined) return dict;
    dict = new AttributeMap();
    state.dicts.set(key, dict);
    registerThreadLocalMap(state.dicts, runtime);
    const init = value.cls.lookup('__init__');
    if (init !== undefined && init !== objectClass.dict.get('__init__')) {
      try {
        callValue(bindValue(init, value), state.args, state.kwargs);
      } catch (error) {
        state.dicts.delete(key);
        throw error;
      }
    }
    return dict;
  },
});

registerModule('_thread', () => {
  return new Map<string, PyValue>([
    ['stack_size', builtin('stack_size', 'takes', 0, 1, stackSize)],
    ['LockType', lockClass],
    ['lock', lockClass],
    ['RLock', rlockClass],
    ['_local', threadLocalClass],
    ['allocate_lock', builtin('allocate_lock', 'none', 0, 0, () => newLock())],
    ['allocate', builtin('allocate', 'none', 0, 0, () => newLock())],
    ['get_ident', builtin('get_ident', 'none', 0, 0, () => schedulerOf().current.ident)],
    ['get_native_id', builtin('get_native_id', 'none', 0, 0, () => schedulerOf().current.ident % 100_000n)],
    ['TIMEOUT_MAX', TIMEOUT_MAX],
    ['error', exceptionClassNamed('RuntimeError')],
    ['start_new_thread', startNewThread('start_new_thread')],
    ['start_new', startNewThread('start_new')],
    [
      '_start_thread',
      blockingBuiltin('_start_thread', 'expected', [2, 2], function* ([fn, daemon]) {
        const thread = yield* startThread(fn, [], undefined, isTruthy(daemon));
        return new PyOpaque(handleClass, '_ThreadHandle', thread);
      }),
    ],
    ['_count', builtin('_count', 'none', 0, 0, () => BigInt(schedulerOf().alive.length - 1))],
    ['_NAME_MAXLEN', 63n],
    ['daemon_threads_allowed', builtin('daemon_threads_allowed', 'none', 0, 0, () => true)],
    ['_is_main_interpreter', builtin('_is_main_interpreter', 'none', 0, 0, () => true)],
    ['exit', builtin('exit', 'none', 0, 0, exitThread)],
    ['exit_thread', builtin('exit_thread', 'none', 0, 0, exitThread)],
    // A thread's name in the operating system shows nowhere a program here can see.
    [
      'set_name',
      builtin(
        'set_name',
        'takes',
        0,
        1,
        (args, kwargs) => {
          const name = argument(args, kwargs, 0, 'name');
          if (name === undefined) throw typeError("set_name() missing required argument 'name' (pos 1)");
          if (stringValue(name) === undefined) {
            throw typeError(`set_name() argument 'name' must be str, not ${typeName(name)}`);
          }
          return None;
        },
        { keywords: ['name'] }
      ),
    ],
    [
      '_monotonic',
      timeFunction(
        builtin('monotonic', 'none', 0, 0, () => nanosecondsToSeconds(monotonicNanoseconds(currentRuntime())))
      ),
    ],
  ]);
});

registerSharedAttributes('_thread', {
  _ExceptHookArgs: 'threading:_ExceptHookArgs',
  _excepthook: 'threading:excepthook',
});

function timeFunction(fn: PyBuiltinFunction): PyBuiltinFunction {
  setBuiltinFunctionModule(fn, 'time');
  return fn;
}
