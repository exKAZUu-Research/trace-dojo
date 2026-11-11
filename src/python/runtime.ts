import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { StepTracker } from '../interpreter/stepTracker';
import { TurtleWorld } from '../interpreter/turtleWorld';
import { createBuiltins } from './builtins';
import { bindArguments } from './calls';
import { pyRepr } from './conversions';
import { markIterableCoroutine } from './coroutines';
import { Evaluator } from './evaluator';
import { GeneratorFinalizer } from './finalization';
import { Frame } from './frame';
import { findReachableObjects, findReachableTurtles } from './garbageCollection';
import { resumeGenerator } from './generators';
import { pyHash } from './hashing';
import { instantiate } from './instances';
import { keyError } from './items';
import { importModule } from './modules';
import { systemExitError } from './modules/sys';
import { bindValue, callValue, isTruthy, overriding, setAttribute, toArray } from './objects';
import { setDifference, setIntersection, setSymmetricDifference, setUnion } from './setOperations';
import { createStream } from './streams';
import type { Scheduler } from './threads';
import { boundSuper } from './typeObject';
import { genericClass, subscriptGeneric } from './typeParams';
import {
  asyncGeneratorClass,
  classOf,
  coroutineClass,
  exceptionClassNamed,
  generatorClass,
  nativeFunction,
  newException,
  newList,
  newTuple,
  None,
  propertyClass,
  pyError,
  superClass,
  typeError,
  typingClass,
  unionClass,
  valueError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  DONE,
  type Kwargs,
  PyCell,
  PyClass,
  PyDescriptor,
  type PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  type PyList,
  PyModule,
  PyObject,
  PyOpaque,
  type PySet,
  PyTuple,
  type PyValue,
} from './values';

/** The magnitude below which multiplying two ints costs no more than one operation. */
const SAFE_INTEGER_BOUND = 1n << 53n;

export class Runtime {
  readonly world = new TurtleWorld();
  readonly budget = new ExecutionBudget();
  readonly steps = new StepTracker();
  readonly frames: Frame[] = [];
  readonly builtins: Map<string, PyValue>;
  readonly modules = new Map<string, PyModule>();
  readonly evaluator: Evaluator;
  readonly finalizer = new GeneratorFinalizer(this);
  /** `sys.getrecursionlimit()`, which {@link LIMITS.maxCallDepth} caps. */
  recursionLimit = 1000;
  /** The row of the call being evaluated, from which calls the interpreter makes implicitly count as called. */
  currentRow: number | undefined;
  /** The scheduler of the program's threads, once it starts one or waits. */
  threads?: Scheduler;
  /** The globals of the standard library modules written in Python. */
  readonly libraryNamespaces = new WeakSet<Map<string, PyValue>>();
  /** Whether any library module written in Python was imported, without which no frame is a library frame. */
  private hasLibraryNamespaces = false;
  private readonly libraryEntryRows = new WeakMap<Frame, number | undefined>();
  /** What `print` wrote to stderr, which learners do not see, as Java's `System.err` output. */
  errorOutput = '';
  private allocatedSlots = 0;
  private reprDepth = 0;

  constructor() {
    this.builtins = createBuiltins();
    this.evaluator = new Evaluator(this);
  }

  get frame(): Frame {
    return this.frames.at(-1) as Frame;
  }

  // Budget ----------------------------------------------------------------------------------------------------------

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  scan(length: number): void {
    this.spend(Math.ceil(length / 64));
  }

  allocate(count: number): void {
    this.allocatedSlots += count;
    if (this.allocatedSlots > LIMITS.maxSlots) throw pyError('MemoryError');
    this.spend(Math.ceil(count / 64));
  }

  buildString(length: number): void {
    if (length > LIMITS.maxStringLength) throw pyError('MemoryError');
    this.spend(Math.ceil(length / 16));
  }

  /** Charges for an integer of `bits` bits about to be computed, refusing ones that would exhaust memory. */
  chargeBits(bits: bigint): void {
    if (bits > BigInt(LIMITS.maxStringLength) * 8n) throw pyError('MemoryError');
    this.spend(Math.ceil(Number(bits) / 1024));
  }

  chargeBigint(a: bigint, b: bigint): void {
    if (a < SAFE_INTEGER_BOUND && a > -SAFE_INTEGER_BOUND && b < SAFE_INTEGER_BOUND && b > -SAFE_INTEGER_BOUND) return;
    this.chargeBits(BigInt(a.toString(16).length * 4 + b.toString(16).length * 4));
  }

