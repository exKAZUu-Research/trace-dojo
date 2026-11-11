import type { Runtime } from './runtime';

/**
 * The clocks of a run. `time.sleep` must not hold the server's thread, so it advances a virtual offset instead of
 * waiting: the wall clock and the monotonic clocks read the host's clocks plus the time the program slept.
 */
const sleptNanoseconds = new WeakMap<Runtime, bigint>();

const nowNanoseconds = (milliseconds: number): bigint => BigInt(Math.round(milliseconds * 1000)) * 1000n;

function slept(runtime: Runtime): bigint {
  return sleptNanoseconds.get(runtime) ?? 0n;
}

/** Nanoseconds since the Unix epoch, as `time.time_ns()` reads them. */
export function wallClockNanoseconds(runtime: Runtime): bigint {
  return nowNanoseconds(performance.timeOrigin + performance.now()) + slept(runtime);
}

/** Nanoseconds of `time.monotonic_ns()` and `time.perf_counter_ns()`, which only differences give meaning to. */
export function monotonicNanoseconds(runtime: Runtime): bigint {
  return nowNanoseconds(performance.now()) + slept(runtime);
}

/**
 * Nanoseconds the run has slept, the only time that decides when sleeping threads and an event loop's timers wake, so
 * that the order in which they run never depends on how fast the host runs the program.
 */
export function virtualNanoseconds(runtime: Runtime): bigint {
  return slept(runtime);
}

/** Nanoseconds of `time.process_time_ns()`, which sleeping does not advance. */
export function processNanoseconds(): bigint {
  return nowNanoseconds(performance.now());
}

/** Advances the clocks of the run by `nanoseconds` at once, as if the program had waited. */
export function sleepFor(runtime: Runtime, nanoseconds: bigint): void {
  sleptNanoseconds.set(runtime, slept(runtime) + nanoseconds);
}

/** The local time zone of every run: Japan, where learners are, which has had no daylight saving time since 1951. */
export const LOCAL_ZONE = { name: 'JST', offsetSeconds: 9 * 3600 };
