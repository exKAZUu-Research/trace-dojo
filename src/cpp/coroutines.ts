import { CppException, CppRuntimeError } from './errors';
import { native } from './library/support';
import type { Completion, Frame } from './runtime';
import { BOOL, type FunctionInfo, pointerTo, VOID } from './types';
import { CObject, Ptr, type Store, type Value } from './values';

/**
 * Where a coroutine suspends: `await_suspend` of the awaiter, which runs once the coroutine has suspended, and what its
 * result means (C++20 [expr.await]p5).
 */
export interface Suspension {
  /** Calls `await_suspend` with the coroutine's handle. */
  awaitSuspend: (frame: Frame) => Value | Ptr;
  result: 'void' | 'bool' | 'handle';
  isFinal: boolean;
}

/** The run of a statement of a coroutine, which yields where the coroutine suspends. */
export type Resumption = Generator<Suspension, Completion, void>;

/** A statement of a coroutine, which may suspend the coroutine before it completes. */
export type Resumable = (frame: Frame) => Resumption;

/** The state of a coroutine: its frame, which outlives the calls that resume it, and where its body is suspended. */
export class Coroutine {
  private readonly body: Resumption;
  private isRunning = false;
  private isSuspendedAtFinal = false;
  private isFinished = false;
  /** The handlers of the `try` blocks of the body the coroutine is suspended in. */
  private suspendedTryBlocks: ((exception: CppException) => boolean)[] = [];

  /**
   * @param teardown Destroys what the frame holds outside the body's blocks: the promise and the parameter copies.
   */
  constructor(
    readonly frame: Frame,
    readonly promise: Store,
    run: Resumable,
    private readonly teardown: (frame: Frame) => void
  ) {
    this.body = run(frame);
    frame.runtime.coroutines.set(promise, this);
  }

  /** Runs the body from its start, in the frame of the call that made the coroutine, until it first suspends. */
  start(): void {
    try {
      this.continueWith(this.runUntilSuspended(false));
    } catch (error) {
      // An exception the call that makes the coroutine throws destroys the coroutine, as clang++ does.
      if (error instanceof CppException) this.destroy();
      throw error;
    }
  }

  resume(row: number, caller: Frame): void {
    if (this.isFinished || this.isSuspendedAtFinal)
      throw new CppRuntimeError('custom', '終わったコルーチンは再開できません。');
    if (this.isRunning) throw new CppRuntimeError('custom', '実行中のコルーチンは再開できません。');
    this.frame.callRow = row >= 0 ? row : caller.callRow;
    this.continueWith(this.runUntilSuspended(true));
  }

  get isDone(): boolean {
    return this.isSuspendedAtFinal;
  }

  destroy(): void {
    if (this.isRunning) throw new CppRuntimeError('custom', '実行中のコルーチンは破棄できません。');
    if (this.isFinished && !this.isSuspendedAtFinal) return;
    const { runtime } = this.frame;
    runtime.frames.push(this.frame);
    const base = runtime.tryBlocks.length;
    runtime.tryBlocks.push(...this.suspendedTryBlocks);
    try {
      // Returning from the suspended body ends the lifetime of the variables of the blocks it is suspended in.
      this.body.return(undefined);
      this.teardown(this.frame);
    } finally {
      runtime.tryBlocks.splice(base);
      runtime.frames.pop();
      this.finish();
    }
  }

  /** Resumes the coroutines that each one's `await_suspend` transfers control to, until one suspends to its caller. */
  private continueWith(next: Coroutine | undefined): void {
    while (next) next = next.runUntilSuspended(true);
  }