  // Frames and calls ------------------------------------------------------------------------------------------------

  /** Marks the globals of a standard library module written in Python, whose frames stay out of the trace. */
  addLibraryNamespace(namespace: Map<string, PyValue>): void {
    this.libraryNamespaces.add(namespace);
    this.hasLibraryNamespaces = true;
  }

  pushFrame(frame: Frame): void {
    if (this.frames.length >= Math.min(this.recursionLimit, LIMITS.maxCallDepth)) {
      throw pyError('RecursionError', 'maximum recursion depth exceeded');
    }
    if (this.hasLibraryNamespaces) this.noteLibraryFrame(frame);
    this.frames.push(frame);
  }

  private noteLibraryFrame(frame: Frame): void {
    // The frames of standard library modules written in Python stay out of the trace, as native code does: they show
    // no call line, and the program's functions they call count as called from the program's row that entered them.
    if (this.libraryNamespaces.has(frame.globals)) {
      this.libraryEntryRows.set(frame, this.callerRow());
      frame.callRow = undefined;
    } else if (frame.callRow !== undefined && this.libraryEntryRows.has(this.frames.at(-1) as Frame)) {
      frame.callRow = this.callerRow();
    }
  }

  popFrame(): void {
    const frame = this.frames.pop();
    if (frame?.isAtomic) this.steps.completeAtomicCall();
    if (this.hasLibraryNamespaces && frame && this.libraryEntryRows.has(frame))
      this.currentRow = this.libraryEntryRows.get(frame);
  }

  /**
   * The frames of the program's own code with the row each is running, innermost first, skipping the frames of library
   * modules, as `warnings` and `traceback` report them.
   */
  programFrames(): { frame: Frame; row: number | undefined }[] {
    const result: { frame: Frame; row: number | undefined }[] = [];
    let row = this.currentRow;
    for (const frame of this.frames.toReversed()) {
      if (this.libraryEntryRows.has(frame)) {
        row = this.libraryEntryRows.get(frame);
        continue;
      }
      result.push({ frame, row });
      row = frame.callRow;
    }
    return result;
  }

  /** The program's row that the running code counts as, which is the row that entered a library module's code. */
  private callerRow(): number | undefined {
    const top = this.frames.at(-1);
    return top && this.libraryEntryRows.has(top) ? this.libraryEntryRows.get(top) : this.currentRow;
  }

