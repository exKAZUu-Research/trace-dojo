import { pushAll } from './arrays';
import { finalizeAsyncGenerator, hasAsyncGeneratorFinalizer, hasProgramFinalizer } from './coroutines';
import { peekOwnDict } from './descriptors';
import type { Frame } from './frame';
import {
  findReachableAsCollector,
  findReachableInOrder,
  findReachableObjects,
  nativeReferences,
  referencesOf,
} from './garbageCollection';
import { closeGenerator } from './generators';
import { hostRoots } from './hostRoots';
import { LocalReferences } from './localReferences';
import { namespaceMapOf } from './namespaces';
import { bindValue, callValue } from './objects';
import type { Runtime } from './runtime';
import { frameReferences } from './tracebacks';
import { asyncGeneratorClass, None } from './types';
import { reportUnraisable } from './unraisable';
import { UnsupportedFeatureError } from './unsupported';
import {
  PyClass,
  PyDeque,
  PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyList,
  PyModule,
  PyObject,
  PySet,
  type PyValue,
} from './values';
import { hasWeakCallbacks, runCallbacksOf } from './weakReferences';

/**
 * How many slots a program may allocate after objects with `__del__` became garbage that only a reference cycle keeps,
 * before CPython's automatic collector, which runs after about two thousand allocations counted since its last run,
 * might have finalized them at a time this grader cannot tell.
 */
const CYCLIC_GARBAGE_ALLOCATIONS = 50;

/** The methods of a list, dict, set, or deque that remove none of its items, but the one they return. */
const KEEPING_ITEMS = new Set([
  '__contains__',
  '__getitem__',
  '__len__',
  'add',
  'append',
  'appendleft',
  'copy',
  'count',
  'difference',
  'extend',
  'extendleft',
  'get',
  'index',
  'insert',
  'intersection',
  'isdisjoint',
  'issubset',
  'issuperset',
  'items',
  'keys',
  'popitem',
  'popleft',
  'reverse',
  'setdefault',
  'symmetric_difference',
  'union',
  'values',
]);

function keepsItsItems(name: string, key: PyValue | undefined): boolean {
  // `pop` removes what it returns, and a dict's also the stored key, which is the one given unless it is an object.
  if (name === 'pop') return !(key instanceof PyObject) || key === None;
  return KEEPING_ITEMS.has(name);
}

function isContainer(value: PyValue): value is PyList | PyDict | PySet | PyDeque {
  return value instanceof PyList || value instanceof PyDict || value instanceof PySet || value instanceof PyDeque;
}

/**
 * Finalizes the objects whose freeing runs code, as CPython's reference counting does the moment nothing refers to
 * them: the generators suspended inside a `try` or `with` statement, which closing runs `finally` blocks, `except
 * GeneratorExit` handlers, and `__exit__` methods of, and the instances of classes that define `__del__`. Other objects
 * run nothing when freed, so they are never tracked, and a program without these pays nothing.
 *
 * Reachability is checked where a reference to an object commonly disappears: a `for` loop over it ending, a call it
 * was passed to returning, a name, an attribute, or an item of a list or dict bound to it being rebound or deleted, a
 * container method removing it, an expression statement discarding it, the end of an `except` clause, and a function
 * whose variable held it returning. The objects then freed are finalized as reference counting frees them: an object
 * first, then what it referred to, in the order CPython's deallocation releases it. Garbage that a reference cycle
 * keeps waits for `gc.collect()` or the end of the program; when CPython's automatic collector could have run first,
 * the program stops with the unsupported error instead.
 */
export class GeneratorFinalizer {
  /** The generators and instances whose freeing runs code, in the order they were first tracked. */
  readonly pending = new Set<PyObject>();
  /** Whether a program's `gc.disable()` or a zero threshold turned off the automatic collector. */
  private automaticCollection = true;
  /** The objects a finalization in progress frees, which a nested one keeps alive. */
  private readonly freeing: Set<object>[] = [];
  /** The instances whose `__del__` ran, which CPython never runs twice. */
  private readonly finalized = new WeakSet<PyObject>();
  /** The cyclic garbage with `__del__` found since the last collection, which a collection finalizes. */
  private cyclicGarbage = false;

