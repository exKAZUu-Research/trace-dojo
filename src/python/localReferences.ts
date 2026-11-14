import { PyAnnotateFunction } from './annotations';
import type { Frame } from './frame';
import { nativeReferences, referencesOf } from './garbageCollection';
import { hostRoots } from './hostRoots';
import { plainInitOf } from './instances';
import type { Runtime } from './runtime';
import { frameReferences } from './tracebacks';
import { dictClass, listClass, setClass, tupleClass } from './types';
import {
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDict,
  PyDictView,
  PyFunction,
  PyInstance,
  PyList,
  PyObject,
  PySet,
  PySuper,
  PyTuple,
  type PyValue,
} from './values';

/**
 * The builtins that keep none of their arguments: they read them and return a value, at most a new container holding
 * what they read, whose items `afterCall` hands on.
 */
const KEEPING_NOTHING = [
  'abs',
  'all',
  'any',
  'ascii',
  'bin',
  'bool',
  'callable',
  'chr',
  'dict',
  'divmod',
  'float',
  'format',
  'frozenset',
  'hasattr',
  'hash',
  'hex',
  'id',
  'int',
  'isinstance',
  'issubclass',
  'len',
  'list',
  'max',
  'min',
  'next',
  'oct',
  'ord',
  'pow',
  'print',
  'repr',
  'round',
  'set',
  'sorted',
  'str',
  'sum',
  'tuple',
];

/** The methods of a local list, dict, or set that store some of their arguments in it: their positions. */
const STORING: Record<string, number[]> = {
  append: [0],
  add: [0],
  insert: [1],
  setdefault: [0, 1],
  __setitem__: [0, 1],
};

/** The methods of a local list, dict, or set that store what their arguments hold in it, or keep nothing at all. */
const KEEPING_ITS_OWN = new Set([
  '__contains__',
  '__getitem__',
  '__len__',
  'clear',
  'copy',
  'count',
  'difference',
  'difference_update',
  'discard',
  'extend',
  'get',
  'index',
  'intersection',
  'intersection_update',
  'keys',
  'pop',
  'popitem',
  'remove',
  'reverse',
  'sort',
  'symmetric_difference',
  'symmetric_difference_update',
  'union',
  'update',
  'values',
]);

/**
 * The objects that only the running frames refer to, directly or through other such objects, which tells without
 * walking the program's objects whether dropping a reference to one of them frees it.
 *
 * An object is local from its creation until the program hands it to anything that may keep it where this cannot
 * see: a builtin, a closure, a generator, a module, an object that is not local, or a function that returns it to a
 * builtin. A local object refers to the local objects it holds, which are local too, and each local object records
 * the local objects it was stored in, its owners. Nothing then refers to a local object but the running frames, the
 * methods bound to it among the values they hold, and its owners: it is alive while a frame refers to it, or an owner
 * that is alive still holds it.
 *
 * Expressions hand their values on by default, so a value is local only where the evaluator says it stays in the
 * frame: assigned to a name, stored in a local object, passed to a Python function, discarded, returned to the
 * expression that called the function, or used where the operation reads it and keeps nothing, such as an operand.
 * Cached item tuples and reflected snapshots retain known frame and container ownership, so reflection and yielding
 * do not require walking unrelated data on every item.
 */
export class LocalReferences {
  /** Whether objects with observable ownership are being followed. */
  marking = false;
  /** Whether live frame access disables general local tracking. */
  private exposed = false;
  private readonly itemOwners = new WeakSet<PyObject>();
  private readonly itemTupleRefs = new Set<WeakRef<PyObject>>();
  private readonly liveNamespaces = new WeakMap<Map<string, PyValue>, PyObject>();
  private readonly itemTuples = new WeakSet<PyObject>();
  private readonly exposedFrames = new WeakSet<Frame>();
  private readonly retainedFrames = new WeakSet<Frame>();
  private readonly tupleFrames = new WeakMap<PyObject, Map<number, WeakRef<Frame>>>();
  private readonly frameIds = new WeakMap<Frame, number>();
  private nextFrameId = 0;
  private readonly local = new WeakSet<PyObject>();
  private readonly owners = new WeakMap<PyObject, Set<PyObject>>();
  /** The builtins that keep nothing they are passed, found once following starts. */
  private keepingNothing: Set<PyValue> | undefined;
  /** Whether the call the evaluator is making hands the function's return value back to it. */
  private directCall = false;

  constructor(private readonly runtime: Runtime) {}

  /** Follows a new object whose ownership is observable, which is local until it is handed on. */
  born(object: PyObject): void {
    this.marking = true;
    if (!this.exposed) this.local.add(object);
  }

