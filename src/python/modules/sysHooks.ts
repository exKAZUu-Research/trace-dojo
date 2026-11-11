import { builtin } from '../define';
import { callValue, isCallable } from '../objects';
import type { Runtime } from '../runtime';
import { newTuple, None, tupleClass, typeError, typeName, valueError } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { PyTuple, type PyValue } from '../values';
import { realArgument } from './math';
import { structSeq } from './sysInfo';

/** `sys.copyright` of the reference CPython. */
export const COPYRIGHT = `Copyright (c) 2001 Python Software Foundation.
All Rights Reserved.

Copyright (c) 2000 BeOpen.com.
All Rights Reserved.

Copyright (c) 1995-2001 Corporation for National Research Initiatives.
All Rights Reserved.

Copyright (c) 1991-1995 Stichting Mathematisch Centrum, Amsterdam.
All Rights Reserved.`;

const THREAD_INFO = structSeq('thread_info', [
  ['name', 'pthread'],
  ['lock', 'mutex+cond'],
  ['version', None],
]);
const ASYNCGEN_HOOKS = structSeq(
  'asyncgen_hooks',
  [
    ['firstiter', None],
    ['finalizer', None],
  ],
  { module: 'builtins' }
);
// The type of what CPython passes sys.unraisablehook, which no program here receives, but which is a subclass of tuple.
structSeq(
  'UnraisableHookArgs',
  ['exc_type', 'exc_value', 'exc_traceback', 'err_msg', 'object'].map((field) => [field, None]),
  { module: 'builtins' }
);

/** The attributes of `sys` about hooks, tracing, threads, and the interpreter's state. */
export function sysHooks(runtime: Runtime): [string, PyValue][] {
  const breakpointhook = builtin('breakpointhook', 'expected', 0, Number.POSITIVE_INFINITY, () => {
    throw new UnsupportedFeatureError('デバッガ（breakpoint()）');
  });
  let dlopenFlags: PyValue = 2n;
  let originTrackingDepth = 0n;
  return [
    ['__breakpointhook__', breakpointhook],
    ['breakpointhook', breakpointhook],
    ['__stdout__', runtime.standardStream('stdout')],
    ['__stderr__', runtime.standardStream('stderr')],
    ['abiflags', ''],
    ['copyright', COPYRIGHT],
    ['dont_write_bytecode', true],
    ['pycache_prefix', None],
    ['thread_info', THREAD_INFO],
    ['_git', newTuple(['CPython', '', ''])],
    ['_framework', ''],
    // A program here can install no trace or profile function, so none is ever set.
    ['gettrace', builtin('gettrace', 'none', 0, 0, () => None)],
    ['getprofile', builtin('getprofile', 'none', 0, 0, () => None)],
    ['is_finalizing', builtin('is_finalizing', 'none', 0, 0, () => false)],
    ['is_remote_debug_enabled', builtin('is_remote_debug_enabled', 'none', 0, 0, () => true)],
    ['is_stack_trampoline_active', builtin('is_stack_trampoline_active', 'none', 0, 0, () => false)],
    ['_is_gil_enabled', builtin('_is_gil_enabled', 'none', 0, 0, () => true)],
    ['_clear_internal_caches', builtin('_clear_internal_caches', 'none', 0, 0, () => None)],
    [
      '_clear_type_cache',
      builtin('_clear_type_cache', 'none', 0, 0, () => {
        const warn = runtime.importModule('warnings').dict.get('warn') as PyValue;
        const message =
          'sys._clear_type_cache() is deprecated and scheduled for removal in a future version. Use ' +
          'sys._clear_internal_caches() instead.';
        callValue(warn, [message, runtime.exceptionClass('DeprecationWarning')]);
        return None;
      }),
    ],
    ['getfilesystemencodeerrors', builtin('getfilesystemencodeerrors', 'none', 0, 0, () => 'surrogateescape')],
    ['getdlopenflags', builtin('getdlopenflags', 'none', 0, 0, () => dlopenFlags)],
    [
      'setdlopenflags',
      builtin('setdlopenflags', 'one', 1, 1, ([flags]) => {
        if (typeof flags !== 'bigint' && typeof flags !== 'boolean') {
          throw typeError(`'${typeName(flags)}' object cannot be interpreted as an integer`);
        }
        dlopenFlags = BigInt(flags);
        return None;
      }),
    ],
    ['call_tracing', builtin('call_tracing', 'expected', 2, 2, ([fn, args]) => callTracing(fn, args))],
    ['getswitchinterval', builtin('getswitchinterval', 'none', 0, 0, () => runtime.switchInterval * 1e-6)],
    [
      'setswitchinterval',
      builtin('sys.setswitchinterval', 'one', 1, 1, ([interval]) => setSwitchInterval(runtime, interval)),
    ],
    ['get_asyncgen_hooks', builtin('get_asyncgen_hooks', 'none', 0, 0, () => asyncgenHooks(runtime))],
    [
      'set_asyncgen_hooks',
      builtin('set_asyncgen_hooks', 'takes', 0, 2, (args, kwargs) => setAsyncgenHooks(args, kwargs), {
        keywords: ['firstiter', 'finalizer'],
      }),
    ],
    [
      'get_coroutine_origin_tracking_depth',
      builtin('get_coroutine_origin_tracking_depth', 'none', 0, 0, () => originTrackingDepth),
    ],
    [
      'set_coroutine_origin_tracking_depth',
      builtin(
        'set_coroutine_origin_tracking_depth',
        'takes',
        0,
        1,
        (args, kwargs) => {
          originTrackingDepth = coroutineOriginDepth(args[0] ?? kwargs?.get('depth'));
          return None;
        },
        { keywords: ['depth'] }
      ),
    ],
  ];
}

