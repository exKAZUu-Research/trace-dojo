import { RustPanic } from '../runtime';
import {
  BorrowGuard,
  CellBox,
  ChannelEnd,
  DONE,
  DurationValue,
  EnumValue,
  FnValue,
  IterValue,
  SharedBox,
  StructValue,
  ThreadHandle,
  UNIT_VALUE,
  type Value,
} from '../values';
import { call, define, deref, err, type NativeContext, none, ok, panic, some } from './support';

/**
 * The threads of a run, which run one at a time by a fixed rule, since the interpreter runs one thread of JavaScript:
 * a spawned thread waits until a thread joins it, receives from a channel it may send to, sleeps, or yields, and then
 * the threads waiting run to their ends in the order they were spawned. Threads still waiting when `main` ends never
 * run, as the process ends with `main`.
 */
export class Scheduler {
  private readonly threads: ThreadHandle[] = [];
  private nextId = 2;
  /** The ids of the threads running, the innermost last; `main` is thread 1. */
  readonly running: number[] = [1];
  private panicked = false;

  spawn(run: () => Value): ThreadHandle {
    const thread = new ThreadHandle(this.nextId++, run);
    this.threads.push(thread);
    return thread;
  }

  /** Runs a thread to its end unless it has run, reporting a panic that ends it as Rust does. */
  run(ctx: NativeContext, thread: ThreadHandle): void {
    if (thread.state === 'running') panic(ctx, 'デッドロックしました（実行中のスレッドの終わりを待っています）。');
    if (thread.state !== 'pending') return;
    thread.state = 'running';
    this.running.push(thread.id);
    try {
      thread.result = thread.run();
      thread.state = 'done';
    } catch (error) {
      if (!(error instanceof RustPanic)) throw error;
      thread.state = 'panicked';
      thread.result = error.message;
      ctx.runtime.write('stderr', this.panicText(error, thread.id));
    } finally {
      this.running.pop();
    }
  }

  /** Runs the thread spawned first among those waiting, telling whether there was one. */
  runNext(ctx: NativeContext): boolean {
    const next = this.threads.find((thread) => thread.state === 'pending');
    if (!next) return false;
    this.run(ctx, next);
    return true;
  }

  /** Runs every thread waiting, as a thread that sleeps or yields lets them, telling whether one ran. */
  runAll(ctx: NativeContext): boolean {
    let ran = false;
    while (this.runNext(ctx)) ran = true;
    return ran;
  }

  private panicText(error: RustPanic, id: number): string {
    const { row, col, displayCol } = error.span;
    const note = this.panicked ? '' : '\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace';
    this.panicked = true;
    return `\nthread '<unnamed>' (${id}) panicked at src/main.rs:${row + 1}:${displayCol ?? col}:\n${error.message}${note}\n`;
  }
}

function scheduler(ctx: NativeContext): Scheduler {
  ctx.runtime.scheduler ??= new Scheduler();
  return ctx.runtime.scheduler;
}

function spawn(ctx: NativeContext, f: Value): ThreadHandle {
  return scheduler(ctx).spawn(() => {
    const result = call(ctx, f, []);
    // The thread owns its closure, whose captured values go when it ends.
    const closure = deref(f);
    if (closure instanceof FnValue) closure.dropCaptures?.();
    return result;
  });
}

/** `JoinHandle::join`: the thread's result, or `Err` of what its panic carried. */
function join(ctx: NativeContext, handle: Value): Value {
  const thread = deref(handle) as ThreadHandle;
  scheduler(ctx).run(ctx, thread);
  return thread.state === 'panicked' ? err(ctx, thread.result) : ok(ctx, thread.result);
}

function lock(ctx: NativeContext, target: CellBox, mutable: boolean): Value {
  // The thread holding the lock waits below this one, so no thread can free it.
  if (mutable ? target.borrows !== 0 : target.borrows < 0) {
    panic(ctx, 'デッドロックしました（ロックを持っているスレッドが、このスレッドを待っています）。');
  }
  target.borrows = mutable ? -1 : target.borrows + 1;
  const guard = new BorrowGuard(target, mutable);
  ctx.runtime.liveGuards.push(guard);
  return ok(ctx, guard);
}