  bornItemTuple(tuple: PyTuple): void {
    this.marking = true;
    this.itemTuples.add(tuple);
    this.itemTupleRefs.add(new WeakRef(tuple));
    this.local.add(tuple);
  }

  retainFrame(frame: Frame): void {
    this.exposedFrames.add(frame);
    this.retainedFrames.add(frame);
    for (const value of nativeReferences(frame.localValues())) this.binding(frame, value);
  }

  finishFrame(frame: Frame): void {
    if (!this.exposedFrames.has(frame)) this.retainedFrames.delete(frame);
  }

  binding(frame: Frame, value: unknown): void {
    if (!(value instanceof PyObject) || !this.tracksItemOwnership(value) || !this.retainedFrames.has(frame)) return;
    let id = this.frameIds.get(frame);
    if (id === undefined) this.frameIds.set(frame, (id = this.nextFrameId++));
    let frames = this.tupleFrames.get(value);
    if (!frames) this.tupleFrames.set(value, (frames = new Map()));
    frames.set(id, new WeakRef(frame));
  }

  canLocateItemTuple(tuple: PyTuple): boolean {
    if (!this.isLocal(tuple)) return false;
    return (
      !this.hasRetainedFrame(tuple) &&
      !this.leadsBack(new Set([tuple]), (owner) => this.hasRetainedFrame(owner), new Set())
    );
  }

  reflected(value: PyValue, namespace?: Map<string, PyValue>): PyValue {
    if (!(value instanceof PyObject)) return value;
    if (namespace && this.liveNamespaces.has(namespace)) return value;
    this.marking = true;
    this.local.add(value);
    this.itemOwners.add(value);
    if (namespace) this.liveNamespaces.set(namespace, value);
    for (const child of referencesOf(value)) if (child instanceof PyObject) this.own(child, value);
    return value;
  }

  /** Follows a container the evaluator created, holding `items`, while objects are followed. */
  bornContainer(container: PyValue, items: Iterable<PyValue>): void {
    if (!(container instanceof PyObject)) return;
    if (!this.exposed) this.local.add(container);
    for (const item of items) {
      if (item instanceof PyObject && this.tracksItemOwnership(item) && this.isLocal(item)) this.local.add(container);
      this.own(item, container);
    }
  }

  isLocal(object: object): boolean {
    return (!this.exposed || this.tracksItemOwnership(object as PyObject)) && this.local.has(object as PyObject);
  }

  /** Whether an object is local, or a method bound to a local object, which only the running frames hold too. */
  isLocalOrBound(object: object): boolean {
    let current: unknown = object;
    while (current instanceof PyObject) {
      if (this.isLocal(current)) return true;
      current = holderOf(current);
    }
    return false;
  }

  /** Records that `owner` holds `value`, which stays local if both are, and is handed on otherwise. */
  own(value: PyValue | undefined, owner: PyObject): void {
    if (!(value instanceof PyObject)) return;
    if (!this.isLocal(owner) || !this.isLocal(value)) {
      this.escape(value);
      return;
    }
    if (this.tracksItemOwnership(value)) this.itemOwners.add(owner);
    let owners = this.owners.get(value);
    if (!owners) {
      owners = new Set();
      this.owners.set(value, owners);
    }
    owners.add(owner);
  }

