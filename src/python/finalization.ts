import { finalizeAsyncGenerator } from './coroutines';
import type { Frame } from './frame';
import { findReachableInOrder, findReachableObjects, freedByReferenceCounting } from './garbageCollection';
import { closeGenerator } from './generators';
import type { Runtime } from './runtime';
import { asyncGeneratorClass, None } from './types';
import { PyClass, PyError, PyFunction, PyGenerator, PyObject, type PyValue } from './values';

/**
 * Closes the generators suspended inside a `try` or `with` statement once nothing refers to them any more, as CPython's
 * reference counting does right away: their `finally` blocks, `except GeneratorExit` handlers, and `__exit__` methods
 * then run. Other suspended generators run nothing when closed, so they are never tracked.
 *
 * Reachability is checked only where a reference to an object reaching such a generator commonly disappears: a `for`
 * loop over it ending, a call it was passed to returning, a name, an attribute, or an item of a list or dict bound to
 * it being rebound or deleted, an expression statement discarding it, and a function whose variable held it returning.
 * Other ways, such as clearing a list holding it, leave it open until one of those happens. At the end of the program, the remaining ones close in the order they first
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
   * Closes the tracked generators that dropping references to `dropped` freed, keeping alive `inFlight`, values held
   * only by the host. Only what the dropped objects reach can be freed, so a walk from them comes first, since it is
   * shorter than one over everything the program reaches. As reference counting, it frees no garbage that a cycle
   * keeps, which only CPython's cycle collector would.
   */
  release(dropped: readonly (PyValue | undefined)[], inFlight: unknown[] = []): void {
    if (this.pending.size === 0 || this.closing) return;
    const objects = dropped.filter((value) => value instanceof PyObject && value !== None);
    if (objects.length === 0) return;
    // Freeing cascades from the dropped objects to what they refer to, in about the order a walk from them finds it.
    // What the program refers to directly is kept, and with it all it reaches, so the walk stops there.
    const order = findReachableInOrder(objects, this.keptObjects(inFlight));
    const fromDropped = new Set(order);
    const candidates = new Set([...this.pending].filter((generator) => fromDropped.has(generator)));
    if (candidates.size === 0) return;
    // The walk stops once it reaches every candidate, which then stays open: nothing is freed.
    const reachable = findReachableObjects(this.roots(inFlight), candidates);
    if ([...candidates].every((generator) => reachable.has(generator))) return;
    const freed = freedByReferenceCounting(new Set([...fromDropped].filter((object) => !reachable.has(object))));
    this.close(
      order.filter(
        (object): object is PyGenerator =>
          object instanceof PyGenerator && freed.has(object) && this.pending.has(object)
      )
    );
  }

  /** Closes the tracked generators that nothing reaches, cycles included, as `gc.collect()` finalizes them. */
  collect(): void {
    if (this.pending.size === 0 || this.closing) return;
    const reachable = findReachableObjects(this.roots([]));
    this.close([...this.pending].filter((generator) => !reachable.has(generator)));
  }

  /**
   * A test for objects the program certainly still reaches: what its frames, the modules, the handled exceptions, and
   * `inFlight` refer to directly, and the classes and functions their modules hold under their own names.
   */
  private keptObjects(inFlight: unknown[]): (object: object) => boolean {
    const { runtime } = this;
    const direct = new Set<unknown>([...inFlight, ...runtime.evaluator.handledExceptions]);
    for (const frame of runtime.frames) {
      for (const value of frame.locals.values()) direct.add(value);
      for (const cell of frame.cells.values()) direct.add(cell.value);
      for (const value of frame.temporaries) direct.add(value);
    }
    const modules = new Set<unknown>(runtime.modules.values());
    return (object) => {
      if (direct.has(object) || modules.has(object)) return true;
      if (!(object instanceof PyClass || object instanceof PyFunction) || typeof object.module !== 'string')
        return false;
      const module = runtime.modules.get(object.module);
      return module !== undefined && module.dict.get(object.name) === object;
    };
  }

  /** What the running program still refers to: its frames, the modules, the exceptions handled, and `inFlight`. */
  private roots(inFlight: unknown[]): unknown[] {
    const { runtime } = this;
    const roots: unknown[] = [...inFlight, ...runtime.evaluator.handledExceptions, ...runtime.modules.values()];
    for (const frame of runtime.frames) {
      for (const value of frame.locals.values()) roots.push(value);
      for (const cell of frame.cells.values()) roots.push(cell.value);
      for (const value of frame.temporaries) roots.push(value);
      if (frame.globals !== frame.locals) for (const value of frame.globals.values()) roots.push(value);
    }
    if (runtime.threads) roots.push(...runtime.threads.roots());
    return roots;
  }

  /**
   * Closes every tracked generator, as the end of the program does. CPython's shutdown first collects the garbage that
   * cycles kept, then the module's namespace, finalizing its objects in the order its collector lists them: a
   * breadth-first walk from the module's variables in order.
   */
  closeAll(globals: Map<string, PyValue>): void {
    const listed = findReachableInOrder([...globals.values()]).filter(
      (object): object is PyGenerator => object instanceof PyGenerator && this.pending.has(object)
    );
    const listedSet = new Set(listed);
    this.close([...[...this.pending].filter((generator) => !listedSet.has(generator)), ...listed]);
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