  /** Runs `run`, turning the host's stack overflow into Python's RecursionError. */
  guardRecursion<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      throw recursionErrorFor(error);
    }
  }

  newFunctionFrame(fn: PyFunction, args: readonly PyValue[], kwargs: Kwargs): Frame {
    const { def } = fn;
    const bound = bindArguments(fn, args, kwargs);
    const locals = new Map<string, PyValue>();
    const cells = new Map<string, PyCell>();
    for (const name of def.scope.frees) cells.set(name, fn.closure.get(name) ?? new PyCell());
    for (const name of def.scope.cells) cells.set(name, new PyCell(bound.get(name)));
    for (const param of def.params) {
      const value = bound.get(param.name);
      if (value !== undefined && !def.scope.cells.includes(param.name)) locals.set(param.name, value);
    }
    return new Frame('function', locals, cells, fn.globals, this.currentRow, def.isAtomic, def.scope, fn, fn.classCell);
  }

  callFunction(fn: PyFunction, args: readonly PyValue[], kwargs: Kwargs): PyValue {
    const frame = this.newFunctionFrame(fn, args, kwargs);
    const { scope } = fn.def;
    if (scope.isGenerator || scope.isAsync) return this.newGenerator(fn, frame);
    this.pushFrame(frame);
    let result: PyValue | undefined;
    try {
      result = this.evaluator.runFunction(fn, frame);
      return result;
    } catch (error) {
      const raised = recursionErrorFor(error);
      // The exception's traceback keeps the frame, and with it the function's variables, while a generator may close.
      const state = raised instanceof PyError ? raised.exception.exception : undefined;
      if (state && this.finalizer.pending.size > 0) (state.tracebackFrames ??= []).push(frame);
      throw raised;
    } finally {
      this.popFrame();
      // The function's variables die with its frame, which closes a generator only they held.
      const { finalizer } = this;
      if (finalizer.pending.size > 0 && result !== undefined) {
        finalizer.release([...frame.locals.values()], [result]);
      }
    }
  }

  private newGenerator(fn: PyFunction, frame: Frame): PyGenerator {
    const { evaluator } = this;
    const body = evaluator.runGenerator(fn, frame);
    // The exceptions the generator handles where it suspended, which its caller does not handle.
    let handling: PyInstance[] = [];
    const { scope } = fn.def;
    const cls = scope.isAsync ? (scope.isGenerator ? asyncGeneratorClass : coroutineClass) : generatorClass;
    const generator: PyGenerator = new PyGenerator(
      cls,
      fn.name,
      fn.qualifiedName,
      (input) => {
        frame.callRow = this.currentRow;
        this.pushFrame(frame);
        const depth = evaluator.attachHandling(handling);
        let finished = true;
        try {
          const step = this.guardRecursion(() => (input.error ? body.throw(input.error) : body.next(input.value)));
          finished = step.done === true;
          return step;
        } finally {
          handling = evaluator.detachHandling(depth);
          this.popFrame();
          this.finalizer.update(generator, frame, finished);
        }
      },
      () => [
        ...frame.locals.values(),
        ...[...frame.cells.values()].map((cell) => cell.value),
        ...frame.temporaries,
        ...handling,
      ]
    );
    if (!scope.isAsync) markIterableCoroutine(generator, fn);
    return generator;
  }

  /** Runs a generator to its next `yield`, returning the value it yields or DONE when it ends. */
  resumeGenerator(generator: PyGenerator): PyValue | typeof DONE {
    const step = resumeGenerator(generator, { value: None });
    return step.done ? DONE : step.value;
  }

  instantiate(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
    return instantiate(cls, args, kwargs);
  }

  importModule(name: string): PyModule {
    return importModule(this, name);
  }

  // Delegated operations --------------------------------------------------------------------------------------------

  setUnion(set: PySet, others: PyValue[]): PySet {
    return setUnion(set, others);
  }

  setIntersection(set: PySet, other: PyValue): PySet {
    return setIntersection(set, other);
  }

  setDifference(set: PySet, other: PyValue): PySet {
    return setDifference(set, other);
  }

  setSymmetricDifference(set: PySet, other: PyValue): PySet {
    return setSymmetricDifference(set, other);
  }

  truthy(value: PyValue): boolean {
    return isTruthy(value);
  }

  tuple(items: PyValue[]): PyTuple {
    this.allocate(items.length);
    return newTuple(items);
  }

  indexError(message: string): PyError {
    return pyError('IndexError', message);
  }

  /** Runs a repr that may recurse into nested containers, bounding its depth as the call stack does. */
  nestedRepr<T>(run: () => T): T {
    if (this.reprDepth >= LIMITS.maxCallDepth)
      throw pyError('RecursionError', 'maximum recursion depth exceeded while getting the repr of an object');
    this.reprDepth++;
    try {
      return run();
    } finally {
      this.reprDepth--;
    }
  }

  // Services for builtins ------------------------------------------------------------------------------------------

  readonly none = None;
  /** The annotations of each class body, evaluated when the program reads `__annotations__` or `@dataclass` does. */
  readonly classAnnotationThunks = new Map<PyClass, [string, () => PyValue][]>();
  readonly frozenDataclasses = new Set<PyClass>();
  private readonly streams = new Map<string, PyValue>();

  classAnnotations(cls: PyClass): [PyValue, PyValue][] {
    return (this.classAnnotationThunks.get(cls) ?? []).map(([name, thunk]) => [name, thunk()]);
  }

  isFrozenDataclass(cls: PyClass): boolean {
    return cls.mro.some((each) => this.frozenDataclasses.has(each));
  }

  frozenInstanceError(message: string): PyError {
    const cls = this.importModule('dataclasses').dict.get('FrozenInstanceError') as PyClass;
    return new PyError(newException(cls, [message]));
  }

  exceptionClass(name: string): PyClass {
    return exceptionClassNamed(name);
  }

  hashOf(value: PyValue): bigint {
    return pyHash(value);
  }

  isLookupError(error: unknown): boolean {
    return error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('LookupError'));
  }

  keyError(key: PyValue): PyError {
    return keyError(key);
  }

  valueErrorOf(message: string): PyError {
    return valueError(message);
  }

  listOf(items: PyValue[]): PyList {
    this.allocate(items.length + 1);
    return newList(items);
  }

  toArray(value: PyValue): PyValue[] {
    return toArray(value);
  }

  setAttributeOf(target: PyValue, name: string, value: PyValue): void {
    setAttribute(target, name, value);
  }

  unsupported(feature: string): UnsupportedFeatureError {
    return new UnsupportedFeatureError(feature);
  }

  systemExit(code: PyValue | undefined): PyError {
    return systemExitError(code);
  }

  /** `int | None` and the like, which isinstance accepts and type hints use. */
  unionType(left: PyValue, right: PyValue): PyValue {
    const items = [...unionMembers(left), ...unionMembers(right)];
    const text = items
      .map((item) => (item instanceof PyClass ? item.qualifiedName : item === None ? 'None' : pyRepr(item)))
      .join(' | ');
    return new PyOpaque(unionClass, text, items);
  }

  /** The value of a key missing from a dict: a Counter's zero, a defaultdict's default, or a KeyError. */
  missingKey(dict: PyDict, key: PyValue): PyValue {
    const missing = overriding(dict, '__missing__');
    if (missing !== undefined) return callValue(bindValue(missing, dict), [key]);
    if (dict.defaultFactory !== undefined && dict.defaultFactory !== None) {
      const value = callValue(dict.defaultFactory, []);
      dict.store.set(key, value);
      return value;
    }
    if (dict.cls.mro.some((cls) => cls.isBuiltin && cls.name === 'Counter')) return 0n;
    throw keyError(key);
  }

  /** `cls[key]`: an Enum member by name, or a generic alias such as `list[int]`. */
  classItem(cls: PyClass, key: PyValue): PyValue {
    if (cls.isSubclassOf(genericClass)) return subscriptGeneric(cls, key);
    if (cls.enumMembers) {
      const member = cls.enumMembers.find((each) => each.dict.get('_name_') === key) ?? cls.dict.get(key as string);
      if (member === undefined || !(member instanceof PyInstance) || member.enumValue === undefined)
        throw keyError(key);
      return member;
    }
    const classGetItem = cls.isBuiltin ? undefined : cls.lookup('__class_getitem__');
    if (classGetItem !== undefined) return callValue(bindValue(classGetItem, cls, cls), [key]);
    if (cls.isBuiltin) return genericAlias(cls, key);
    throw typeError(`type '${cls.qualifiedName}' is not subscriptable`);
  }

  /** The `self` and class that a zero-argument `super()` reads from the calling method. */
  zeroArgumentSuper(): PyValue {
    const frame = this.frame;
    const cls = frame.classCell?.value;
    const first = frame.fn?.def.params[0];
    if (!first) throw pyError('RuntimeError', 'super(): no arguments');
    if (!(cls instanceof PyClass)) throw pyError('RuntimeError', 'super(): __class__ cell not found');
    const self = frame.locals.get(first.name) ?? frame.cells.get(first.name)?.value;
    if (self === undefined) throw pyError('RuntimeError', 'super(): arg[0] deleted');
    return boundSuper(superClass, cls, self);
  }

  /** The object `print` writes to for `sys.stdout` or `sys.stderr`. */
  standardStream(name: 'stdout' | 'stderr'): PyValue {
    let stream = this.streams.get(name);
    if (!stream) {
      stream = createStream(this, name);
      this.streams.set(name, stream);
    }
    return stream;
  }

  dir(value: PyValue): PyList {
    return this.listOf(this.dirNames(value));
  }

  /** The sorted attribute names `dir()` lists, which AttributeError suggestions choose from. */
  dirNames(value: PyValue): string[] {
    const names = value instanceof PyModule ? new Set(value.dict.keys()) : objectAttributeNames(value);
    return [...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  idOf(value: PyValue): bigint {
    if (value instanceof PyObject) return BigInt(value.identity) * 48n + 4_362_076_160n;
    return pyHash(value) & 0xff_ff_ff_ffn;
  }

  // Garbage collection ----------------------------------------------------------------------------------------------

  /** Removes the turtles that no variable, object, or pending value can reach any more. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const { reached, scanned } = findReachableTurtles(this.roots());
    this.spend(Math.ceil(scanned / 64));
    this.world.retain((turtle) => reached.has(turtle));
  }

  /** The objects that variables, objects, or pending values still reach, which reference counting would keep. */
  reachableObjects(): Set<object> {
    const roots = [...this.evaluator.handledExceptions, ...this.modules.values(), ...this.roots()];
    const visited = findReachableObjects(roots);
    this.spend(Math.ceil(visited.size / 64));
    return visited;
  }

  private roots(): unknown[] {
    const roots: unknown[] = [];
    for (const frame of this.frames) {
      for (const value of frame.locals.values()) roots.push(value);
      for (const cell of frame.cells.values()) roots.push(cell.value);
      for (const value of frame.temporaries) roots.push(value);
      if (frame.globals !== frame.locals) for (const value of frame.globals.values()) roots.push(value);
    }
    if (this.threads) roots.push(...this.threads.roots());
    return roots;
  }
}

/** The error to raise for an error thrown while running Python code, turning the host's stack overflow into Python's. */
function recursionErrorFor(error: unknown): unknown {
  return isHostStackOverflow(error) ? pyError('RecursionError', 'maximum recursion depth exceeded') : error;
}

/** `list[int]` and the like, which type hints use. */
function genericAlias(cls: PyClass, key: PyValue): PyOpaque {
  const args = key instanceof PyTuple ? key.items : [key];
  const text = `${aliasTypeText(cls)}[${args.map((arg) => (arg instanceof PyClass ? aliasTypeText(arg) : arg instanceof PyOpaque ? arg.text : pyRepr(arg))).join(', ')}]`;
  const alias = new PyOpaque(typingClass, text, cls);
  aliasArguments.set(alias, args);
  return alias;
}

/** The arguments of each `list[int]`-like alias, which its `__args__` gives. */
const aliasArguments = new WeakMap<PyOpaque, readonly PyValue[]>();

for (const [name, read] of [
  ['__origin__', (alias: PyOpaque): PyValue => alias.data as PyClass],
  ['__args__', (alias: PyOpaque): PyValue => newTuple(aliasArguments.get(alias) ?? [])],
] as const) {
  typingClass.dict.set(
    name,
    new PyDescriptor(
      propertyClass,
      nativeFunction(name, ([self]) => read(self as PyOpaque))
    )
  );
}

function aliasTypeText(cls: PyClass): string {
  return cls.module === 'builtins' ? cls.qualifiedName : `${cls.module}.${cls.qualifiedName}`;
}

// `types.GenericAlias(origin, args)`, which `__class_getitem__ = classmethod(GenericAlias)` calls.
typingClass.construct = (_cls, args, kwargs) => {
  if (kwargs?.size) throw typeError('GenericAlias() takes no keyword arguments');
  if (args.length !== 2) throw typeError(`GenericAlias expected 2 arguments, got ${args.length}`);
  const [origin, key] = args;
  if (!(origin instanceof PyClass)) throw new UnsupportedFeatureError('クラス以外を元にした types.GenericAlias');
  return genericAlias(origin, key);
};

/** The types a `|` union holds, or the type itself. */
function unionMembers(value: PyValue): PyValue[] {
  return value instanceof PyOpaque && Array.isArray(value.data) ? (value.data as PyValue[]) : [value];
}

export { Frame, PyCell };

/**
 * Whether the host's stack ran out, which can happen before the call depth limit when each call nests many statements.
 * Only a type check is safe here: on an exhausted stack, even testing the message may overflow again.
 */
export function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError;
}

/** The attribute names `dir()` lists for an object other than a module. */
function objectAttributeNames(value: PyValue): Set<string> {
  const names = new Set<string>();
  const add = (keys: Iterable<string>): void => {
    for (const name of keys) names.add(name);
  };
  const cls = value instanceof PyClass ? value : classOf(value);
  for (const each of cls.mro) add(each.dict.keys());
  if (value instanceof PyInstance || value instanceof PyFunction) add(value.dict.keys());
  add(['__class__', '__doc__']);
  if (value instanceof PyClass || value instanceof PyInstance) add(['__dict__', '__module__']);
  if (value instanceof PyInstance && value.exception) {
    add(['args', '__traceback__', '__cause__', '__context__', '__suppress_context__']);
  }
  if (value instanceof PyInstance && value.enumValue !== undefined) add(['name', 'value']);
  return names;
}
