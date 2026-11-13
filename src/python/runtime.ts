// code-gauge-allow-file fileNcss 495 -- The state of a run and the operations the interpreter reaches through it.
import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import { TurtleWorld } from '../interpreter/turtleWorld';
import { PyAnnotateFunction } from './annotations';
import { pushAll } from './arrays';
import { createBuiltins } from './builtins';
import type { PyMemoryView } from './bytesValues';
import { bindArguments } from './calls';
import { markIterableCoroutine } from './coroutines';
import { ensureThreadLocalDict, isThreadLocal } from './descriptors';
import { enumClassDir, enumMemberDir, membersByName } from './enums';
import { Evaluator } from './evaluator';
import { GeneratorFinalizer } from './finalization';
import { Frame } from './frame';
import { findReachableObjects, findReachableTurtles } from './garbageCollection';
import { resumeGenerator } from './generators';
import { pyHash } from './hashing';
import { hostRoots } from './hostRoots';
import { deepNestingError, isHostStackOverflow } from './hostStack';
import { instantiate } from './instances';
import { keyError } from './items';
import { viewOf } from './memoryview';
import { importModule, resolveImport } from './modules';
import { systemExitError } from './modules/sys';
import { checkNamespaceView, cpythonDirNames } from './namespaceDifferences';
import { DEFAULT_MAX_STR_DIGITS } from './numbers';
import { bindValue, callValue, getIterator, isTruthy, overriding, setAttribute, toArray } from './objects';
import type { ProgramSource } from './programSource';
import { withoutCharge } from './runtimeContext';
import { setDifference, setIntersection, setSymmetricDifference, setUnion } from './setOperations';
import { createStream } from './streams';
import { DEFAULT_SWITCH_INTERVAL, type Scheduler } from './threads';
import { frameReferences, noteUnwinding, setFrameGenerator } from './tracebacks';
import { newGenericAlias, unionOf } from './typeHints';
import { boundSuper } from './typeObject';
import { genericClass, subscriptGeneric } from './typeParams';
import {
  asyncGeneratorClass,
  classOf,
  coroutineClass,
  exceptionClassNamed,
  generatorClass,
  newList,
  newTuple,
  None,
  pyError,
  superClass,
  typeError,
  valueError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import { unsupportedClassAttributeNames } from './unsupportedAttributes';
import {
  DONE,
  type Kwargs,
  PyCell,
  PyClass,
  type PyDict,
  PyError,
  PyFunction,
  PyGenerator,
  PyInstance,
  PyIterator,
  type PyList,
  PyModule,
  PyObject,
  type PySet,
  type PyTuple,
  type PyValue,
} from './values';
import { hasWeakCallbacks, runWeakCallbacks } from './weakReferences';

/**
 * How a call of a program's function starts: the frame its body runs in, with whether the evaluator called it itself,
 * or the value the call gives at once, a generator or what a compiler's `__annotate__` computes.
 */
export type FunctionEntry =
  | { frame: Frame; direct: boolean; value?: undefined }
  | { frame?: undefined; value: PyValue };

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
  /** The row each running frame was entered from, which its own statements replace while it runs. */
  private readonly entryRows: (number | undefined)[] = [];
  /** The program's source and definitions, which `inspect.getsource()` reads. */
  program?: ProgramSource;
  /** The scheduler of the program's threads, once it starts one or waits. */
  threads?: Scheduler;
  /** The program's module variables, which the bottom frame of the main thread holds. */
  mainGlobals?: Map<string, PyValue>;
  /**
   * Whether the program nests expressions or statements so deeply that evaluating them may exhaust the host's stack
   * where CPython's does not, which then stops the program instead of raising RecursionError.
   */
  deepNesting = false;
  /** The globals of the standard library modules written in Python. */
  readonly libraryNamespaces = new WeakSet<Map<string, PyValue>>();
  /** Whether any library module written in Python was imported, without which no frame is a library frame. */
  private hasLibraryNamespaces = false;
  private readonly libraryEntryRows = new WeakMap<Frame, number | undefined>();
  /** The allocations after which CPython's automatic collector could have collected cyclic garbage with `__del__`. */
  cyclicGarbageDeadline: number | undefined;
  private slots = 0;
  private reprDepth = 0;

  /** The standard streams and files of the run; Python writes standard output only. */
  readonly io: ProgramIO;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
    this.builtins = createBuiltins();
    this.evaluator = new Evaluator(this);
  }

  get frame(): Frame {
    return this.frames.at(-1) as Frame;
  }

  // Budget ----------------------------------------------------------------------------------------------------------

  /** The operations the run has spent, which the thread scheduler measures slices with. */
  operations = 0;
  /** How many builds that charge nothing are running; the run itself stays installed for them. */
  private freeBuilds = 0;
  /** How many trace displays are being built, during which the program's own code must not run. */
  private displaying = 0;

  /** Builds a value at no charge; see the function of the same name in runtimeContext. */
  /**
   * Builds the text a trace shows for a value, charging nothing and refusing to run the program's own code (a
   * `__repr__` it defines), which would record steps and print where CPython runs nothing.
   */
  forDisplay<T>(build: () => T): T {
    this.displaying++;
    try {
      return this.withoutCharge(build);
    } finally {
      this.displaying--;
    }
  }

  withoutCharge<T>(build: () => T): T {
    this.freeBuilds++;
    try {
      return build();
    } finally {
      this.freeBuilds--;
    }
  }

  spend(cost = 1): void {
    if (this.freeBuilds === 0) {
      this.operations += cost;
      this.budget.spend(cost);
    }
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
    if (this.cyclicGarbageDeadline !== undefined && this.slots > this.cyclicGarbageDeadline) {
      this.finalizer.automaticCollectionDue();
    }
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
    if (a < SAFE_INTEGER_BOUND && a > -SAFE_INTEGER_BOUND && b < SAFE_INTEGER_BOUND && b > -SAFE_INTEGER_BOUND) return;
    this.chargeBits(BigInt(a.toString(16).length * 4 + b.toString(16).length * 4));
  }

  // Frames and calls ------------------------------------------------------------------------------------------------

  /** Whether the running code is a standard library module's written in Python. */
  inLibraryCode(): boolean {
    const frame = this.frames.at(-1);
    return frame !== undefined && this.libraryNamespaces.has(frame.globals);
  }

  /** Marks the globals of a standard library module written in Python, whose frames stay out of the trace. */
  addLibraryNamespace(namespace: Map<string, PyValue>): void {
    this.libraryNamespaces.add(namespace);
    this.hasLibraryNamespaces = true;
  }

  pushFrame(frame: Frame): void {
    if (this.frames.length >= Math.min(this.recursionLimit, LIMITS.maxCallDepth)) {
      throw pyError('RecursionError', 'maximum recursion depth exceeded');
    }
    if (this.displaying > 0 && !this.libraryNamespaces.has(frame.globals)) throw new ProgramCodeInDisplayError();
    if (this.hasLibraryNamespaces) this.noteLibraryFrame(frame);
    frame.nativeCalls = this.nativeCalls;
    this.frames.push(frame);
    this.entryRows.push(this.currentRow);
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
    this.currentRow = this.entryRows.pop();
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
      if (!frame.inlinedIn) row = frame.callRow ?? frame.resumeRow;
    }
    return result;
  }

  /**
   * Every frame with the row it is running, innermost first. A library module's frame counts as running the program's
   * row that entered it, since its own rows are not the program's.
   */
  allFrames(): { frame: Frame; row: number | undefined }[] {
    const result: { frame: Frame; row: number | undefined }[] = [];
    let row = this.callerRow();
    for (const frame of this.frames.toReversed()) {
      result.push({ frame, row });
      if (!frame.inlinedIn) {
        row = this.libraryEntryRows.has(frame) ? this.libraryEntryRows.get(frame) : (frame.callRow ?? frame.resumeRow);
      }
    }
    return result;
  }

  /** The program's row that the running code counts as, which is the row that entered a library module's code. */
  private callerRow(): number | undefined {
    const top = this.frames.at(-1);
    return top && this.libraryEntryRows.has(top) ? this.libraryEntryRows.get(top) : this.currentRow;
  }

  /** Runs `run`, turning a refusal of the host into the exception Python raises for it. */
  guardRecursion<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      throw hostRefusal(error, this.deepNesting) ?? error;
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

  // code-gauge-allow duplicateLines 15 -- The synchronous and suspending calls of a function share entry and exit, not the body's run.
  callFunction(fn: PyFunction, args: readonly PyValue[], kwargs: Kwargs): PyValue {
    const entry = this.enterFunction(fn, args, kwargs);
    if (!entry.frame) return entry.value;
    let result: PyValue | undefined;
    try {
      result = this.evaluator.runFunction(fn, entry.frame);
      this.finalizer.locals.returned(result, entry.direct);
    } catch (error) {
      throw this.unwindFunction(entry.frame, error);
    } finally {
      this.leaveFunction(entry.frame, result);
    }
    this.handToNative(result);
    return result;
  }

  /**
   * Starts a call of a program's function, which `callFunction` and a thread's suspending call share: the frame its
   * body then runs in, pushed, or the value the call gives without running the body in a frame.
   */
  enterFunction(fn: PyFunction, args: readonly PyValue[], kwargs: Kwargs): FunctionEntry {
    const { locals } = this.finalizer;
    const direct = locals.takeDirectCall();
    const frame = this.newFunctionFrame(fn, args, kwargs);
    // The compiler's `__annotate__` binds its arguments as a Python function and runs its body natively.
    if (fn instanceof PyAnnotateFunction) return { value: fn.run(frame.locals.get('format') as PyValue) };
    const { scope } = fn.def;
    if (scope.isGenerator || scope.isAsync) return { value: this.newGenerator(fn, frame) };
    locals.enterFunction(frame);
    this.pushFrame(frame);
    return { frame, direct };
  }

  /** The error to raise for `error`, which ends the call running in `frame`. */
  unwindFunction(frame: Frame, error: unknown): unknown {
    const raised = hostRefusal(error, this.deepNesting) ?? error;
    noteUnwinding(raised);
    // The exception's traceback keeps the frame, and with it the function's variables, while a generator may close.
    const state = raised instanceof PyError ? raised.exception.exception : undefined;
    if (state && this.finalizer.pending.size > 0) {
      this.finalizer.locals.escapeFrame(frame);
    }
    return raised;
  }

  /** Ends the call running in `frame`, which returned `result`, or raised when it is undefined. */
  leaveFunction(frame: Frame, result: PyValue | undefined): void {
    this.popFrame();
    if (hasWeakCallbacks(this)) runWeakCallbacks([result]);
    const { finalizer } = this;
    if (finalizer.pending.size > 0 && result !== undefined) {
      finalizer.release(frameReferences(frame), [result]);
    }
  }

  private newGenerator(fn: PyFunction, frame: Frame): PyGenerator {
    const { scope } = fn.def;
    const cls = scope.isAsync ? (scope.isGenerator ? asyncGeneratorClass : coroutineClass) : generatorClass;
    const generator = this.frameGenerator(
      cls,
      fn.name,
      fn.qualifiedName,
      frame,
      this.evaluator.runGenerator(fn, frame)
    );
    if (!scope.isAsync) markIterableCoroutine(generator, fn);
    this.finalizer.locals.generatorCreated(generator, frame);
    return generator;
  }

  /**
   * The coroutine that code compiled with `ast.PyCF_ALLOW_TOP_LEVEL_AWAIT` gives when it awaits: running it runs the
   * code in `frame`, a frame of its own over the namespaces exec() or eval() gave.
   */
  newModuleCoroutine(frame: Frame, body: Generator<PyValue, PyValue, PyValue>): PyGenerator {
    return this.frameGenerator(coroutineClass, '<module>', '<module>', frame, body);
  }

  /** A generator, coroutine, or async generator object that runs `body` in `frame` step by step. */
  // code-gauge-allow functionNcss 35 -- Frame entry and exit must keep exception, trace, and ownership state in one try/finally.
  // code-gauge-allow functionCognitiveComplexity 16 -- Frame entry and exit keep exception, trace and ownership state together.
  frameGenerator(
    cls: PyClass,
    name: string,
    qualifiedName: string,
    frame: Frame,
    body: Generator<PyValue, PyValue, PyValue>
  ): PyGenerator {
    const { evaluator } = this;
    // The exceptions the generator handles where it suspended, which its caller does not handle.
    let handling: PyInstance[] = [];
    let completed = false;
    const holds = (): unknown[] => [...frameReferences(frame), ...handling];
    const generator: PyGenerator = new PyGenerator(
      cls,
      name,
      qualifiedName,
      (input) => {
        const callerRow = this.currentRow;
        if (frame.kind === 'comprehension') frame.resumeRow = callerRow;
        frame.callRow = frame.kind === 'comprehension' ? undefined : callerRow;
        this.pushFrame(frame);
        const depth = evaluator.attachHandling(handling);
        let finished = true;
        let step: IteratorResult<PyValue, PyValue> | undefined;
        let escaping: PyValue | undefined;
        try {
          step = this.guardRecursion(() => (input.error ? body.throw(input.error) : body.next(input.value)));
          finished = step.done === true;
          return step;
        } catch (error) {
          if (error instanceof PyError) escaping = error.exception;
          noteUnwinding(error);
          throw error;
        } finally {
          handling = evaluator.detachHandling(depth);
          this.popFrame();
          // The caller goes on at the row that resumed the generator, as its later calls and errors report.
          this.currentRow = callerRow;
          this.finalizer.update(generator, frame, finished);
          if (finished) {
            const dropped = holds();
            completed = true;
            this.finalizer.release(dropped, [step?.value, escaping]);
          }
        }
      },
      () => (completed ? [] : holds())
    );
    generator.frame = frame;
    setFrameGenerator(frame, generator);
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

  /** Imports a module as an import statement does, which may give what a program put in `sys.modules`. */
  resolveImport(name: string): PyValue {
    return resolveImport(this, name);
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
  /** The switch interval of `sys.setswitchinterval`, in microseconds, which scales the thread scheduler's slice. */
  switchInterval = DEFAULT_SWITCH_INTERVAL;
  private readonly streams = new Map<string, PyValue>();
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

  /** The memoryview `memoryview(value)` gives. */
  bufferView(value: PyValue): PyMemoryView {
    return viewOf(value);
  }

  /** `int | None` and the like, which isinstance accepts and type hints use. */
  unionType(left: PyValue, right: PyValue): PyValue {
    return unionOf([left, right]);
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
    if (cls.flags.isEnum) {
      if (typeof key !== 'string') {
        pyHash(key);
        throw keyError(key);
      }
      const member = membersByName(cls).get(key) ?? cls.dict.get(key);
      if (member === undefined || !(member instanceof PyInstance) || member.enumValue === undefined)
        throw keyError(key);
      return member;
    }
    const classGetItem = cls.isBuiltin ? cls.dict.get('__class_getitem__') : cls.lookup('__class_getitem__');
    if (classGetItem !== undefined) return callValue(bindValue(classGetItem, cls, cls), [key]);
    if (cls.isBuiltin) return newGenericAlias(cls, key);
    throw typeError(`type '${cls.qualifiedName}' is not subscriptable`);
  }

  /** The `self` and class that a zero-argument `super()` reads from the calling method. */
  zeroArgumentSuper(): PyValue {
    // A list, set, or dict comprehension runs inline in its function's frame, as CPython compiles it (PEP 709).
    let frame = this.frame;
    while (frame.inlinedIn) frame = frame.inlinedIn;
    const cls = frame.classCell?.value;
    const self = frame.kind === 'comprehension' ? genexprArgument(frame) : firstParameterOf(frame);
    if (!(cls instanceof PyClass)) throw pyError('RuntimeError', 'super(): __class__ cell not found');
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

  /** The sorted attribute names `dir()` lists. */
  dirNames(value: PyValue): string[] {
    checkNamespaceView(value, 'dir()');
    return this.listedNames(value);
  }

  /**
   * The sorted names an AttributeError suggestion chooses from: those CPython's `dir()` lists, which a namespace that
   * differs from CPython's does not refuse to give.
   */
  suggestionNames(value: PyValue): string[] {
    return sortedNames(cpythonDirNames(value, this.listedNames(value)));
  }

  private listedNames(value: PyValue): string[] {
    if (value instanceof PyClass && value.flags.isEnum && value.enumMembers) return enumClassDir(value, this);
    if (value instanceof PyInstance && value.enumValue !== undefined) return enumMemberDir(value, this);
    // A module lists the names this grader does not support too, as CPython's module has them.
    const names =
      value instanceof PyModule
        ? new Set([...value.dict.keys(), ...value.unsupported.keys(), ...value.imports.keys()])
        : new Set([...objectAttributeNames(value), ...unsupportedClassAttributeNames(value)]);
    return sortedNames(names);
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
    const { reached, scanned } = findReachableTurtles(this.roots());
    this.spend(Math.ceil(scanned / 64));
    this.world.retain((turtle) => reached.has(turtle));
  }

  /** The objects that variables, objects, or pending values still reach, which reference counting would keep. */
  reachableObjects(inFlight: unknown[] = []): Set<object> {
    const roots = [...inFlight, ...this.evaluator.handledExceptions, ...this.modules.values(), ...this.roots()];
    const visited = findReachableObjects(roots);
    this.spend(Math.ceil(visited.size / 64));
    return visited;
  }

  private roots(): unknown[] {
    const roots: unknown[] = [this.nativeRoots];
    for (const frame of this.frames) pushAll(roots, frameReferences(frame));
    pushAll(roots, hostRoots(this));
    pushAll(roots, this.finalizer.finalizing());
    return roots;
  }
}

/** Stops a trace display that reached the program's own code, which then shows no value. */
class ProgramCodeInDisplayError extends Error {}

/**
 * The Python exception for an error of the host itself: RecursionError (or the deep-nesting unsupported error) when its
 * stack ran out, and MemoryError when it refused a value for its size (a string, an array, or an integer beyond what it
 * can hold).
 */
export function hostRefusal(error: unknown, deepNesting = false): PyError | UnsupportedFeatureError | undefined {
  if (!(error instanceof RangeError)) return undefined;
  if (isHostStackOverflow(error)) {
    return deepNesting ? deepNestingError() : pyError('RecursionError', 'maximum recursion depth exceeded');
  }
  return withoutCharge(() => pyError('MemoryError'));
}

export { Frame, PyCell };
export { isHostStackOverflow } from './hostStack';

/** The attributes of a function that its class reads natively. */
function sortedNames(names: Iterable<string>): string[] {
  return [...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const FUNCTION_ATTRIBUTES = [
  '__annotate__',
  '__annotations__',
  '__defaults__',
  '__dict__',
  '__kwdefaults__',
  '__module__',
  '__name__',
  '__qualname__',
  '__type_params__',
];

/** The attributes of each kind of generator object that its class reads natively. */
const GENERATOR_ATTRIBUTES: Record<string, string[]> = {
  generator: ['gi_code', 'gi_frame', 'gi_yieldfrom'],
  coroutine: ['cr_await', 'cr_code', 'cr_frame', 'cr_origin', 'cr_running', 'cr_suspended'],
  async_generator: ['ag_await', 'ag_code', 'ag_frame', 'ag_running', 'ag_suspended'],
};

/** The attribute names `dir()` lists for an object other than a module. */
// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of object whose attributes dir() lists.
function objectAttributeNames(value: PyValue): Set<string> {
  const names = new Set<string>();
  const add = (keys: Iterable<string>): void => {
    for (const name of keys) names.add(name);
  };
  const cls = value instanceof PyClass ? value : classOf(value);
  for (const each of cls.mro) add(each.dict.keys());
  if (value instanceof PyInstance || value instanceof PyFunction) add(value.dict.keys());
  if (isThreadLocal(value)) add(ensureThreadLocalDict(value)?.keys() ?? []);
  if (value instanceof PyObject && value.instanceDict) add(value.instanceDict.keys());
  if (value instanceof PyObject && value.slotValues) add(value.slotValues.keys());
  add(['__class__', '__doc__']);
  if (!cls.isBuiltin || (value instanceof PyClass && !value.isBuiltin)) add(['__module__']);
  if (value instanceof PyFunction) add(FUNCTION_ATTRIBUTES);
  if (value instanceof PyGenerator) add(GENERATOR_ATTRIBUTES[value.cls.name] ?? []);
  if (value instanceof PyInstance && value.exception) {
    add(['__dict__', 'args', '__traceback__', '__cause__', '__context__', '__suppress_context__']);
  }
  if (value instanceof PyInstance && value.enumValue !== undefined) add(['name', 'value']);
  return names;
}

/** The value of a function frame's first parameter, which a zero-argument `super()` takes as its object. */
function firstParameterOf(frame: Frame): PyValue | undefined {
  const first = frame.fn?.def.params[0];
  if (!first) throw pyError('RuntimeError', 'super(): no arguments');
  return frame.locals.get(first.name) ?? frame.cells.get(first.name)?.value;
}

/**
 * A generator expression's first argument, the iterator of its first iterable, which CPython's `super()` there takes
 * as its object; an iterable read natively is given the iterator CPython would have made of it.
 */
function genexprArgument(frame: Frame): PyValue | undefined {
  const first = frame.firstArgument;
  return first === undefined || first instanceof PyIterator || first instanceof PyGenerator
    ? first
    : getIterator(first);
}
