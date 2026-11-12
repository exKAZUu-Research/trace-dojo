import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import { TurtleWorld } from '../interpreter/turtleWorld';
import { LIBRARY_ROW } from './ast';
import { createBuiltins } from './builtins';
import { bindArguments } from './calls';
import { instantiate } from './classes';
import { Evaluator } from './evaluator';
import { type AnnotationThunk, Frame } from './frame';
import { findReachableTurtles } from './garbageCollection';
import { pyHash } from './hashing';
import { keyError } from './items';
import { importModule } from './modules';
import { systemExitError } from './modules/sys';
import { DEFAULT_MAX_STR_DIGITS } from './numbers';
import { bindValue, callValue, isTruthy, lookupSpecial, setAttribute, toArray } from './objects';
import { withoutCharge } from './runtimeContext';
import { setDifference, setIntersection, setSymmetricDifference, setUnion } from './setOperations';
import { createStream } from './streams';
import { newGenericAlias, unionClass, unionGetItem } from './typeHints';
import {
  classOf,
  exceptionClassNamed,
  generatorClass,
  moduleClass,
  newDict,
  newList,
  newTuple,
  None,
  pyError,
  superClass,
  typeClass,
  typeError,
  valueError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  DONE,
  type Kwargs,
  ownAttributesOf,
  PyCell,
  PyClass,
  PyDescriptor,
  PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  type PyList,
  PyModule,
  PyObject,
  type PySet,
  PySuper,
  type PyTuple,
  type PyValue,
} from './values';

export class Runtime {
  readonly world = new TurtleWorld();
  readonly budget = new ExecutionBudget();
  readonly steps = new StepTracker();
  readonly frames: Frame[] = [];
  readonly builtins: Map<string, PyValue>;
  readonly modules = new Map<string, PyModule>();
  readonly evaluator: Evaluator;
  private row: number | undefined;
  /** The row each running frame was entered from, which its own statements replace while it runs. */
  private readonly entryRows: (number | undefined)[] = [];
  /** The classes this run defined, by base class: builtin classes outlive a run, so they cannot hold them. */
  private readonly subclasses = new Map<PyClass, PyClass[]>();
  private slots = 0;
  private reprDepth = 0;

