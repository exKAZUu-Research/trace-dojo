import { builtin } from '../define';
import { registerRootSource } from '../hostRoots';
import { registerModule } from '../modules';
import { callValue, isCallable } from '../objects';
import { equals } from '../operators';
import type { Runtime } from '../runtime';
import { nativeFunction, None, typeError } from '../types';
import { type Kwargs, PyError, type PyValue } from '../values';

interface Callback {
  fn: PyValue;
  args: PyValue[];
  kwargs: Kwargs;
}

const callbacksOfRuns = new WeakMap<Runtime, Callback[]>();

registerRootSource((runtime) => (callbacksOfRuns.get(runtime) ?? []).flatMap(referencesOf));

function callbacksOf(runtime: Runtime): Callback[] {
  let callbacks = callbacksOfRuns.get(runtime);
  if (!callbacks) {
    callbacks = [];
    callbacksOfRuns.set(runtime, callbacks);
  }
  return callbacks;
}

registerModule(
  'atexit',
  (runtime) =>
    new Map<string, PyValue>([
      [
        'register',
        nativeFunction('register', ([fn, ...args], kwargs) => {
          if (fn === undefined) throw typeError('register() takes at least 1 argument (0 given)');
          if (!isCallable(fn)) throw typeError('the first argument must be callable');
          callbacksOf(runtime).push({ fn, args, kwargs });
          return fn;
        }),
      ],
      [
        'unregister',
        builtin('unregister', 'one', 1, 1, ([fn]) => {
          const callbacks = callbacksOf(runtime);
          const removed = callbacks.filter((callback) => equals(callback.fn, fn));
          const kept = callbacks.filter((callback) => !removed.includes(callback));
          callbacks.splice(0, callbacks.length, ...kept);
          release(runtime, removed);
          return None;
        }),
      ],
      ['_run_exitfuncs', builtin('_run_exitfuncs', 'none', 0, 0, () => runExitCallbacks(runtime) ?? None)],
      [
        '_clear',
        builtin('_clear', 'none', 0, 0, () => {
          clear(runtime);
          return None;
        }),
      ],
      ['_ncallbacks', builtin('_ncallbacks', 'none', 0, 0, () => BigInt(callbacksOf(runtime).length))],
    ])
);

/**
 * Calls the functions registered with `atexit`, last registered first, as CPython does when a program ends. An
 * exception a function raises goes to stderr, which learners do not see, and the next function still runs. The
 * registrations stay until all have run, and are then dropped in the order they were made.
 */
export function runExitCallbacks(runtime: Runtime): undefined {
  const callbacks = callbacksOfRuns.get(runtime);
  if (!callbacks) return undefined;
  for (const { fn, args, kwargs } of callbacks.toReversed()) {
    try {
      callValue(fn, args, kwargs);
    } catch (error) {
      if (!(error instanceof PyError)) throw error;
    }
  }
  clear(runtime);
  return undefined;
}

function clear(runtime: Runtime): void {
  const callbacks = callbacksOf(runtime);
  release(runtime, callbacks.splice(0));
}

/** Frees what only `removed` kept, as CPython's dropping of each `(func, args, kwargs)` registration does. */
function release(runtime: Runtime, removed: readonly Callback[]): void {
  runtime.finalizer.release(removed.flatMap(referencesOf));
}

/** What a registration refers to, in the order freeing its tuple drops them: from its last item. */
function referencesOf({ fn, args, kwargs }: Callback): PyValue[] {
  return [...(kwargs?.values() ?? []), ...args.toReversed(), fn];
}