  /** Runs the body until it suspends, returning the coroutine its awaiter transfers control to. */
  private runUntilSuspended(pushesFrame: boolean): Coroutine | undefined {
    const { runtime } = this.frame;
    if (pushesFrame) {
      runtime.spend();
      runtime.frames.push(this.frame);
    }
    const base = runtime.tryBlocks.length;
    runtime.tryBlocks.push(...this.suspendedTryBlocks);
    this.isRunning = true;
    this.isSuspendedAtFinal = false;
    try {
      let step = this.body.next();
      for (;;) {
        if (step.done) {
          this.finish();
          return undefined;
        }
        const suspension = step.value;
        this.isSuspendedAtFinal = suspension.isFinal;
        this.suspendedTryBlocks = runtime.tryBlocks.splice(base);
        this.isRunning = false;
        let result: Value | Ptr;
        try {
          result = suspension.awaitSuspend(this.frame);
        } catch (error) {
          if (!(error instanceof CppException)) throw error;
          // An exception from await_suspend resumes the coroutine, which throws it where it suspended.
          this.resumeAfterSuspension(base);
          step = this.body.throw(error);
          continue;
        }
        if (suspension.result === 'bool' && !result) {
          this.resumeAfterSuspension(base);
          step = this.body.next();
          continue;
        }
        if (suspension.result === 'handle') {
          const address = handleAddress(result);
          return address && coroutineAt(this.frame, address);
        }
        return undefined;
      }
    } catch (error) {
      // An exception that escapes the body leaves the coroutine suspended at its final suspend point.
      if (error instanceof CppException) {
        this.isSuspendedAtFinal = true;
        this.isFinished = true;
      }
      throw error;
    } finally {
      this.isRunning = false;
      if (runtime.tryBlocks.length > base) this.suspendedTryBlocks = runtime.tryBlocks.splice(base);
      if (pushesFrame) runtime.frames.pop();
    }
  }

  private resumeAfterSuspension(base: number): void {
    const { runtime } = this.frame;
    runtime.tryBlocks.splice(base);
    runtime.tryBlocks.push(...this.suspendedTryBlocks);
    this.suspendedTryBlocks = [];
    this.isRunning = true;
    this.isSuspendedAtFinal = false;
  }

  private finish(): void {
    this.isFinished = true;
    this.isSuspendedAtFinal = false;
    this.frame.runtime.coroutines.delete(this.promise);
    this.frame.runtime.destroyedCoroutines.add(this.promise);
  }
}

/** The address a `std::coroutine_handle` holds. */
function handleAddress(handle: Value | Ptr): Ptr | undefined {
  const object = handle instanceof Ptr ? handle.read() : handle;
  if (!(object instanceof CObject)) return undefined;
  const address = object.values[0];
  return address instanceof Ptr && !address.isNull ? address : undefined;
}

/** The natives that `std::coroutine_handle` calls with the address it holds. */
export function coroutineFunctions(): Map<string, FunctionInfo[]> {
  const voidPointer = pointerTo(VOID);
  return new Map([
    [
      '__builtin_coro_resume',
      [
        native('__builtin_coro_resume', [voidPointer], VOID, ([address], { frame, row }) => {
          coroutineAt(frame, address)?.resume(row, frame);
        }),
      ],
    ],
    [
      '__builtin_coro_destroy',
      [
        native('__builtin_coro_destroy', [voidPointer], VOID, ([address], { frame }) => {
          coroutineAt(frame, address)?.destroy();
        }),
      ],
    ],
    [
      '__builtin_coro_done',
      [
        native('__builtin_coro_done', [voidPointer], BOOL, ([address], { frame }) =>
          coroutineAt(frame, address)?.isDone ? 1 : 0
        ),
      ],
    ],
  ]);
}

/**
 * The coroutine a handle's address designates, or undefined for `std::noop_coroutine()`'s, which no coroutine
 * has.
 */
function coroutineAt(frame: Frame, address: unknown): Coroutine | undefined {
  const pointer = address as Ptr;
  if (pointer.isNull) throw new CppRuntimeError('custom', '空の std::coroutine_handle は使えません。');
  const { store } = pointer;
  if (store && frame.runtime.destroyedCoroutines.has(store))
    throw new CppRuntimeError('custom', '破棄されたコルーチンの std::coroutine_handle は使えません。');
  return store ? frame.runtime.coroutines.get(store) : undefined;
}