  /** The standard streams and files of the run; Python writes standard output only. */
  readonly io: ProgramIO;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
    this.builtins = createBuiltins();
    this.evaluator = new Evaluator(this);
  }

  /** The row of the call being evaluated, from which calls the interpreter makes implicitly count as called. */
  get currentRow(): number | undefined {
    return this.row;
  }

  /** Library code keeps the row of the program's code that called it. */
  set currentRow(row: number | undefined) {
    if (row !== LIBRARY_ROW) this.row = row;
  }

  get frame(): Frame {
    return this.frames.at(-1) as Frame;
  }

  // Budget ----------------------------------------------------------------------------------------------------------

  /** How many builds that charge nothing are running; the run itself stays installed for them. */
  private freeBuilds = 0;

  /** Builds a value at no charge; see the function of the same name in runtimeContext. */
  withoutCharge<T>(build: () => T): T {
    this.freeBuilds++;
    try {
      return build();
    } finally {
      this.freeBuilds--;
    }
  }

  spend(cost = 1): void {
    if (this.freeBuilds === 0) this.budget.spend(cost);
  }

  scan(length: number): void {
    this.spend(Math.ceil(length / 64));
  }

  /** The slots charged so far, which only grows: a run pays for storage it has dropped too. */
  get allocatedSlots(): number {
    return this.slots;
  }

  /** Charges storage about to be created. Storage it refuses is not charged, so a program may catch the error. */
  allocate(count: number): void {
    if (this.freeBuilds > 0) return;
    this.ensureRoom(count);
    this.slots += count;
    this.spend(Math.ceil(count / 64));
  }

  /**
   * Refuses storage of a size the program chose before a JavaScript array of that size is built. It charges nothing:
   * the storage charges itself once created.
   */
  ensureRoom(count: number): void {
    if (this.slots + count > LIMITS.maxSlots) throw withoutCharge(() => pyError('MemoryError'));
  }

  buildString(length: number): void {
    this.ensureStringFits(length);
    this.spend(Math.ceil(length / 16));
  }

  /** Refuses a string of a length the program chose before the host builds it, charging nothing. */
  ensureStringFits(length: number): void {
    if (length > LIMITS.maxStringLength) throw pyError('MemoryError');
  }

  /**
   * The exception for a JavaScript TypeError or ReferenceError that a native function threw, a slip of the interpreter
   * rather than a refusal, which the program can still handle and whose text keeps the host's message.
   */
  internalError(error: TypeError | ReferenceError): PyError {
    return pyError('SystemError', `internal error: ${error.message}`);
  }

  /** Charges for an integer of `bits` bits about to be computed, refusing ones that would exhaust memory. */
  chargeBits(bits: bigint): void {
    if (bits > BigInt(LIMITS.maxStringLength) * 8n) throw pyError('MemoryError');
    this.spend(Math.ceil(Number(bits) / 1024));
  }

  chargeBigint(a: bigint, b: bigint): void {
    if (a < 1n << 53n && a > -(1n << 53n) && b < 1n << 53n && b > -(1n << 53n)) return;
    this.chargeBits(BigInt(a.toString(16).length * 4 + b.toString(16).length * 4));
  }

  // Frames and calls ------------------------------------------------------------------------------------------------

  pushFrame(frame: Frame): void {
    if (this.frames.length >= LIMITS.maxCallDepth) throw pyError('RecursionError', 'maximum recursion depth exceeded');
    frame.nativeCalls = this.nativeCalls;
    this.frames.push(frame);
    this.entryRows.push(this.row);
  }

  popFrame(): void {
    const frame = this.frames.pop();
    this.row = this.entryRows.pop();
    if (frame?.isAtomic) this.steps.completeAtomicCall();
  }

  /** Runs `run`, turning a refusal of the host into the exception Python raises for it. */
  guardRecursion<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      throw hostRefusal(error) ?? error;
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
    // A call into library code is part of the step of the program's code that made it.
    const callRow = def.row === LIBRARY_ROW ? undefined : this.currentRow;
    return new Frame('function', locals, cells, fn.globals, callRow, def.isAtomic, def.scope, fn, fn.classCell);
  }

  callFunction(fn: PyFunction, args: readonly PyValue[], kwargs: Kwargs): PyValue {
    const frame = this.newFunctionFrame(fn, args, kwargs);
    if (fn.def.scope.isGenerator) return this.newGenerator(fn, frame);
    this.pushFrame(frame);
    let result: PyValue;
    try {
      result = this.guardRecursion(() => this.evaluator.runFunction(fn, frame));
    } finally {
      this.popFrame();
    }
    this.handToNative(result);
    return result;
  }

  private newGenerator(fn: PyFunction, frame: Frame): PyGenerator {
    const body = this.evaluator.runGenerator(fn, frame);
    let handled: PyInstance[] = [];
    const generator: PyGenerator = new PyGenerator(
      generatorClass,
      fn.name,
      fn.qualifiedName,
      () => {
        if (fn.def.row !== LIBRARY_ROW) frame.callRow = this.currentRow;
        this.pushFrame(frame);
        const depth = this.evaluator.resumeHandling(handled);
        try {
          return this.guardRecursion(() => body.next());
        } finally {
          handled = this.evaluator.suspendHandling(depth);
          this.popFrame();
        }
      },
      () => [
        ...frame.locals.values(),
        ...[...frame.cells.values()].map((cell) => cell.value),
        ...frame.temporaries,
        ...handled,
      ]
    );
    return generator;
  }

  /** Runs a generator to its next `yield`, returning the value it yields or DONE when it ends. */
  resumeGenerator(generator: PyGenerator): PyValue | typeof DONE {
    if (generator.finished) {
      // Only the call that observed the end may report the return value; any later call ends without it.
      generator.returned = undefined;
      return DONE;
    }
    if (generator.running) throw pyError('ValueError', 'generator already executing');
    generator.running = true;
    generator.started = true;
    try {
      const result = generator.resume();
      if (result.done) {
        generator.finished = true;
        if (result.value !== None) generator.returned = result.value;
        return DONE;
      }
      this.handToNative(result.value);
      return result.value;
    } catch (error) {
      generator.finished = true;
      if (error instanceof PyError && error.exception.cls.name === 'StopIteration') {
        throw pyError('RuntimeError', 'generator raised StopIteration');
      }
      throw error;
    } finally {
      generator.running = false;
    }
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
  /** The limit sys.set_int_max_str_digits sets, 0 for none. */
  intMaxStrDigits = DEFAULT_MAX_STR_DIGITS;
  private builtinsModuleValue: PyModule | undefined;

  /** The builtins module, which is the `__self__` of the builtin functions. */
  builtinsModule(): PyModule {
    this.builtinsModuleValue ??= new PyModule(moduleClass, 'builtins', this.builtins);
    return this.builtinsModuleValue;
  }
  /** The annotations of each class body, evaluated when the program reads `__annotations__` or `@dataclass` does. */
  readonly classAnnotationThunks = new Map<PyClass, AnnotationThunk[]>();
  /** The class whose annotations are being read in the FORWARDREF format, in which undefined names are forward references. */
  forwardRefOwner: PyClass | undefined;

  withForwardRefOwner<T>(owner: PyClass, run: () => T): T {
    const outer = this.forwardRefOwner;
    this.forwardRefOwner = owner;
    try {
      return run();
    } finally {
      this.forwardRefOwner = outer;
    }
  }
  private readonly streams = new Map<string, PyValue>();

  /** The entries of a class's `__annotations__`, which `@dataclass` and `get_type_hints()` read as a program does. */
  classAnnotations(cls: PyClass): [PyValue, PyValue][] {
    const annotations = this.classAnnotationsValue(cls);
    return annotations instanceof PyDict ? annotations.store.ordered().map((entry) => [entry.key, entry.value]) : [];
  }

  /** A class's `__annotations__`: what the first read evaluated or the program assigned, as CPython keeps it. */
  classAnnotationsValue(cls: PyClass): PyValue {
    cls.annotations ??= newDict(this.evaluateClassAnnotations(cls));
    return cls.annotations;
  }

  evaluateClassAnnotations(cls: PyClass): [PyValue, PyValue][] {
    return (this.classAnnotationThunks.get(cls) ?? []).map(([name, thunk]) => [name, thunk()]);
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

  /** The value of a key missing from a dict: a Counter's zero, a defaultdict's default, or a KeyError. */
  missingKey(dict: PyDict, key: PyValue): PyValue {
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
    if (cls.enumMembers) {
      const member = cls.enumMembers.find((each) => each.dict.get('_name_') === key) ?? cls.dict.get(key as string);
      if (member === undefined || !(member instanceof PyInstance) || member.enumValue === undefined)
        throw keyError(key);
      return member;
    }
    // Builtin and library classes define __class_getitem__, which is a classmethod even without the decorator.
    const classGetItem = cls.lookup('__class_getitem__');
    if (classGetItem instanceof PyFunction) return callValue(classGetItem, [cls, key]);
    if (classGetItem instanceof PyDescriptor) return callValue(classGetItem.fn, [cls, key]);
    if (classGetItem !== undefined) return callValue(bindValue(classGetItem, cls, cls), [key]);
    if (cls === unionClass) return unionGetItem(key);
    if (cls === typeClass) return newGenericAlias(cls, key);
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
    const selfClass = self instanceof PyClass && self.isSubclassOf(cls) ? self : classOf(self);
    if (!selfClass.isSubclassOf(cls)) throw typeError('super(type, obj): obj must be an instance or subtype of type');
    return new PySuper(superClass, cls, self, selfClass);
  }

  /** The classes defined with `cls` as a base, for `__subclasses__()`. */
  subclassesOf(cls: PyClass): PyClass[] {
    let subclasses = this.subclasses.get(cls);
    if (!subclasses) {
      subclasses = [];
      this.subclasses.set(cls, subclasses);
    }
    return subclasses;
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

  /** `vars()` without an argument: the calling frame's variables. */
  localsOfCaller(): PyDict {
    const frame = this.frame;
    const dict = newDict(frame.locals.entries());
    for (const [name, cell] of frame.cells)
      if (cell.value !== undefined && frame.scope.cells.includes(name)) dict.store.set(name, cell.value);
    return dict;
  }

  dir(value: PyValue | undefined): PyList {
    if (value === undefined) {
      const frame = this.frame;
      return this.listOf([...frame.locals.keys()].toSorted());
    }
    return this.listOf(this.dirNames(value));
  }

  /** The sorted attribute names `dir()` lists, which AttributeError suggestions choose from. */
  dirNames(value: PyValue): string[] {
    const native = value instanceof PyClass ? undefined : classOf(value).mro.find((cls) => cls.dirNames)?.dirNames;
    if (native) return [...new Set(native(value))].toSorted(compareNames);
    const custom = value instanceof PyClass ? undefined : lookupSpecial(value, '__dir__');
    if (custom instanceof PyFunction)
      return this.toArray(callValue(bindValue(custom, value), []))
        .map(String)
        .toSorted(compareNames);
    const names = value instanceof PyModule ? new Set(value.names()) : objectAttributeNames(value);
    return [...names].toSorted(compareNames);
  }

  idOf(value: PyValue): bigint {
    if (value instanceof PyObject) return BigInt(value.identity) * 48n + 4_362_076_160n;
    return pyHash(value) & 0xff_ff_ff_ffn;
  }

  // Garbage collection ----------------------------------------------------------------------------------------------

  /** How many calls of native code are running. */
  private nativeCalls = 0;
  /** What Python code handed the running native calls, which they may hold where the collector cannot see. */
  private readonly nativeRoots: unknown[] = [];

  /**
   * Runs native code. What Python code hands it (a function's result, a generator's item) stays reachable until it
   * returns, and its own result passes on to the native code that called it.
   */
  runNative<T>(run: () => T): T {
    const roots = this.nativeRoots.length;
    this.nativeCalls++;
    let result: T;
    try {
      result = run();
    } finally {
      this.nativeCalls--;
      this.nativeRoots.length = roots;
    }
    this.handToNative(result);
    return result;
  }

  /** Keeps a value reachable while the native code it is handed to runs, if Python code hands it to native code. */
  handToNative(value: unknown): void {
    if (this.nativeCalls > (this.frames.at(-1)?.nativeCalls ?? 0)) this.nativeRoots.push(value);
  }

  /** Removes the turtles that no variable, object, pending value, or running native code can reach any more. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const roots: unknown[] = [this.nativeRoots];
    for (const frame of this.frames) {
      for (const value of frame.locals.values()) roots.push(value);
      for (const cell of frame.cells.values()) roots.push(cell.value);
      for (const value of frame.temporaries) roots.push(value);
      if (frame.globals !== frame.locals) for (const value of frame.globals.values()) roots.push(value);
    }
    const { reached, scanned } = findReachableTurtles(roots);
    this.spend(Math.ceil(scanned / 64));
    this.world.retain((turtle) => reached.has(turtle));
  }
}

export { Frame, PyCell };

/**
 * The Python exception for an error of the host itself: RecursionError when its stack ran out, which can happen before
 * the call depth limit when each call nests many statements, and MemoryError when it refused a value for its size
 * (a string, an array, or an integer beyond what it can hold).
 */
export function hostRefusal(error: unknown): PyError | undefined {
  if (!(error instanceof RangeError)) return undefined;
  return isHostStackOverflow(error)
    ? pyError('RecursionError', 'maximum recursion depth exceeded')
    : withoutCharge(() => pyError('MemoryError'));
}

function isHostStackOverflow(error: RangeError): boolean {
  try {
    // JavaScriptCore and V8 both word it "Maximum call stack size exceeded".
    return error.message.includes('call stack');
  } catch {
    // Reading the message overflowed again, so the stack is exhausted.
    return true;
  }
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The attribute names `dir()` lists for an object other than a module: its own and its class's, with their bases'. */
function objectAttributeNames(value: PyValue): Set<string> {
  const names = new Set<string>();
  const cls = value instanceof PyClass ? value : classOf(value);
  for (const each of cls.mro) for (const name of each.dict.keys()) names.add(name);
  if (value instanceof PyInstance || value instanceof PyFunction) for (const name of value.dict.keys()) names.add(name);
  for (const name of ownAttributesOf(value)?.keys() ?? []) names.add(name);
  return names;
}