/**
 * `Condvar::wait` and `wait_while`: the lock is let go while the threads waiting run to their ends, as one of them
 * would notify, and then taken again; with no thread to run, the wait would never end.
 */
function waitOnCondvar(ctx: NativeContext, held: Value, waiting: (place: Value) => boolean, once: boolean): Value {
  const guard = deref(held) as BorrowGuard;
  if (!once && !waiting(guard.place())) return ok(ctx, guard);
  guard.release();
  for (;;) {
    if (!scheduler(ctx).runAll(ctx))
      panic(ctx, 'デッドロックしました（通知するスレッドがないまま、Condvar を待っています）。');
    const relocked = (lock(ctx, guard.cell, true) as EnumValue).fields[0] as BorrowGuard;
    if (once || !waiting(relocked.place())) return ok(ctx, relocked);
    relocked.release();
  }
}

/** `Receiver::recv`: a message, which the threads waiting run to send, or none once none can. */
function receive(ctx: NativeContext, receiver: Value): Value | undefined {
  const { queue } = deref(receiver) as ChannelEnd;
  while (queue.length === 0) {
    if (!scheduler(ctx).runNext(ctx)) return undefined;
  }
  return queue.shift();
}

export function receiverIter(ctx: NativeContext, receiver: Value, waits: boolean): IterValue {
  return new IterValue(() => {
    const { queue } = deref(receiver) as ChannelEnd;
    if (!waits) return queue.length > 0 ? (queue.shift() as Value) : DONE;
    const message = receive(ctx, receiver);
    return message ?? DONE;
  });
}

function duration(value: Value): bigint {
  return (deref(value) as DurationValue).nanos;
}

const NANOS = 1_000_000_000n;

/** `Duration`'s `Debug`: `1.5s`, `250ms`, `10µs`, or `7ns`, with no trailing zeros. */
export function durationDebug(value: Value, precision: number | undefined): string {
  const nanos = duration(value);
  const [unit, scale] =
    nanos >= NANOS
      ? ['s', NANOS]
      : nanos >= 1_000_000n
        ? ['ms', 1_000_000n]
        : nanos >= 1000n
          ? ['µs', 1000n]
          : ['ns', 1n];
  const whole = nanos / scale;
  const fraction = (nanos % scale).toString().padStart(scale.toString().length - 1, '0');
  const digits =
    precision === undefined ? fraction.replace(/0+$/, '') : fraction.slice(0, precision).padEnd(precision, '0');
  return `${whole}${digits ? `.${digits}` : ''}${unit}`;
}

function threadId(ctx: NativeContext, id: number): Value {
  return new StructValue(threadIdDef(ctx), [BigInt(id)]);
}

function threadIdDef(ctx: NativeContext): StructValue['def'] {
  const thread = ctx.interp.program.std.types.get('thread');
  const module = thread?.binding.kind === 'mod' ? thread.binding.module : undefined;
  const id = module?.types.get('ThreadId')?.binding;
  if (id?.kind !== 'adt') throw new Error('No ThreadId');
  return id.def;
}

