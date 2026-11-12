import { currentRuntime } from './native';
import { type Blocked, type Frame, GoFatal, pushFrameRoots, type Runtime, type Suspending } from './runtime';
import { plainPanic } from './runtimeErrors';
import { Channel, type Value } from './values';

/**
 * Runs goroutines one at a time with fixed rules, since Go's own scheduler runs them in parallel in an order that
 * varies from run to run:
 *
 * - A goroutine runs until it blocks (on a channel, a lock, a WaitGroup, or a sleep) or ends; it is never preempted.
 * - Goroutines that can run wait in a queue in the order they became able to: `go` puts the new goroutine at its end,
 *   and so does waking a blocked goroutine.
 * - When no goroutine can run, time jumps to the earliest timer (a sleep, `time.After`, a ticker), whose goroutines
 *   or channels wake in the order they started waiting; `time.Sleep` never waits in real time.
 * - When no goroutine can run and no timer is pending, every goroutine is blocked for good, which Go reports as a
 *   deadlock.
 * - `select` takes the first ready case in the order written, where Go picks one at random.
 * - The program ends when `main` returns, without waiting for other goroutines, as in Go.
 */
export class Scheduler {
  private readonly runQueue: Goroutine[] = [];
  private readonly live = new Set<Goroutine>();
  private readonly timers: Timer[] = [];
  private nextGoroutineId = 1;
  private nextTimerSeq = 0;
  current: Goroutine | undefined;
  /** The virtual time in nanoseconds since the program started. */
  now = 0;

  constructor(private readonly runtime: Runtime) {
    runtime.scheduler = this;
  }

  /** Starts a goroutine that runs `body` with frames of its own. */
  spawn(body: (goroutine: Goroutine) => Suspending<unknown>): Goroutine {
    const goroutine = new Goroutine(this.nextGoroutineId++);
    goroutine.body = body(goroutine);
    this.live.add(goroutine);
    this.runQueue.push(goroutine);
    return goroutine;
  }

  /** Makes a blocked goroutine able to run, handing it `value` as the result of what it waited for. */
  ready(goroutine: Goroutine, value?: unknown): void {
    goroutine.resumeWith = value;
    goroutine.blocked = undefined;
    this.runQueue.push(goroutine);
  }

  /** Runs goroutines until `main` ends: the first goroutine spawned. */
  run(main: Goroutine): void {
    const { runtime } = this;
    for (;;) {
      const goroutine = this.runQueue.shift();
      if (!goroutine) {
        if (this.fireTimers()) continue;
        throw new GoFatal('fatal error: all goroutines are asleep - deadlock!');
      }
      this.current = goroutine;
      runtime.frames = goroutine.frames;
      const value = goroutine.resumeWith;
      goroutine.resumeWith = undefined;
      const next = (goroutine.body as Suspending<unknown>).next(value);
      if (next.done) {
        this.live.delete(goroutine);
        if (goroutine === main) return;
        continue;
      }
      goroutine.blocked = next.value;
    }
  }

  /** What garbage collection must follow: the frames of the live goroutines and what blocked ones hold. */
  roots(): unknown[] {
    const stack: unknown[] = [];
    for (const goroutine of this.live) {
      pushFrameRoots(goroutine.frames, stack);
      stack.push(...goroutine.holding);
    }
    for (const timer of this.timers) stack.push(timer.channel);
    return stack;
  }

  // Timers ----------------------------------------------------------------------------------------------------------

  /** Calls `fire` when the virtual time reaches `delay` nanoseconds from now. */
  addTimer(delay: number, fire: () => void, channel?: Channel): Timer {
    const timer: Timer = { when: this.now + Math.max(delay, 0), seq: this.nextTimerSeq++, fire, channel };
    this.timers.push(timer);
    return timer;
  }

  /** Stops a timer, telling whether it was still pending. */
  removeTimer(timer: Timer): boolean {
    const index = this.timers.indexOf(timer);
    if (index === -1) return false;
    this.timers.splice(index, 1);
    return true;
  }

