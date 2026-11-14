import type { Runtime } from './runtime';

// 2026-01-01T00:00:00Z keeps wall-clock timestamps modern (e.g. zipfile rejects pre-1980 dates) while deterministic across runs.
const WALL_CLOCK_EPOCH_NANOSECONDS = 1_767_225_600_000_000_000n;

const elapsedNanoseconds = new WeakMap<Runtime, bigint>();
const cpuNanoseconds = new WeakMap<Runtime, bigint>();

/** Local time zone of every run (Japan has had no daylight saving time since 1951). */
export const LOCAL_ZONE = { name: 'JST', offsetSeconds: 9 * 3600 };

/** Converts nanoseconds to seconds without losing low bits on epoch-scale bigints above `Number.MAX_SAFE_INTEGER`. */
export function nanosecondsToSeconds(nanoseconds: bigint): number {
  return Number(nanoseconds / 1_000_000_000n) + Number(nanoseconds % 1_000_000_000n) * 1e-9;
}

export function wallClockNanoseconds(runtime: Runtime): bigint {
  return WALL_CLOCK_EPOCH_NANOSECONDS + tick(elapsedNanoseconds, runtime);
}

/**
 * Shared monotonic clock of `time.monotonic`, `time.perf_counter`, `_thread._monotonic`, and `asyncio` `loop.time()`.
 * Advancing by 1 ns per read orders same-delay `asyncio` timers in creation order while keeping `time.monotonic()`
 * and `loop.time()` on the same epoch.
 */
export function monotonicNanoseconds(runtime: Runtime): bigint {
  return tick(elapsedNanoseconds, runtime);
}

/** Deterministic CPU-time clock of `time.process_time` and `time.thread_time`, which virtual sleep does not advance. */
export function processNanoseconds(runtime: Runtime): bigint {
  return tick(cpuNanoseconds, runtime);
}

function tick(table: WeakMap<Runtime, bigint>, runtime: Runtime): bigint {
  const next = (table.get(runtime) ?? 0n) + 1n;
  table.set(runtime, next);
  return next;
}

/** Reads the run's virtual clock without ticking, for scheduler deadline checks and test-runner durations. */
export function virtualNanoseconds(runtime: Runtime): bigint {
  return elapsedNanoseconds.get(runtime) ?? 0n;
}

export function sleepFor(runtime: Runtime, nanoseconds: bigint): void {
  elapsedNanoseconds.set(runtime, virtualNanoseconds(runtime) + nanoseconds);
}
