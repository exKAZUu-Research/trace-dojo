// The native parts of `asyncio`: what CPython's loop gets from its selector, its clock, and `inspect`.
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
import { blockingBuiltin, schedulerOf, WaitRequest } from '../threads';
import { toFloat } from '../typeNumbers';
import { generatorClass, moduleClass, newList, None } from '../types';
import { PyGenerator, PyModule, type PyValue } from '../values';

interface LoopClock {
  /** How many times the loop read its clock, which advances it by a nanosecond each time. */
  reads: bigint;
  /** The loops a thread woke with `call_soon_threadsafe` since they last waited. */
  readonly woken: WeakSet<object>;
}

const clocks = new WeakMap<Runtime, LoopClock>();

function clockOf(runtime: Runtime): LoopClock {
  let clock = clocks.get(runtime);
  if (!clock) {
    clock = { reads: 0n, woken: new WeakSet() };
    clocks.set(runtime, clock);
  }
  return clock;
}

// code-gauge-allow functionCognitiveComplexity 18 -- One small builtin per native part of the event loop.
// code-gauge-allow functionNcss 40 -- One small builtin per native part of the event loop.
/**
 * The namespace `_core` of the asyncio module's source. Its clock is the virtual one of the run, which only sleeping
 * advances, plus a nanosecond for each reading, since CPython's monotonic clock always advances between two readings
 * and so orders timers set for the same delay in the order they were set.
 */
export function asyncioNatives(runtime: Runtime): Map<string, PyValue> {
  const clock = clockOf(runtime);
  const core = new PyModule(moduleClass, '_asyncio_core', new Map());
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
  define(
    'thread_name',
    builtin('thread_name', 'none', 0, 0, () => threadName(runtime))
  );
  define(
    'loop_time',
    builtin('loop_time', 'none', 0, 0, () => {
      clock.reads++;
      return Number(schedulerOf(runtime).now() + clock.reads) / 1e9;
    })
  );
  define(
    'select',
    blockingBuiltin('select', 'expected', [2, 2], function* ([loop, timeout]) {
      const scheduler = schedulerOf(runtime);
      const seconds = timeout === None ? undefined : toFloat(timeout as PyValue);
      if (seconds !== undefined && seconds <= 0) {
        clock.woken.delete(loop as object);
        return None;
      }
      const deadline = seconds === undefined ? undefined : scheduler.now() + BigInt(Math.ceil(seconds * 1e9));
      while (!clock.woken.has(loop as object) && (deadline === undefined || scheduler.now() < deadline)) {
        yield new WaitRequest(() => clock.woken.has(loop as object), deadline);
      }
      clock.woken.delete(loop as object);
      return None;
    })
  );
  define(
    'wakeup',
    builtin('wakeup', 'one', 1, 1, ([loop]) => {
      clock.woken.add(loop as object);
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
    'report',
    builtin('report', 'one', 1, 1, ([message]) => {
      pyStr(message as PyValue);
      return None;
    })
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

function threadName(runtime: Runtime): string {
  const threading = runtime.modules.get('threading');
  const current = threading?.dict.get('current_thread');
  if (!current) return 'MainThread';
  return pyStr(getAttribute(callValue(current, []), 'name'));
}
