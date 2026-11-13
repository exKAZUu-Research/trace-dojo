import { monotonicNanoseconds, nanosecondsToSeconds, processNanoseconds, wallClockNanoseconds } from '../clock';
import { builtin } from '../define';
import { toIndex } from '../numbers';
import { callValue } from '../objects';
import type { Runtime } from '../runtime';
import {
  exceptionClassNamed,
  intClass,
  isInstanceOf,
  None,
  stringValue,
  typeError,
  typeName,
  valueError,
} from '../types';
import { PyError, type PyInstance, type PyValue } from '../values';

/** The `clk_id` constants of the reference CPython on macOS. */
const CLOCK_IDS: [string, bigint][] = [
  ['CLOCK_REALTIME', 0n],
  ['CLOCK_MONOTONIC_RAW', 4n],
  ['CLOCK_MONOTONIC_RAW_APPROX', 5n],
  ['CLOCK_MONOTONIC', 6n],
  ['CLOCK_UPTIME_RAW', 8n],
  ['CLOCK_UPTIME_RAW_APPROX', 9n],
  ['CLOCK_PROCESS_CPUTIME_ID', 12n],
  ['CLOCK_THREAD_CPUTIME_ID', 16n],
];

const MICROSECOND = 1.0000000000000002e-6;
const MACH_TICK = 4.2000000000000006e-8;
/** `clock_getres` of each clock on the reference macOS. */
const RESOLUTIONS = new Map<bigint, number>([
  [0n, MICROSECOND],
  [4n, MACH_TICK],
  [5n, MACH_TICK],
  [6n, MICROSECOND],
  [8n, MACH_TICK],
  [9n, MACH_TICK],
  [12n, MICROSECOND],
  [16n, MACH_TICK],
]);

/** What `time.get_clock_info` reports on the reference macOS: implementation, monotonic, adjustable, resolution. */
const CLOCK_INFO: Record<string, [string, boolean, boolean, number]> = {
  monotonic: ['mach_absolute_time()', true, false, 4.166666666666666e-8],
  perf_counter: ['mach_absolute_time()', true, false, 4.166666666666666e-8],
  process_time: ['clock_gettime(CLOCK_PROCESS_CPUTIME_ID)', true, false, MICROSECOND],
  thread_time: ['clock_gettime(CLOCK_THREAD_CPUTIME_ID)', true, false, MACH_TICK],
  time: ['clock_gettime(CLOCK_REALTIME)', false, true, MICROSECOND],
};

/**
 * The `clock_*` functions and constants of `time` and `get_clock_info`, which read the run's clocks: the wall clock
 * for CLOCK_REALTIME, the process clock for the CPU-time clocks, and the monotonic clock for the others.
 */
export function timeClocks(runtime: Runtime): [string, PyValue][] {
  const read = (id: PyValue): bigint => {
    const clock = clockId(id, (value) => `clk_id should be integer, not ${typeName(value)}`);
    if (clock === 0n) return wallClockNanoseconds(runtime);
    if (clock === 12n || clock === 16n) return processNanoseconds(runtime);
    return monotonicNanoseconds(runtime);
  };
  return [
    ...CLOCK_IDS,
    ['_STRUCT_TM_ITEMS', 11n],
    ['clock_gettime', builtin('clock_gettime', 'one', 1, 1, ([id]) => nanosecondsToSeconds(read(id)))],
    ['clock_gettime_ns', builtin('clock_gettime_ns', 'one', 1, 1, ([id]) => read(id))],
    ['clock_getres', builtin('clock_getres', 'one', 1, 1, ([id]) => RESOLUTIONS.get(clockId(id)) as number)],
    ['clock_settime', builtin('clock_settime', 'expected', 2, 2, ([id]) => setTime(id))],
    ['clock_settime_ns', builtin('clock_settime_ns', 'expected', 2, 2, ([id]) => setTime(id))],
    ['get_clock_info', builtin('get_clock_info', 'one', 1, 1, ([name]) => clockInfo(runtime, name))],
    // The time zone of a run never changes, so there is nothing to read again.
    ['tzset', builtin('tzset', 'none', 0, 0, () => None)],
  ];
}

function clockId(
  value: PyValue,
  typeMessage = (bad: PyValue): string => `'${typeName(bad)}' object cannot be interpreted as an integer`
): bigint {
  if (!isInstanceOf(value, intClass)) throw typeError(typeMessage(value));
  const id = toIndex(value);
  if (!RESOLUTIONS.has(id)) throw osError(22n, 'Invalid argument');
  return id;
}

/** Setting a clock needs privileges a program here never has, so it fails as it does for a user in CPython. */
function setTime(id: PyValue): PyValue {
  clockId(id);
  throw osError(1n, 'Operation not permitted');
}

function osError(errno: bigint, message: string): PyError {
  return new PyError(callValue(exceptionClassNamed('OSError'), [errno, message]) as PyInstance);
}

function clockInfo(runtime: Runtime, name: PyValue): PyValue {
  name = stringValue(name) ?? name;
  if (typeof name !== 'string') throw typeError(`get_clock_info() argument 1 must be str, not ${typeName(name)}`);
  const info = CLOCK_INFO[name];
  if (info === undefined) throw valueError('unknown clock');
  const [implementation, monotonic, adjustable, resolution] = info;
  const namespace = runtime.importModule('types').dict.get('SimpleNamespace') as PyValue;
  return callValue(
    namespace,
    [],
    new Map<string, PyValue>([
      ['implementation', implementation],
      ['monotonic', monotonic],
      ['adjustable', adjustable],
      ['resolution', resolution],
    ])
  );
}
