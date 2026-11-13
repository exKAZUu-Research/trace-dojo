import { monotonicNanoseconds, nanosecondsToSeconds } from '../clock';
import { pyStr } from '../conversions';
import {
  isAwaitable,
  isCoroutineFunction,
  isCoroutineLike,
  setAsyncGeneratorFinalizer,
  takeUnfinishedAsyncGenerators,
} from '../coroutines';
import { builtin } from '../define';
import { callValue, getAttribute } from '../objects';
import type { Runtime } from '../runtime';
import { blockingBuiltin, getRunningLoop, schedulerOf, setRunningLoop, WaitRequest } from '../threads';
import { toFloat } from '../typeNumbers';
import { generatorClass, moduleClass, newList, None } from '../types';
import { NamespaceMap, PyGenerator, PyModule, type PyValue } from '../values';
import { threadLocalClass } from './thread';

const wokenLoops = new WeakMap<Runtime, WeakSet<object>>();

// code-gauge-allow functionCognitiveComplexity 20 -- One small builtin per native part of the event loop.
// code-gauge-allow functionNcss 43 -- One small builtin per native part of the event loop.
export function asyncioNatives(runtime: Runtime): Map<string, PyValue> {
  const woken = wokenOf(runtime);
  const core = new PyModule(moduleClass, '_asyncio_core', new NamespaceMap());
  const define = (name: string, value: PyValue): void => {
    core.dict.set(name, value);
  };
  define(
    'iscoroutine',
    builtin('iscoroutine', 'one', 1, 1, ([value]) => isCoroutineLike(value))
  );
  define(
    'iscoroutinefunction',
    builtin('iscoroutinefunction', 'one', 1, 1, ([value]) => isCoroutineFunction(value))
  );
  define(
    'isawaitable',
    builtin('isawaitable', 'one', 1, 1, ([value]) => isAwaitable(value))
  );
  define(
    'isgenerator',
    builtin('isgenerator', 'one', 1, 1, ([value]) => value instanceof PyGenerator && value.cls === generatorClass)
  );
  define(
    'get_ident',
    builtin('get_ident', 'none', 0, 0, () => schedulerOf(runtime).current.ident)
  );
  define('local', threadLocalClass);
  define(
    'get_running_loop',
    builtin('get_running_loop', 'none', 0, 0, () => getRunningLoop(runtime) ?? None)
  );
  define(
    'set_running_loop',
    builtin('set_running_loop', 'one', 1, 1, ([loop]) => {
      setRunningLoop(loop === None ? undefined : loop, runtime);
      return None;
    })
  );
  define(
    'thread_name',
    builtin('thread_name', 'none', 0, 0, () => threadName(runtime))
  );
  define(
    'loop_time',
    builtin('loop_time', 'none', 0, 0, () => nanosecondsToSeconds(monotonicNanoseconds(runtime)))
  );
  define(
    'select',
    blockingBuiltin('select', 'expected', [2, 2], function* ([loop, timeout]) {
      const scheduler = schedulerOf(runtime);
      const seconds = timeout === None ? undefined : toFloat(timeout as PyValue);
      if (seconds !== undefined && seconds <= 0) {
        woken.delete(loop as object);
        return None;
      }
      const deadline = seconds === undefined ? undefined : scheduler.now() + BigInt(Math.ceil(seconds * 1e9));
      while (!woken.has(loop as object) && (deadline === undefined || scheduler.now() < deadline)) {
        yield new WaitRequest(() => woken.has(loop as object), deadline);
      }
      woken.delete(loop as object);
      return None;
    })
  );
  define(
    'wakeup',
    builtin('wakeup', 'one', 1, 1, ([loop]) => {
      woken.add(loop as object);
      return None;
    })
  );
  define(
    'set_asyncgen_finalizer',
    builtin('set_asyncgen_finalizer', 'one', 1, 1, ([hook]) => {
      setAsyncGeneratorFinalizer(runtime, hook === None ? undefined : hook);
      return None;
    })
  );
  define(
    'take_asyncgens',
    builtin('take_asyncgens', 'none', 0, 0, () => newList(takeUnfinishedAsyncGenerators(runtime)))
  );
  define(
    'coroutine_repr',
    builtin('coroutine_repr', 'one', 1, 1, ([coroutine]) => {
      if (!(coroutine instanceof PyGenerator)) return pyStr(getAttribute(coroutine as PyValue, '__qualname__'));
      return `${coroutine.qualifiedName}() ${coroutine.finished ? 'done' : 'running'}`;
    })
  );
  return new Map([['_core', core]]);
}

function wokenOf(runtime: Runtime): WeakSet<object> {
  let woken = wokenLoops.get(runtime);
  if (!woken) {
    woken = new WeakSet();
    wokenLoops.set(runtime, woken);
  }
  return woken;
}

function threadName(runtime: Runtime): string {
  const threading = runtime.modules.get('threading');
  const current = threading?.dict.get('current_thread');
  if (!current) return 'MainThread';
  return pyStr(getAttribute(callValue(current, []), 'name'));
}
