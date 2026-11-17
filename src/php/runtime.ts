// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { FunctionDecl, Program } from './ast';
import { dec } from './bytes';
import type { CompileNotice } from './converter';
import { collectBeforeAllocation, collectGarbage, releaseDropped } from './garbage';
import { MersenneTwister } from './random';
import {
  type Callable,
  type Method,
  type PhpArray,
  type PhpClass,
  PhpObject,
  Ref,
  setAllocationHandler,
  setDropHandler,
  type UserFunction,
  type Value,
} from './values';

/** The path PHP reports for the program in messages, as a file in the working directory. */
export const SCRIPT_PATH = '/main.php';

/** A PHP exception (a Throwable object) propagating through the host stack. */
export class PhpThrow {
  constructor(readonly object: PhpObject) {
    // The exception holds itself while it unwinds the statements it leaves, until a catch takes it.
    if (current) current.thrown = object;
  }
}

/** An error PHP cannot recover from, which ends the program with `Fatal error: ...`. */
/** Captures the calls running when a fatal error happens, which the call machinery provides. */
let captureCalls: () => unknown[] = () => [];

export function setCallCapture(capture: () => unknown[]): void {
  captureCalls = capture;
}

export class FatalError {
  /** The calls running when the error happened, innermost first. */
  readonly calls = captureCalls();

  constructor(
    readonly message: string,
    readonly row: number,
    /** Whether PHP ran out of memory, after which its trace shows only the innermost call. */
    readonly exhausted = false
  ) {}
}

/** Ends the program through `exit`, after which PHP still runs shutdown functions and destructors. */
export class ExitSignal {
  constructor(readonly status: number) {}
}

/** One entry of a stack trace, as `getTrace` reports it. */
export interface TraceEntry {
  row?: number;
  function: string;
  className?: string;
  type?: '->' | '::';
  args: Value[];
}

export class Frame {
  vars = new Map<string, Ref>();
  /** Values that an expression being evaluated holds, which garbage collection must keep. */
  temporaries: Value[] = [];
  args: Value[] = [];
  /** The row being run in this frame, which a stack trace reports for the call this frame made. */
  row = 0;
  /** The reference a function returning by reference returns. */
  returnRef?: Ref;
  /**
   * The value a `return` statement is returning, which the statements it leaves must not free; undefined until one
   * runs, as when the body ends without `return`.
   */
  returning: Value | undefined;

  // code-gauge-allow functionParameterCount 8 -- A frame takes the parts of a call that stay fixed while it runs.
  constructor(
    readonly fn: Callable | undefined,
    readonly callRow: number | undefined,
    readonly isAtomic: boolean,
    readonly thisObj?: PhpObject,
    /** The class whose code runs, which decides visibility and `self`. */
    readonly scope?: PhpClass,
    /** The class the call named, which `static` refers to. */
    readonly staticClass?: PhpClass,
    readonly method?: Method,
    readonly closure?: PhpObject
  ) {}

  get decl(): FunctionDecl | undefined {
    return this.fn?.kind === 'user' ? this.fn.decl : undefined;
  }
}