  /** The objects only the running frames refer to, whose freeing needs no walk over the program's objects. */
  readonly locals: LocalReferences;

  constructor(private readonly runtime: Runtime) {
    this.locals = new LocalReferences(runtime);
  }

  /** Tracks a generator after it ran, depending on whether it suspended inside a `try` or `with` statement. */
  update(generator: PyGenerator, frame: Frame, finished: boolean): void {
    if (this.locals.marking) this.locals.escapeFrame(frame);
    if (finished) this.locals.finishFrame(frame);
    // An async generator with a finalizer from the hooks calls it when unfinished, wherever it suspended.
    if (!finished && (frame.protectedDepth > 0 || hasAsyncGeneratorFinalizer(generator))) {
      this.pending.add(generator);
      this.locals.marking = true;
    } else {
      this.pending.delete(generator);
    }
  }

  /** The objects being finalized, which stay alive until their finalization ends. */
  finalizing(): object[] {
    return this.freeing.flatMap((set) => [...set]);
  }

  /** Tracks a new instance of a class that defines `__del__`. */
  track(instance: PyObject): void {
    this.pending.add(instance);
    this.locals.born(instance);
  }

  /** Tracks an existing object that took a class that defines `__del__`, which anything may refer to. */
  watch(object: PyObject): void {
    this.pending.add(object);
  }

  /**
   * Finalizes the tracked objects that dropping references to `dropped`, in that order, freed, keeping alive
   * `inFlight`, values held only by the host. Only what the dropped objects reach can be freed, so a walk from them
   * comes first, since it is shorter than one over everything the program reaches.
   */
  release(dropped: readonly unknown[], inFlight: unknown[] = []): void {
    if (this.pending.size === 0) return;
    const objects = dropped
      .flatMap((root) => nativeReferences(root))
      .filter((value): value is PyObject => value instanceof PyObject && value !== None);
    if (objects.length === 0) return;
    const held = [...inFlight, ...this.freeing.flatMap((set) => [...set])];
    // What the program refers to directly is kept, and with it all it reaches, so the walk stops there.
    const order = findReachableInOrder(objects, this.keptObjects(held));
    const candidates = new Set(order.filter((object) => this.pending.has(object as PyObject)));
    if (candidates.size === 0) return;
    const garbage = this.localGarbage(order, candidates, held) ?? this.walkedGarbage(order, candidates, held);
    if (garbage.size > 0) this.free(garbage, objects);
  }

  /**
   * The garbage among `order` when every tracked object there is local: the local objects nothing running refers to.
   * Undefined when that does not tell, which a walk over everything the program reaches then decides.
   */
  private localGarbage(order: object[], candidates: Set<object>, held: unknown[]): Set<object> | undefined {
    const { locals } = this;
    if (this.runtime.heldByNative().length > 0) return undefined;
    if (![...candidates].every((object) => locals.isLocal(object))) return undefined;
    // Freeing an object that is not local calls the callbacks of its weak references, which only a walk tells.
    if (hasWeakCallbacks(this.runtime) && !order.every((object) => locals.isLocalOrBound(object))) return undefined;
    const local = order.filter((object) => locals.isLocalOrBound(object));
    const alive = locals.aliveAmong(local, held);
    if ([...candidates].every((object) => alive.has(object))) return new Set();
    return new Set(local.filter((object) => !alive.has(object)));
  }

  /** The garbage among `order`, which a walk from what the program refers to directly does not reach. */
  private walkedGarbage(order: object[], candidates: Set<object>, held: unknown[]): Set<object> {
    // The walk stops once it reaches every candidate, which then stays alive: nothing is freed.
    const reachable = findReachableObjects(this.roots(held), candidates);
    if ([...candidates].every((object) => reachable.has(object))) return new Set();
    return new Set(order.filter((object) => !reachable.has(object)));
  }

  /** Stores over or deletes an attribute or an item, freeing what only the value it held kept. */
  replacing(object: PyValue, key: PyValue, isAttribute: boolean, store: () => void): void {
    // A slice may remove several items of a container, which its change frees.
    if (!isAttribute && key instanceof PyObject) {
      this.mutating(object, store);
      return;
    }
    const replaced = this.heldValue(object, key, isAttribute);
    this.replacingReference(replaced, store);
  }