  /** Advances the virtual time to the earliest timers and fires them, telling whether there were any. */
  private fireTimers(): boolean {
    if (this.timers.length === 0) return false;
    const when = Math.min(...this.timers.map((timer) => timer.when));
    const due = this.timers.filter((timer) => timer.when === when).toSorted((a, b) => a.seq - b.seq);
    for (const timer of due) this.timers.splice(this.timers.indexOf(timer), 1);
    this.now = when;
    for (const timer of due) timer.fire();
    return true;
  }

  // Blocking ----------------------------------------------------------------------------------------------------------

  /** Blocks the running goroutine until another one readies it, returning what that one handed over. */
  *park(reason: string, holding: unknown[] = []): Suspending<unknown> {
    const goroutine = this.current as Goroutine;
    goroutine.holding = holding;
    try {
      return yield { reason };
    } finally {
      goroutine.holding = [];
    }
  }

  /** `time.Sleep`: blocks the running goroutine until the virtual time advances by `duration` nanoseconds. */
  *sleep(duration: number): Suspending<void> {
    if (duration <= 0) return;
    const goroutine = this.current as Goroutine;
    this.addTimer(duration, () => this.ready(goroutine));
    yield* this.park('sleep');
  }

  /** `runtime.Gosched`: lets the other goroutines that can run go first. */
  *yieldTurn(): Suspending<void> {
    this.ready(this.current as Goroutine);
    yield { reason: 'runnable' };
  }
}

export class Goroutine {
  readonly frames: Frame[] = [];
  body: Suspending<unknown> | undefined;
  resumeWith: unknown;
  blocked: Blocked | undefined;
  /** Values that only the blocked goroutine holds, such as a value waiting to be sent. */
  holding: unknown[] = [];

  constructor(readonly id: number) {}
}

interface Timer {
  when: number;
  seq: number;
  fire: () => void;
  /** The channel that the timer sends to, which garbage collection must follow while the timer is pending. */
  channel?: Channel;
}

/** The scheduler of the running program, which only programs that use goroutines have. */
export function scheduler(): Scheduler {
  const found = currentRuntime().scheduler;
  if (!(found instanceof Scheduler)) throw new Error('The program runs without a scheduler');
  return found;
}

// Channels ------------------------------------------------------------------------------------------------------------

/**
 * A goroutine waiting on a channel: alone, or as one case of a select, which the first channel ready completes for
 * all its cases.
 */
interface Waiter {
  goroutine: Goroutine;
  value?: Value;
  select?: { done: boolean };
  index: number;
}

/** What a blocked channel operation receives when it wakes. */
interface Completed {
  index: number;
  value?: Value;
  ok: boolean;
  /** A sender woken because the channel closed, which panics. */
  closed?: boolean;
}

let nextChannelId = 0;

export function makeChannel(capacity: number, zero: () => Value): Channel {
  return new Channel(capacity, zero, nextChannelId++);
}

function takeWaiter(queue: unknown[]): Waiter | undefined {
  for (;;) {
    const waiter = queue.shift() as Waiter | undefined;
    if (!waiter) return undefined;
    if (!waiter.select) return waiter;
    if (waiter.select.done) continue;
    waiter.select.done = true;
    return waiter;
  }
}

/** Sends without blocking when it can, telling whether it did. */
function trySend(channel: Channel, value: Value): boolean {
  if (channel.closed) plainPanic('send on closed channel');
  const receiver = takeWaiter(channel.receivers);
  if (receiver) {
    scheduler().ready(receiver.goroutine, { index: receiver.index, value, ok: true } satisfies Completed);
    return true;
  }
  if (channel.buffer.length < channel.capacity) {
    channel.buffer.push(value);
    return true;
  }
  return false;
}

