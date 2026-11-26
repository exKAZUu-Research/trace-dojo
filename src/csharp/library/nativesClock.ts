import { defineNatives, type NativeCall } from '../natives';
import { CsObject, CsStruct, type Value } from '../values';
import { formatTimeSpan } from './nativesTime';
import { failOutOfRange, libraryType } from './support';

/**
 * The clocks that programs read to time their code: Stopwatch, `Environment.TickCount`, and `Thread.Sleep`. They read
 * the scheduler's clock, the real time plus the virtual time that sleeps and timers skipped, so a sleep of 50 ms
 * returns at once but a Stopwatch around it shows at least 50 ms, as on .NET.
 */

const STOPWATCH = 'System.Diagnostics.Stopwatch';
/** Stopwatch ticks are nanoseconds, as `Stopwatch.Frequency` is 10^9 on Unix. */
const NANOSECONDS_PER_TIME_SPAN_TICK = 100n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/** The scheduler's clock in Stopwatch ticks. */
function timestamp(call: NativeCall): bigint {
  return BigInt(Math.round(call.frame.runtime.scheduler.clock() * 1_000_000));
}

interface StopwatchState {
  /** The timestamp of the last start while it runs. */
  startedAt: bigint | undefined;
  /** The ticks of the finished runs since the last reset. */
  elapsed: bigint;
}

function stopwatchOf(receiver: Value): StopwatchState {
  return (receiver as CsObject).native as StopwatchState;
}

function elapsedTicks(call: NativeCall, receiver: Value): bigint {
  const state = stopwatchOf(receiver);
  return state.elapsed + (state.startedAt === undefined ? 0n : timestamp(call) - state.startedAt);
}

function timeSpan(call: NativeCall, nanoseconds: bigint): CsStruct {
  return new CsStruct(libraryType(call, 'System.TimeSpan'), [nanoseconds / NANOSECONDS_PER_TIME_SPAN_TICK]);
}

function newStopwatch(): StopwatchState {
  return { startedAt: undefined, elapsed: 0n };
}

/** `Thread.Sleep`: the scheduler's sleep, which runs the queued work and due timers and moves the clock forward. */
function sleep(call: NativeCall, milliseconds: number, paramName: string): void {
  if (milliseconds < -1)
    failOutOfRange(
      call,
      paramName,
      `${paramName} ('${milliseconds}') must be greater than or equal to '-1'.`,
      String(milliseconds)
    );
  const scheduler = call.frame.runtime.scheduler;
  if (milliseconds === -1) scheduler.runUntil(() => false);
  else if (milliseconds > 0) scheduler.sleep(milliseconds);
}

defineNatives({
  [`${STOPWATCH}..ctor`]: (_call, receiver) => {
    (receiver as CsObject).native = newStopwatch();
  },
  [`${STOPWATCH}.StartNew`]: (call) => {
    const stopwatch = new CsObject(libraryType(call, STOPWATCH), []);
    stopwatch.native = { startedAt: timestamp(call), elapsed: 0n } satisfies StopwatchState;
    return stopwatch;
  },
  [`${STOPWATCH}.get_IsRunning`]: (_call, receiver) => stopwatchOf(receiver).startedAt !== undefined,
  [`${STOPWATCH}.get_ElapsedTicks`]: (call, receiver) => elapsedTicks(call, receiver),
  [`${STOPWATCH}.get_ElapsedMilliseconds`]: (call, receiver) =>
    elapsedTicks(call, receiver) / NANOSECONDS_PER_MILLISECOND,
  [`${STOPWATCH}.get_Elapsed`]: (call, receiver) => timeSpan(call, elapsedTicks(call, receiver)),
  [`${STOPWATCH}.Start`]: (call, receiver) => {
    const state = stopwatchOf(receiver);
    state.startedAt ??= timestamp(call);
  },
  [`${STOPWATCH}.Stop`]: (call, receiver) => {
    const state = stopwatchOf(receiver);
    state.elapsed = elapsedTicks(call, receiver);
    state.startedAt = undefined;
  },
  [`${STOPWATCH}.Reset`]: (_call, receiver) => {
    Object.assign(stopwatchOf(receiver), newStopwatch());
  },
  [`${STOPWATCH}.Restart`]: (call, receiver) => {
    Object.assign(stopwatchOf(receiver), { startedAt: timestamp(call), elapsed: 0n });
  },
  [`${STOPWATCH}.GetTimestamp`]: (call) => timestamp(call),
  [`${STOPWATCH}.GetElapsedTime(long)`]: (call, _receiver, [start]) =>
    timeSpan(call, timestamp(call) - (start as bigint)),
  [`${STOPWATCH}.GetElapsedTime(long, long)`]: (call, _receiver, [start, end]) =>
    timeSpan(call, (end as bigint) - (start as bigint)),
  [`${STOPWATCH}.ToString`]: (call, receiver) =>
    formatTimeSpan(call.frame.runtime, timeSpan(call, elapsedTicks(call, receiver)), undefined),

  // .NET counts from the machine's start, which the run's start stands for; the 32-bit count wraps around.
  'System.Environment.get_TickCount': (call) => {
    const ticks = Math.floor(call.frame.runtime.scheduler.clock()) % 2 ** 32;
    return ticks >= 2 ** 31 ? ticks - 2 ** 32 : ticks;
  },
  'System.Environment.get_TickCount64': (call) => BigInt(Math.floor(call.frame.runtime.scheduler.clock())),

  'System.Threading.Thread.Sleep(int)': (call, _receiver, [milliseconds]) => {
    sleep(call, milliseconds as number, 'millisecondsTimeout');
  },
  'System.Threading.Thread.Sleep(TimeSpan)': (call, _receiver, [span]) => {
    sleep(call, Number(((span as CsStruct).fields[0] as bigint) / 10_000n), 'timeout');
  },
});