  replacingReference(previous: unknown, store: () => void, inFlight: unknown[] = []): void {
    store();
    this.release([previous], inFlight);
  }

  /** The value an attribute or an item of a builtin container holds, read without running the program's code. */
  // code-gauge-allow functionCognitiveComplexity 19 -- Slots, class metadata and container storage need one ownership snapshot without invoking Python.
  private heldValue(object: PyValue, key: PyValue, isAttribute: boolean): PyValue | undefined {
    if (this.pending.size === 0) return undefined;
    if (isAttribute) {
      if (!(object instanceof PyObject)) return undefined;
      if (object instanceof PyClass && key === '__name__') return object.nameValue;
      if (object instanceof PyClass && key === '__qualname__') return object.qualifiedNameValue;
      const dict = object instanceof PyInstance || object instanceof PyClass ? object.dict : peekOwnDict(object);
      return object.slotValues?.get(key as string) ?? dict?.get(key as string);
    }
    if (object instanceof PyList && typeof key === 'bigint') {
      const { items } = object;
      return items[Number(key < 0n ? key + BigInt(items.length) : key)];
    }
    if (object instanceof PyDict && typeof key !== 'object') return object.store.get(key);
    return undefined;
  }

  /**
   * Runs `change`, which may remove items from `container`, a list, dict, set, or deque, and then frees what the
   * removed items alone kept, as CPython's container does: a list's from its last item, the others' in their order.
   */
  mutating<T>(
    container: PyValue,
    change: () => T,
    inFlight: unknown[] = [],
    method?: { name: string; key?: PyValue }
  ): T {
    if (this.pending.size === 0 || !isContainer(container)) return change();
    // A method that removes nothing, or only what it returns, which the caller then drops, needs no comparison.
    if (method && keepsItsItems(method.name, method.key)) return change();
    const before = referencesOf(container);
    // A method such as `sort` holds the items while it calls the program's functions, though the list may not.
    this.freeing.push(new Set(before));
    let result: T;
    try {
      result = change();
    } finally {
      this.freeing.pop();
    }
    const remaining = new Map<object, number>();
    for (const item of referencesOf(container)) remaining.set(item, (remaining.get(item) ?? 0) + 1);
    const removed: PyValue[] = [];
    for (const item of before) {
      const count = remaining.get(item) ?? 0;
      if (count > 0) remaining.set(item, count - 1);
      else removed.push(item as PyValue);
    }
    if (container instanceof PyList || container instanceof PyDeque) removed.reverse();
    this.release(removed, [result, ...inFlight]);
    return result;
  }

  /** Finalizes what nothing reaches, cycles included, as `gc.collect()` does: the callbacks have run before. */
  collect(): void {
    this.cyclicGarbage = false;
    this.runtime.cyclicGarbageDeadline = undefined;
    if (this.pending.size === 0) return;
    const reachable = findReachableObjects(this.roots([]));
    this.finalizeAll([...this.pending].filter((object) => !reachable.has(object)));
  }

  /**
   * Finalizes every tracked object, as the end of the program does. CPython's shutdown first collects the garbage that
   * cycles kept, then the module's namespace, finalizing its objects in the order its collector lists them: a
   * breadth-first walk from the module's variables in order. What native state still holds (a registered codec or
   * error handler, a daemon thread) CPython frees only after `sys.stdout` is gone, where nothing shows.
   */
  closeAll(globals: Map<string, PyValue>): void {
    this.runtime.cyclicGarbageDeadline = undefined;
    const heldByHost = findReachableObjects([...hostRoots(this.runtime)]);
    for (const object of heldByHost) this.pending.delete(object as PyObject);
    for (const object of this.pending) {
      if (object instanceof PyGenerator && hasProgramFinalizer(object)) {
        throw new UnsupportedFeatureError(
          'プログラムの終わりに残る、sys.set_asyncgen_hooks() の finalizer を持つ非同期ジェネレータの後始末'
        );
      }
    }
    const listed = findReachableAsCollector([...globals.values()]).filter((object): object is PyObject =>
      this.pending.has(object as PyObject)
    );
    const programDel = (object: object): boolean => {
      const method = object instanceof PyInstance ? object.cls.lookup('__del__') : undefined;
      return method instanceof PyFunction && method.globals === globals;
    };
    if (listed.some(programDel) && this.mainHeldElsewhere(globals)) {
      throw new UnsupportedFeatureError(
        'sys などほかのモジュールがプログラムの関数を持つときの、プログラムの終わりに残る __del__ を持つオブジェクトの後始末'
      );
    }
    const listedSet = new Set<object>(listed);
    this.finalizeAll([...[...this.pending].filter((object) => !listedSet.has(object)), ...listed]);
  }