/** Receives without blocking when it can, giving the value and whether a send gave it, or undefined. */
function tryReceive(channel: Channel): [Value, boolean] | undefined {
  if (channel.buffer.length > 0) {
    const value = channel.buffer.shift();
    const sender = takeWaiter(channel.senders);
    if (sender) {
      channel.buffer.push(sender.value);
      scheduler().ready(sender.goroutine, { index: sender.index, ok: true } satisfies Completed);
    }
    return [value, true];
  }
  const sender = takeWaiter(channel.senders);
  if (sender) {
    scheduler().ready(sender.goroutine, { index: sender.index, ok: true } satisfies Completed);
    return [sender.value, true];
  }
  if (channel.closed) return [channel.zero(), false];
  return undefined;
}

/** `ch <- v`. */
export function* send(channel: Channel | undefined, value: Value): Suspending<void> {
  const running = scheduler();
  if (!channel) {
    yield* running.park('chan send (nil chan)');
    return;
  }
  if (trySend(channel, value)) return;
  const goroutine = running.current as Goroutine;
  channel.senders.push({ goroutine, value, index: 0 } satisfies Waiter);
  const completed = (yield* running.park('chan send', [value])) as Completed;
  if (completed.closed) plainPanic('send on closed channel');
}

/** `<-ch`, giving the value and whether a send gave it rather than the channel's closing. */
export function* receive(channel: Channel | undefined): Suspending<[Value, boolean]> {
  const running = scheduler();
  if (!channel) {
    yield* running.park('chan receive (nil chan)');
    return [undefined, false];
  }
  const received = tryReceive(channel);
  if (received) return received;
  channel.receivers.push({ goroutine: running.current as Goroutine, index: 0 } satisfies Waiter);
  const completed = (yield* running.park('chan receive')) as Completed;
  return [completed.value, completed.ok];
}

/** `close(ch)`: wakes the goroutines waiting to receive with zero values and makes those waiting to send panic. */
export function closeChannel(channel: Channel | undefined): void {
  if (!channel) plainPanic('close of nil channel');
  if (channel.closed) plainPanic('close of closed channel');
  channel.closed = true;
  const running = scheduler();
  for (let receiver = takeWaiter(channel.receivers); receiver; receiver = takeWaiter(channel.receivers)) {
    running.ready(receiver.goroutine, { index: receiver.index, value: channel.zero(), ok: false } satisfies Completed);
  }
  for (let sender = takeWaiter(channel.senders); sender; sender = takeWaiter(channel.senders)) {
    running.ready(sender.goroutine, { index: sender.index, ok: false, closed: true } satisfies Completed);
  }
}

/** A case of a select: a send of a value, or a receive. */
export type SelectOp =
  | { kind: 'send'; channel: Channel | undefined; value: Value }
  | { kind: 'receive'; channel: Channel | undefined };

/**
 * `select`: the index of the first case ready in the order written, with what a receive received, or -1 for the
 * default case when none is ready; without a default case, blocks until one is.
 */
export function* select(
  ops: SelectOp[],
  hasDefault: boolean
): Suspending<{ index: number; value: Value; ok: boolean }> {
  for (const [index, op] of ops.entries()) {
    if (!op.channel) continue;
    if (op.kind === 'send') {
      if (trySend(op.channel, op.value)) return { index, value: undefined, ok: true };
    } else {
      const received = tryReceive(op.channel);
      if (received) return { index, value: received[0], ok: received[1] };
    }
  }
  if (hasDefault) return { index: -1, value: undefined, ok: false };
  const running = scheduler();
  const goroutine = running.current as Goroutine;
  const state = { done: false };
  for (const [index, op] of ops.entries()) {
    if (!op.channel) continue;
    if (op.kind === 'send')
      op.channel.senders.push({ goroutine, value: op.value, select: state, index } satisfies Waiter);
    else op.channel.receivers.push({ goroutine, select: state, index } satisfies Waiter);
  }
  const reason = ops.every((op) => !op.channel) ? 'select (no cases)' : 'select';
  const completed = (yield* running.park(
    reason,
    ops.map((op) => (op.kind === 'send' ? op.value : undefined))
  )) as Completed;
  // The other cases stay in their channels' queues, marked done, until a send or receive passes them by.
  if (completed.closed) plainPanic('send on closed channel');
  return { index: completed.index, value: completed.value, ok: completed.ok };
}
