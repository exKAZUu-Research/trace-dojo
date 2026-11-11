import { finalizeAsyncGenerator } from './coroutines';
import type { Frame } from './frame';
import { findReachableObjects } from './garbageCollection';
import { closeGenerator } from './generators';
import type { Runtime } from './runtime';
import { asyncGeneratorClass } from './types';
import { PyError, PyGenerator, PyIterator, type PyValue } from './values';

/**
 * Closes the generators suspended inside a `try` or `with` statement once nothing refers to them any more, as CPython's
 * reference counting does right away: their `finally` blocks, `except GeneratorExit` handlers, and `__exit__` methods
 * then run. Other suspended generators run nothing when closed, so they are never tracked.
 *
 * Reachability is checked only where a reference to such a generator, or to an iterator wrapping one, commonly
 * disappears: a `for` loop over it ending, a call it was passed to returning, a name bound to it being rebound or
 * deleted, and a function whose variable held it returning. Other ways, such as clearing a list holding it, leave it
 * open until one of those happens. At the end of the program, the remaining ones close in the order they first
 * suspended, as CPython's shutdown clears the module's variables in order.
 */
export class GeneratorFinalizer {
  /** The suspended generators whose closing runs code, in the order they first suspended. */
  readonly pending = new Set<PyGenerator>();
  private closing = false;

  constructor(private readonly runtime: Runtime) {}

  /** Tracks a generator after it ran, depending on whether it suspended inside a `try` or `with` statement. */
  update(generator: PyGenerator, frame: Frame, finished: boolean): void {
    if (!finished && frame.protectedDepth > 0) this.pending.add(generator);
    else this.pending.delete(generator);
  }

  /**
   * Whether dropping a reference to a value may leave a tracked generator unreachable: the value is a generator or an
   * iterator, which may wrap one, while some generator is tracked.
   */
  mayRelease(value: PyValue | undefined): boolean {
    return this.pending.size > 0 && (value instanceof PyGenerator || value instanceof PyIterator);
  }

  /** Closes the tracked generators that nothing reaches, keeping alive `inFlight`, values held only by the host. */
  closeUnreachable(inFlight: unknown[] = []): void {
    if (this.pending.size === 0 || this.closing) return;
    const { runtime } = this;
    const roots: unknown[] = [...inFlight, ...runtime.evaluator.handledExceptions, ...runtime.modules.values()];
    for (const frame of runtime.frames) {
      for (const value of frame.locals.values()) roots.push(value);
      for (const cell of frame.cells.values()) roots.push(cell.value);
      for (const value of frame.temporaries) roots.push(value);
      if (frame.globals !== frame.locals) for (const value of frame.globals.values()) roots.push(value);
    }
    if (runtime.threads) roots.push(...runtime.threads.roots());
    const reachable = findReachableObjects(roots);
    this.close([...this.pending].filter((generator) => !reachable.has(generator)));
  }

  /** Closes every tracked generator, as the end of the program does. */
  closeAll(): void {
    this.close([...this.pending]);
  }

  private close(generators: PyGenerator[]): void {
    this.closing = true;
    try {
      for (const generator of generators) {
        this.pending.delete(generator);
        if (generator.running) continue;
        if (generator.cls === asyncGeneratorClass && finalizeAsyncGenerator(generator)) continue;
        try {
          closeGenerator(generator);
        } catch (error) {
          // CPython reports an exception raised while closing an unreachable generator on stderr and goes on.
          if (!(error instanceof PyError)) throw error;
        }
      }
    } finally {
      this.closing = false;
    }
  }
}