  /** Turns CPython's automatic collector on or off, which then may finalize the cyclic garbage found, or not. */
  setAutomaticCollection(enabled: boolean): void {
    this.automaticCollection = enabled;
    const { runtime } = this;
    if (!enabled) runtime.cyclicGarbageDeadline = undefined;
    else if (this.cyclicGarbage && runtime.cyclicGarbageDeadline === undefined) {
      runtime.cyclicGarbageDeadline = runtime.allocatedSlots + CYCLIC_GARBAGE_ALLOCATIONS;
    }
  }

  /**
   * Whether another module or native state holds a function of the program, which keeps its namespace alive in CPython
   * past the point where the shutdown clears it, until after `sys.stdout` is gone, so its objects' `__del__` run where
   * nothing shows.
   */
  private mainHeldElsewhere(globals: Map<string, PyValue>): boolean {
    const modules = [...this.runtime.modules.values()].filter((module) => module.dict !== globals);
    const reached = findReachableInOrder(
      [...modules.flatMap((module) => [...module.dict.values()]), ...hostRoots(this.runtime)],
      (object) => object instanceof PyModule
    );
    return reached.some((object) => object instanceof PyFunction && object.globals === globals);
  }

  /** Stops the program once CPython's automatic collector could have finalized cyclic garbage at an unknown time. */
  automaticCollectionDue(): void {
    throw new UnsupportedFeatureError(
      '参照の循環だけが残す __del__ を持つオブジェクトを、CPython の自動のごみ集めが回収するタイミング（gc.collect() で回収すると一致する）'
    );
  }

  // Reference counting ------------------------------------------------------------------------------------------------

  /** Frees `garbage` as reference counting does when the references `dropped` disappear, in that order. */
  private free(garbage: Set<object>, dropped: readonly PyObject[]): void {
    const counts = new Map<object, number>();
    for (const node of garbage) {
      for (const child of referencesOf(node)) if (garbage.has(child)) counts.set(child, (counts.get(child) ?? 0) + 1);
    }
    for (const node of dropped) if (garbage.has(node)) counts.set(node, (counts.get(node) ?? 0) + 1);
    this.freeing.push(garbage);
    try {
      for (const node of dropped) this.decrement(node, garbage, counts);
    } finally {
      this.freeing.pop();
    }
    const kept = [...garbage].filter((node) => (counts.get(node) ?? 0) > 0);
    if (kept.some((node) => node instanceof PyInstance && this.pending.has(node))) this.noteCyclicGarbage();
  }

  private decrement(node: object, garbage: Set<object>, counts: Map<object, number>): void {
    if (!garbage.has(node)) return;
    const count = (counts.get(node) ?? 0) - 1;
    counts.set(node, count);
    if (count !== 0) return;
    const generatorChildren = node instanceof PyGenerator ? referencesOf(node, true) : undefined;
    // The object stays among the garbage being freed, alive to callbacks, until its finalizer and callbacks ran.
    const resurrected = node instanceof PyObject && this.pending.has(node) && !this.finalize(node, garbage);
    if (!resurrected && node instanceof PyObject) runCallbacksOf(node);
    garbage.delete(node);
    if (generatorChildren) {
      const rescued = findReachableObjects(this.roots([], garbage));
      for (const object of rescued) garbage.delete(object);
      for (const child of generatorChildren) this.decrement(child, garbage, counts);
      return;
    }
    if (resurrected) return;
    for (const child of referencesOf(node, true)) this.decrement(child, garbage, counts);
  }

