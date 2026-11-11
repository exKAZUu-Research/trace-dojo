import { builtin } from '../define';
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
          const kept = callbacks.filter((callback) => !equals(callback.fn, fn));
          callbacks.splice(0, callbacks.length, ...kept);
          return None;
        }),
      ],
      ['_run_exitfuncs', builtin('_run_exitfuncs', 'none', 0, 0, () => runExitCallbacks(runtime) ?? None)],
      [
        '_clear',
        builtin('_clear', 'none', 0, 0, () => {
          callbacksOf(runtime).length = 0;
          return None;
        }),
      ],
      ['_ncallbacks', builtin('_ncallbacks', 'none', 0, 0, () => BigInt(callbacksOf(runtime).length))],
    ])
);

/**
 * Calls the functions registered with `atexit`, last registered first, as CPython does when a program ends. An
 * exception a function raises goes to stderr, which learners do not see, and the next function still runs.
 */
export function runExitCallbacks(runtime: Runtime): undefined {
  const callbacks = callbacksOfRuns.get(runtime);
  while (callbacks && callbacks.length > 0) {
    const { fn, args, kwargs } = callbacks.pop() as Callback;
    try {
      callValue(fn, args, kwargs);
    } catch (error) {
      if (!(error instanceof PyError)) throw error;
    }
  }
  return undefined;
}