/** `sys.call_tracing(func, args)`, which calls `func(*args)`; tracing is never on here. */
function callTracing(fn: PyValue, args: PyValue): PyValue {
  if (!(args instanceof PyTuple) || !(args.cls === tupleClass || args.cls.isSubclassOf(tupleClass))) {
    throw typeError(`call_tracing() argument 2 must be tuple, not ${typeName(args)}`);
  }
  return callValue(fn, [...args.items]);
}

/**
 * `sys.setswitchinterval`, which keeps the interval in whole microseconds as CPython does. The thread scheduler
 * scales the operations a thread runs before it may be switched out by the interval.
 */
function setSwitchInterval(runtime: Runtime, value: PyValue): PyValue {
  const interval = realArgument(value);
  if (interval <= 0) throw valueError('switch interval must be strictly positive');
  // CPython converts to an unsigned long, which saturates at its limit (2 ** 64 as a float) and turns NaN into 0.
  const microseconds = Number.isNaN(interval) ? 0 : Math.min(Math.trunc(interval * 1e6), 2 ** 64);
  runtime.switchInterval = microseconds;
  return None;
}

function asyncgenHooks(runtime: Runtime): PyValue {
  // CPython's event loop installs its own hooks while it runs, which this grader's asyncio does not have.
  const asyncio = runtime.modules.get('asyncio')?.dict.get('_get_running_loop');
  if (asyncio !== undefined && callValue(asyncio, []) !== None) {
    throw new UnsupportedFeatureError(
      'asyncio のイベントループが登録する非同期ジェネレータのフック（sys.get_asyncgen_hooks()）'
    );
  }
  return ASYNCGEN_HOOKS;
}

function setAsyncgenHooks(args: PyValue[], kwargs: Map<string, PyValue> | undefined): PyValue {
  for (const [index, name] of ['firstiter', 'finalizer'].entries()) {
    const hook = args[index] ?? kwargs?.get(name);
    if (hook === undefined || hook === None) continue;
    if (!isCallable(hook)) throw typeError(`callable ${name} expected, got ${typeName(hook)}`);
    throw new UnsupportedFeatureError('非同期ジェネレータのフック（sys.set_asyncgen_hooks()）');
  }
  return None;
}

function coroutineOriginDepth(value: PyValue | undefined): bigint {
  if (value === undefined) {
    throw typeError("set_coroutine_origin_tracking_depth() missing required argument 'depth' (pos 1)");
  }
  if (typeof value !== 'bigint' && typeof value !== 'boolean') {
    throw typeError(`'${typeName(value)}' object cannot be interpreted as an integer`);
  }
  const depth = BigInt(value);
  if (depth < 0n) throw valueError('depth must be >= 0');
  if (depth > 0n) throw new UnsupportedFeatureError('コルーチンの作成元の記録（cr_origin）');
  return depth;
}