  /**
   * Runs what freeing a tracked object runs, returning false when its `__del__` resurrected it: made something but
   * `garbage`, what is being freed with it, refer to it.
   */
  private finalize(object: PyObject, garbage: Set<object>): boolean {
    this.pending.delete(object);
    if (object instanceof PyGenerator) {
      this.closeOne(object);
      return true;
    }
    if (this.finalized.has(object)) return true;
    this.finalized.add(object);
    this.callDel(object);
    if (this.locals.isLocal(object)) {
      const held = this.freeing.filter((set) => set !== garbage).flatMap((set) => [...set]);
      return !this.locals.aliveAmong([object], held).has(object);
    }
    return !findReachableObjects(this.roots([], garbage), new Set([object])).has(object);
  }

  private noteCyclicGarbage(): void {
    if (this.cyclicGarbage) return;
    this.cyclicGarbage = true;
    if (this.automaticCollection) {
      this.runtime.cyclicGarbageDeadline = this.runtime.allocatedSlots + CYCLIC_GARBAGE_ALLOCATIONS;
    }
  }

  // Finalizing --------------------------------------------------------------------------------------------------------

  /** Finalizes objects in order, as a collection does: each object's own finalizer, with no cascade between them. */
  private finalizeAll(objects: PyObject[]): void {
    // The garbage stays alive until every finalizer ran, so their own frames returning frees none of it.
    this.freeing.push(new Set(objects));
    try {
      for (const object of objects) {
        if (!this.pending.has(object)) continue;
        this.pending.delete(object);
        if (object instanceof PyGenerator) this.closeOne(object);
        else if (!this.finalized.has(object)) {
          this.finalized.add(object);
          this.callDel(object);
        }
      }
    } finally {
      this.freeing.pop();
    }
  }

  private callDel(object: PyObject): void {
    const method = object.cls.lookup('__del__');
    if (method === undefined) return;
    try {
      callValue(bindValue(method, object), []);
    } catch (error) {
      if (!(error instanceof PyError)) throw error;
      reportUnraisable(error, 'Exception ignored while calling deallocator', method);
    }
  }

  private closeOne(generator: PyGenerator): void {
    if (generator.running) return;
    let message = 'Exception ignored while closing generator';
    try {
      if (generator.cls === asyncGeneratorClass && hasAsyncGeneratorFinalizer(generator)) {
        message = 'Exception ignored while finalizing generator';
        if (finalizeAsyncGenerator(generator)) return;
      }
      closeGenerator(generator);
    } catch (error) {
      if (!(error instanceof PyError)) throw error;
      reportUnraisable(error, message, generator);
    }
  }

  // Roots -------------------------------------------------------------------------------------------------------------

  /**
   * A test for objects the program certainly still reaches: what its frames, the modules, the handled exceptions, and
   * `inFlight` refer to directly, and the classes and functions their modules hold under their own names.
   */
  private keptObjects(inFlight: unknown[]): (object: object) => boolean {
    const { runtime } = this;
    const direct = new Set<unknown>([...inFlight, ...runtime.evaluator.handledExceptions]);
    for (const frame of runtime.frames) for (const value of nativeReferences(frameReferences(frame))) direct.add(value);
    const modules = new Set<unknown>(runtime.modules.values());
    return (object) => direct.has(object) || modules.has(object) || this.moduleOwns(object);
  }

  private moduleOwns(object: object): boolean {
    const { modules } = this.runtime;
    if (object instanceof PyDict) {
      const namespace = namespaceMapOf(object);
      const name = namespace?.get('__name__');
      return typeof name === 'string' && modules.get(name)?.dict === namespace;
    }
    if (!(object instanceof PyClass || object instanceof PyFunction) || typeof object.module !== 'string') return false;
    return modules.get(object.module)?.dict.get(object.name) === object;
  }

  /** What the running program still refers to: its frames, the modules, the exceptions handled, and `inFlight`. */
  private roots(inFlight: unknown[], excluded?: Set<object>): unknown[] {
    const { runtime } = this;
    const roots: unknown[] = [
      ...inFlight,
      ...this.freeing.filter((set) => set !== excluded).flatMap((set) => [...set]),
      ...runtime.evaluator.handledExceptions,
      ...runtime.modules.values(),
      runtime.heldByNative(),
    ];
    for (const frame of runtime.frames) pushAll(roots, frameReferences(frame));
    pushAll(roots, hostRoots(runtime));
    return roots;
  }
}