  /** Hands a value on: it, the local objects it holds, and the object a method bound to it holds, are not local. */
  escape(value: unknown): void {
    if (!(value instanceof PyObject)) return;
    const pending: unknown[] = [value];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!(current instanceof PyObject)) continue;
      if (this.local.delete(current)) for (const child of referencesOf(current)) pending.push(child);
      pending.push(holderOf(current));
    }
  }

  /** Hands on the items of a container a builtin returned, which may be new and then holds them where none is local. */
  escapeItems(value: PyValue): void {
    const container =
      value instanceof PyList || value instanceof PyTuple || value instanceof PyDict || value instanceof PySet;
    if (!container || this.isLocal(value)) return;
    for (const item of referencesOf(value)) this.escape(item as PyValue);
  }

  /** Hands on what a frame holds, which something besides the running frames keeps from now on. */
  escapeFrame(frame: Frame): void {
    if (!this.marking) return;
    for (const value of nativeReferences(frameReferences(frame))) {
      if (value instanceof PyObject && this.tracksItemOwnership(value)) {
        this.retainedFrames.add(frame);
        this.binding(frame, value);
      } else this.escape(value);
    }
  }

  /** Hands on the parameters a function's closures capture, whose cells the closures share. */
  enterFunction(frame: Frame): void {
    if (this.marking) for (const cell of frame.cells.values()) this.escape(cell.value);
  }

  /** Hands on what a function returns to a builtin, which may keep it, unlike the evaluator calling it directly. */
  returned(result: PyValue, direct: boolean): void {
    if (this.marking && !direct) this.escape(result);
  }

  /** Follows a new generator, which keeps its arguments and is local itself until it is handed on. */
  generatorCreated(generator: PyObject, frame: Frame): void {
    if (!this.marking) return;
    this.escapeFrame(frame);
    this.local.add(generator);
  }

  expose(): void {
    const pending: PyObject[] = [];
    for (const reference of this.itemTupleRefs) {
      const value = reference.deref();
      if (value && this.isLocal(value)) pending.push(value);
      else if (!value) this.itemTupleRefs.delete(reference);
    }
    const visited = new Set<PyObject>();
    while (pending.length > 0) {
      const value = pending.pop() as PyObject;
      if (visited.has(value)) continue;
      visited.add(value);
      this.itemOwners.add(value);
      for (const owner of this.owners.get(value) ?? [])
        if (this.isLocal(owner) && holds(owner, value)) pending.push(owner);
    }
    this.runtime.scan(visited.size);
    this.exposed = true;
  }

  /** Whether a name binding stores its value where only the running frames refer to it. */
  bindsLocally(frame: Frame, access: string): boolean {
    if (access === 'local' || access === 'name') {
      // A generator's frame, a generator expression's included, hands on what it holds whenever it leaves the stack.
      if (frame.kind === 'function' || frame.kind === 'comprehension') return true;
      if (frame.kind !== 'module') return false;
    } else if (access !== 'global') {
      return false;
    }
    const namespace = this.liveNamespaces.get(frame.globals);
    return frame.globals === this.runtime.mainGlobals && (namespace === undefined || this.isLocal(namespace));
  }

  // Calls -------------------------------------------------------------------------------------------------------------

  /**
   * Whether calling `callee` keeps its arguments only in the frame of a Python function, in a local container it is a
   * method of, or not at all.
   */
  keepsArgumentsLocal(callee: PyValue): boolean {
    if (plainFunction(callee) !== undefined) return true;
    if (callee instanceof PyClass) {
      const init = plainInitOf(callee);
      if (init !== undefined) return !(init instanceof PyFunction) || plainFunction(init) !== undefined;
    }
    const owner = localContainerOf(callee, this);
    if (owner !== undefined) return (callee as PyBuiltinFunction).name in STORING;
    this.keepingNothing ??= new Set(KEEPING_NOTHING.map((name) => this.runtime.builtins.get(name) as PyValue));
    return this.keepingNothing.has(callee);
  }

  /** Hands on what a call of a builtin method may keep, before it runs: its object, unless it is a known method. */
  beforeCall(callee: PyValue): void {
    const self = builtinSelf(callee);
    if (!(self instanceof PyObject) || !this.isLocalOrBound(self)) return;
    const owner = localContainerOf(callee, this);
    const { name } = callee as PyBuiltinFunction;
    if (owner === undefined || !(name in STORING || KEEPING_ITS_OWN.has(name))) this.escape(self);
  }

  /** Records what a call stored in a local container, and hands on the items of a container a builtin made. */
  afterCall(callee: PyValue, args: PyValue[], kwargs: Map<string, PyValue> | undefined, result: PyValue): void {
    const owner = localContainerOf(callee, this);
    const stored = owner && STORING[(callee as PyBuiltinFunction).name];
    if (owner && stored) for (const index of stored) this.own(args[index], owner);
    else if (owner && kwargs) for (const value of kwargs.values()) this.escape(value);
    if (plainFunction(callee) === undefined) this.escapeItems(result);
  }

  /** Notes whether the evaluator calls `callee` itself, which then hands its return value back to the evaluator. */
  noteCall(callee: PyValue): void {
    this.directCall = plainFunction(callee) !== undefined;
  }

  /** Whether the function being called returns to the evaluator, which a Python function's call reads once. */
  takeDirectCall(): boolean {
    const direct = this.directCall;
    this.directCall = false;
    return direct;
  }

  // Liveness ----------------------------------------------------------------------------------------------------------

  /**
   * The objects among `objects`, which are local, that are alive: those the running frames, the values held by the
   * host (`held`), or the exceptions being handled refer to, directly or through a method bound to them, and those an
   * owner that is alive still holds.
   */
  aliveAmong(objects: Iterable<object>, held: Iterable<unknown>): Set<object> {
    const direct = this.directlyHeld(held);
    const alive = new Set<object>();
    const dead = new Set<object>();
    for (const object of objects) {
      if (direct.has(object) || alive.has(object)) {
        alive.add(object);
        continue;
      }
      if (dead.has(object)) continue;
      const visited = new Set<object>([object]);
      if (this.leadsBack(visited, (owner) => direct.has(owner) || alive.has(owner), dead)) alive.add(object);
      // Without a way back to the frames, nothing the search met has one.
      else for (const each of visited) dead.add(each);
    }
    return alive;
  }

  /**
   * Whether the owners that still hold the object in `visited`, their owners, and so on, include one `isAlive` tells,
   * adding those met to `visited` and skipping those `dead` lists.
   */
  private leadsBack(visited: Set<object>, isAlive: (owner: object) => boolean, dead: Set<object>): boolean {
    const stack = [...visited];
    while (stack.length > 0) {
      const current = stack.pop() as PyObject;
      for (const owner of this.owners.get(current) ?? []) {
        if (visited.has(owner) || dead.has(owner) || !this.isLocal(owner) || !holds(owner, current)) continue;
        if (isAlive(owner)) return true;
        visited.add(owner);
        stack.push(owner);
      }
    }
    return false;
  }

  /** What the running frames, the threads, the exceptions handled, and `held` refer to, with the objects of methods. */
  private directlyHeld(held: Iterable<unknown>): Set<object> {
    const direct = new Set<object>();
    const note = (value: unknown): void => {
      let current = value;
      while (current instanceof PyObject) {
        direct.add(current);
        current = holderOf(current);
      }
    };
    for (const value of held) note(value);
    for (const value of this.runtime.evaluator.handledExceptions) note(value);
    for (const frame of this.runtime.frames) for (const value of nativeReferences(frameReferences(frame))) note(value);
    for (const value of hostRoots(this.runtime)) note(value);
    return direct;
  }

  private tracksItemOwnership(value: PyObject): boolean {
    return this.itemTuples.has(value) || this.itemOwners.has(value);
  }

  private hasRetainedFrame(value: object): boolean {
    const frames = this.tupleFrames.get(value as PyObject);
    for (const [id, reference] of frames ?? []) {
      const frame = reference.deref();
      if (!frame) {
        frames?.delete(id);
        continue;
      }
      if (
        this.retainedFrames.has(frame) &&
        !this.runtime.frames.includes(frame) &&
        nativeReferences(frame.localValues()).includes(value)
      )
        return true;
    }
    return false;
  }
}