define({
  'std::thread::spawn': ([f], ctx) => spawn(ctx, f),
  'JoinHandle<_>::join': ([handle], ctx) => join(ctx, handle),
  'JoinHandle<_>::is_finished': ([handle]) => (deref(handle) as ThreadHandle).state !== 'pending',
  'JoinHandle<_>::thread': ([handle]) => (deref(handle) as ThreadHandle).id,
  'ScopedJoinHandle<_>::join': ([handle], ctx) => join(ctx, handle),
  'ScopedJoinHandle<_>::is_finished': ([handle]) => (deref(handle) as ThreadHandle).state !== 'pending',
  'Scope::spawn': ([, f], ctx) => spawn(ctx, f),
  'std::thread::scope': ([f], ctx) => {
    const result = call(ctx, f, [UNIT_VALUE]);
    // The scope waits for the threads it spawned, which have not run yet.
    scheduler(ctx).runAll(ctx);
    return result;
  },
  'std::thread::sleep': (_args, ctx) => {
    scheduler(ctx).runAll(ctx);
    return UNIT_VALUE;
  },
  'std::thread::yield_now': (_args, ctx) => {
    scheduler(ctx).runAll(ctx);
    return UNIT_VALUE;
  },
  'std::thread::current': (_args, ctx) => scheduler(ctx).running.at(-1) ?? 1,
  'Thread::id': ([thread], ctx) => threadId(ctx, Number(deref(thread))),
  'Thread::name': ([thread], ctx) => (deref(thread) === 1 ? some(ctx, 'main') : none(ctx)),
  'Arc<_>::new': ([value], ctx) => {
    ctx.interp.dropper.activate();
    return new SharedBox(value);
  },
  'Arc<_>::strong_count': ([arc]) => BigInt((deref(arc) as SharedBox).strong),
  'Arc<_>::ptr_eq': ([a, b]) => deref(a) === deref(b),
  'Arc<_>::as_ref': ([arc]) => (deref(arc) as SharedBox).value,
  'Arc<_>::try_unwrap': ([arc], ctx) => {
    const box = deref(arc) as SharedBox;
    if (box.strong !== 1) return err(ctx, box);
    box.strong = 0;
    return ok(ctx, box.value);
  },
  'Arc<_>::into_inner': ([arc], ctx) => {
    const box = deref(arc) as SharedBox;
    box.strong--;
    return box.strong === 0 ? some(ctx, box.value) : none(ctx);
  },
  'Mutex<_>::new': ([value], ctx) => {
    ctx.interp.dropper.activate();
    return new CellBox(value);
  },
  'Mutex<_>::lock': ([self], ctx) => lock(ctx, deref(self) as CellBox, true),
  'Mutex<_>::try_lock': ([self], ctx) => {
    const target = deref(self) as CellBox;
    if (target.borrows !== 0) return err(ctx, UNIT_VALUE);
    return lock(ctx, target, true);
  },
  'Mutex<_>::into_inner': ([self], ctx) => ok(ctx, (deref(self) as CellBox).value),
  'Mutex<_>::get_mut': ([self], ctx) => {
    const target = deref(self) as CellBox;
    return ok(ctx, { isPlace: true, get: () => target.value, set: (value: Value) => (target.value = value) });
  },
  'Mutex<_>::is_poisoned': () => false,
  'Condvar::new': (_args, ctx) => new StructValue(ctx.interp.program.adtDef('Condvar'), [UNIT_VALUE]),
  'Condvar::wait': ([, guard], ctx) => waitOnCondvar(ctx, guard, () => false, true),
  'Condvar::wait_while': ([, guard, condition], ctx) =>
    waitOnCondvar(ctx, guard, (place) => call(ctx, condition, [place]) === true, false),
  'Condvar::notify_one': () => UNIT_VALUE,
  'Condvar::notify_all': () => UNIT_VALUE,
  'RwLock<_>::new': ([value], ctx) => {
    ctx.interp.dropper.activate();
    return new CellBox(value);
  },
  'RwLock<_>::read': ([self], ctx) => lock(ctx, deref(self) as CellBox, false),
  'RwLock<_>::write': ([self], ctx) => lock(ctx, deref(self) as CellBox, true),
  'RwLock<_>::into_inner': ([self], ctx) => ok(ctx, (deref(self) as CellBox).value),
  'RwLock<_>::get_mut': ([self], ctx) => {
    const target = deref(self) as CellBox;
    return ok(ctx, { isPlace: true, get: () => target.value, set: (value: Value) => (target.value = value) });
  },
  'PoisonError<_>::into_inner': ([error]) => (deref(error) as StructValue).fields[0],
  'std::sync::mpsc::channel': () => {
    const channel = new ChannelEnd([]);
    return [channel, channel];
  },
  'Sender<_>::send': ([sender, message], ctx) => {
    (deref(sender) as ChannelEnd).queue.push(message);
    return ok(ctx, UNIT_VALUE);
  },
  'Receiver<_>::recv': ([receiver], ctx) => {
    const message = receive(ctx, receiver);
    return message === undefined ? err(ctx, new StructValue(recvErrorDef(ctx), [])) : ok(ctx, message);
  },
  'Receiver<_>::try_recv': ([receiver], ctx) => {
    const { queue } = deref(receiver) as ChannelEnd;
    if (queue.length > 0) return ok(ctx, queue.shift());
    // A message may come from a thread waiting to run; with none, nothing will send.
    const def = tryRecvErrorDef(ctx);
    const pending = scheduler(ctx).runNext(ctx);
    if (pending && queue.length > 0) return ok(ctx, queue.shift());
    return err(ctx, new EnumValue(def, pending ? 0 : 1, []));
  },
  'Receiver<_>::iter': ([receiver], ctx) => receiverIter(ctx, receiver, true),
  'Receiver<_>::try_iter': ([receiver], ctx) => receiverIter(ctx, receiver, false),
  'Duration::new': ([secs, nanos]) => new DurationValue((secs as bigint) * NANOS + (nanos as bigint)),
  'Duration::from_secs': ([secs]) => new DurationValue((secs as bigint) * NANOS),
  'Duration::from_millis': ([millis]) => new DurationValue((millis as bigint) * 1_000_000n),
  'Duration::from_micros': ([micros]) => new DurationValue((micros as bigint) * 1000n),
  'Duration::from_nanos': ([nanos]) => new DurationValue(nanos as bigint),
  'Duration::from_secs_f64': ([secs]) => new DurationValue(BigInt(Math.round((secs as number) * 1e9))),
  'Duration::as_secs': ([d]) => duration(d) / NANOS,
  'Duration::as_millis': ([d]) => duration(d) / 1_000_000n,
  'Duration::as_micros': ([d]) => duration(d) / 1000n,
  'Duration::as_nanos': ([d]) => duration(d),
  'Duration::as_secs_f64': ([d]) => Number(duration(d)) / 1e9,
  'Duration::subsec_millis': ([d]) => (duration(d) % NANOS) / 1_000_000n,
  'Duration::subsec_nanos': ([d]) => duration(d) % NANOS,
  'Duration::checked_add': ([a, b], ctx) => some(ctx, new DurationValue(duration(a) + duration(b))),
  'Duration::checked_sub': ([a, b], ctx) =>
    duration(a) >= duration(b) ? some(ctx, new DurationValue(duration(a) - duration(b))) : none(ctx),
  'Duration::mul_f64': ([d, factor]) => new DurationValue(BigInt(Math.round(Number(duration(d)) * (factor as number)))),
  'const:ZERO': () => new DurationValue(0n),
  'Duration::add': ([a, b]) => new DurationValue(duration(a) + duration(b)),
  'Duration::sub': ([a, b], ctx) => {
    if (duration(a) < duration(b)) panic(ctx, 'overflow when subtracting durations');
    return new DurationValue(duration(a) - duration(b));
  },
  'Duration::mul': ([d, factor]) => new DurationValue(duration(d) * (factor as bigint)),
});

function recvErrorDef(ctx: NativeContext): StructValue['def'] {
  return mpscDef(ctx, 'RecvError');
}

function tryRecvErrorDef(ctx: NativeContext): StructValue['def'] {
  return mpscDef(ctx, 'TryRecvError');
}

function mpscDef(ctx: NativeContext, name: string): StructValue['def'] {
  const sync = ctx.interp.program.std.types.get('sync');
  const syncModule = sync?.binding.kind === 'mod' ? sync.binding.module : undefined;
  const mpsc = syncModule?.types.get('mpsc');
  const module = mpsc?.binding.kind === 'mod' ? mpsc.binding.module : undefined;
  const binding = module?.types.get(name)?.binding;
  if (binding?.kind !== 'adt') throw new Error(`No ${name}`);
  return binding.def;
}