/** The order in which a program declared its global variables, which PHP's shutdown follows. */
export class Runtime {
  mbEncoding = 'utf8';
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly world = new TurtleWorld();
  readonly steps = new StepTracker();
  readonly frames: Frame[] = [];
  readonly globalFrame: Frame;
  readonly functions = new Map<string, Callable>();
  readonly classes = new Map<string, PhpClass>();
  /** Constants by name, whose namespace prefix is lowercased. */
  readonly constants = new Map<string, Value>();
  readonly objects = new Map<number, PhpObject>();
  private readonly freeHandles: number[] = [];
  private nextHandle = 1;
  private collecting = false;
  /** Whether an object with a destructor exists, which makes releasing values check for garbage. */
  destructibles = 0;
  strictTypes = false;
  /** The 0-based row being run, which warnings and new exceptions report. */
  row = 0;
  /** How many `@` operators are active. */
  silence = 0;
  errorReporting = 30_719n;
  errorHandlers: { handler: Value; mask: bigint }[] = [];
  exceptionHandler: Value = null;
  /** The handlers `set_exception_handler` replaced, latest last, which `restore_exception_handler` brings back. */
  replacedExceptionHandlers: Value[] = [];
  readonly mt = new MersenneTwister();
  /** Values held by native code (such as the array a sort is sorting), which garbage collection must keep. */
  readonly held: Value[] = [];
  program?: Program;
  notices: CompileNotice[] = [];
  /** The function a closure literal compiles to, created once so that its static variables persist. */
  readonly closureFunctions = new WeakMap<FunctionDecl, UserFunction>();
  /** The reference the last call to a function returning by reference returned, for `$x = &f()`. */
  lastReturnRef: Ref | undefined;
  /** The number of user calls running, bounded by the call depth limit. */
  depth = 0;
  shuttingDown = false;
  private pendingOutput = '';
  /** The classes a program declared, in declaration order, whose static properties the trace shows. */
  readonly userClasses: PhpClass[] = [];
  lastJsonError = 0;
  lastPregError = 0;
  internalCounters = { anonymous: 0 };

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
    this.globalFrame = new Frame(undefined, undefined, false);
    this.frames.push(this.globalFrame);
  }

  get frame(): Frame {
    return this.frames.at(-1) as Frame;
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** The array elements and object properties allocated so far, which only grows: a run pays for what it dropped too. */
  private slots = 0;

  /** Charges for `count` new array elements or object properties, added to a structure that then holds `size`. */
  allocate(count: number, size = count): void {
    const before = this.slots;
    this.slots += count;
    if (this.slots > LIMITS.maxSlots) throw this.memoryExhausted(tableBytes(size));
    if (this.slots >> 6 !== before >> 6) this.spend((this.slots >> 6) - (before >> 6));
  }

  /** Refuses an array of a size the program chose before the host builds it, charging nothing. */
  ensureRoom(count: number): void {
    if (this.slots + count > LIMITS.maxSlots) throw this.memoryExhausted(tableBytes(count));
  }

  /** Refuses a string of a length the program chose before the host builds it. */
  ensureStringFits(length: number): void {
    if (length > LIMITS.maxStringLength) throw this.memoryExhausted(stringBytes(length));
  }

  /** The fatal error PHP reports when an allocation of `bytes` passes its memory limit. */
  memoryExhausted(bytes: number): FatalError {
    return new FatalError(memoryExhaustedMessage(bytes), this.row, true);
  }

  /** Allocates the handle of a new object, reusing the most recently freed one as PHP does. */
  newObject(cls: PhpClass): PhpObject {
    if (!this.collecting && this.mayHoldGarbage) {
      this.collecting = true;
      try {
        collectBeforeAllocation(this);
        this.mayHoldGarbage = false;
      } finally {
        this.collecting = false;
      }
    }
    const id = this.freeHandles.pop() ?? this.nextHandle++;
    const object = new PhpObject(cls, id);
    this.objects.set(id, object);
    if (cls.findMethod('__destruct')) this.destructibles++;
    // A new object is a temporary of the running statement until something stores it.
    this.frame.temporaries.push(object);
    this.allocate(cls.props.length + 1);
    this.spend();
    return object;
  }

  /** The order in which the last reachability pass reached each object, which decides the order of releasing them. */
  reachOrder = new Map<PhpObject, number>();

  /** The exception being thrown, which no variable holds while it unwinds. */
  thrown: PhpObject | undefined;

  /**
   * How many native functions are running, whose values in flight (such as the array `array_map` builds) no root
   * holds, so that releasing what a callback drops must wait until they return.
   */
  nativeCalls = 0;

  /** The values the callbacks of each running native function returned, which it holds until it returns. */
  nativeHeld: unknown[][] = [];

  /**
   * Whether garbage may exist that no release freed: a native function may have let go of values silently, or a
   * release had to wait. The next allocation then collects it, so that the new object reuses a freed handle.
   */
  mayHoldGarbage = true;

  /** Frees what letting go of some values frees, as {@link releaseDropped} describes, when that is safe now. */
  release(dropped: unknown[]): void {
    if (this.nativeCalls === 0) releaseDropped(this, dropped);
    else this.mayHoldGarbage = true;
  }

  /** Lets go of a frame's temporaries from `mark` on, as PHP frees temporary values once they are used. */
  dropTemporaries(frame: Frame, mark: number): void {
    if (frame.temporaries.length <= mark) return;
    const values = frame.temporaries.splice(mark);
    this.release(values);
  }

  freeObject(object: PhpObject): void {
    if (this.objects.get(object.id) !== object) return;
    this.objects.delete(object.id);
    this.freeHandles.push(object.id);
    if (object.turtle) object.turtle.isAlive = false;
  }

  /** Writes bytes to standard output, decoding complete UTF-8 sequences as they arrive. */
  echo(bytes: string): void {
    if (bytes.length === 0) return;
    if (bytes.length > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
    this.spend(Math.ceil(bytes.length / 64));
    const text = this.pendingOutput + bytes;
    const cut = completePrefix(text);
    this.pendingOutput = text.slice(cut);
    if (cut > 0) this.io.stdout.write(dec(text.slice(0, cut)));
  }

  flush(): void {
    if (this.pendingOutput) this.io.stdout.write(dec(this.pendingOutput));
    this.pendingOutput = '';
  }

  /** Writes to standard error, which the grader accepts without showing. */
  echoError(bytes: string): void {
    this.io.stderr.write(dec(bytes));
  }

  collectGarbage(): void {
    collectGarbage(this);
  }

  /** The global variable `name`, creating it as null when it does not exist. */
  globalRef(name: string): Ref {
    let ref = this.globalFrame.vars.get(name);
    if (!ref) {
      ref = new Ref(null);
      this.globalFrame.vars.set(name, ref);
    }
    return ref;
  }
}

/** The length of the longest prefix of a byte string that does not end inside a UTF-8 sequence. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function completePrefix(bytes: string): number {
  let index = bytes.length;
  for (let back = 1; back <= 3 && index - back >= 0; back++) {
    const byte = bytes.charCodeAt(index - back);
    if (byte < 0x80) return index;
    if (byte >= 0xc0) {
      const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
      return back < needed ? index - back : index;
    }
  }
  return index;
}

/**
 * The message of PHP's fatal error for running out of memory. The interpreter's limits are smaller than PHP's
 * 128 MiB, so `bytes` is the size PHP would request for the structure that passed them, not the size it ran out at.
 */
export function memoryExhaustedMessage(bytes: number): string {
  return `Allowed memory size of 134217728 bytes exhausted (tried to allocate ${bytes} bytes)`;
}

/** About the size PHP requests for a hash table growing to hold `size` elements: a power of two of 16-byte slots. */
function tableBytes(size: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(size, 8))) * 16;
}

/** About the size PHP requests for a string of `length` bytes: its header and bytes, rounded up to whole pages. */
function stringBytes(length: number): number {
  return Math.ceil((length + 25) / 4096) * 4096;
}

let current: Runtime | undefined;

export function rt(): Runtime {
  return current as Runtime;
}

setDropHandler((values) => current?.release(values));
setAllocationHandler((count, size) => current?.allocate(count, size));

export function withRuntime<T>(runtime: Runtime, run: () => T): T {
  const outer = current;
  current = runtime;
  try {
    return run();
  } finally {
    current = outer;
  }
}

export type { PhpArray, Value };