/** The object a method, a bound builtin, a `super` object, or a dict view refers to, which keeping it keeps. */
function holderOf(value: PyObject): unknown {
  if (value instanceof PyBoundMethod || value instanceof PyBuiltinFunction || value instanceof PySuper) {
    return value.self;
  }
  if (value instanceof PyDictView) return value.dict;
  return undefined;
}

/** Whether a local object still holds `object`, which it held when it became its owner. */
function holds(owner: PyObject, object: object): boolean {
  if (owner.cls === object) return true;
  if ((owner instanceof PyList || owner instanceof PyTuple) && owner.items.includes(object as PyValue)) return true;
  if (
    owner instanceof PyDict &&
    owner.store.liveEntries().some((entry) => entry.value === object || entry.key === object)
  )
    return true;
  if (owner instanceof PyInstance && owner.dict.values().some((value) => value === object)) return true;
  return referencesOf(owner).includes(object);
}

/** The object a builtin method runs on, which the builtin's code may keep or read into what it returns. */
function builtinSelf(callee: PyValue): PyValue | undefined {
  if (callee instanceof PyBuiltinFunction) return callee.self;
  if (callee instanceof PyBoundMethod && !(callee.fn instanceof PyFunction)) return callee.self;
  return undefined;
}

/** The local list, dict, or set a builtin method of its type is bound to. */
function localContainerOf(callee: PyValue, locals: LocalReferences): PyObject | undefined {
  if (!(callee instanceof PyBuiltinFunction)) return undefined;
  const { self } = callee;
  return isContainer(self) && locals.isLocal(self) ? self : undefined;
}

/** Whether a value is a list, tuple, dict, or set of the builtin type itself, which the evaluator's displays create. */
function isContainer(value: PyValue | undefined): value is PyObject {
  if (value instanceof PyList) return value.cls === listClass;
  if (value instanceof PyTuple) return value.cls === tupleClass;
  if (value instanceof PyDict) return value.cls === dictClass;
  return value instanceof PySet && value.cls === setClass;
}

/**
 * The Python function calling `callee` runs, when its frame is all that keeps the arguments: a plain function, not a
 * generator or coroutine, whose parameters collect no tuple or dict of them.
 */
function plainFunction(callee: PyValue): PyFunction | undefined {
  const fn = callee instanceof PyBoundMethod && callee.fastCall === undefined ? callee.fn : callee;
  if (!(fn instanceof PyFunction) || fn instanceof PyAnnotateFunction) return undefined;
  const { scope, params } = fn.def;
  if (scope.isGenerator || scope.isAsync) return undefined;
  if (params.some((param) => param.kind === 'varArgs' || param.kind === 'varKeywords')) return undefined;
  return fn;
}
