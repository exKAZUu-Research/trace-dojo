import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { Span } from './ast';
import type { Type, TypeParam } from './types';
import {
  CellPlace,
  DynValue,
  ElementPlace,
  EntryValue,
  EnumValue,
  FnValue,
  IterValue,
  MapValue,
  type Place,
  SetValue,
  SliceView,
  StructValue,
  TurtleValue,
  type Value,
} from './values';

/** Marks a variable whose scope has not begun, has ended, or whose value moved out. */
export const UNASSIGNED: unique symbol = Symbol('unassigned');
/** What a field or element holds after a pattern, a field read, or a struct update moved its value out. */
export const MOVED = undefined as unknown as Value;

/** A local variable as the trace shows it. */
export interface LocalInfo {
  name: string;
  slot: number;
  type: Type;
  /** Whether the variable is `self`, whose fields show as `self.x` like Java's `this.x`. */
  isSelf?: boolean;
}

export interface FunctionInfo {
  name: string;
  slotCount: number;
  locals: LocalInfo[];
  /** The variables of enclosing functions that a closure captured, which the trace shows after its own. */
  captures: { name: string; type: Type }[];
  isAtomic: boolean;
}

export class Frame implements TracedFrame {
  readonly locals: (Value | typeof UNASSIGNED)[];
  /**
   * The places that variables holding shared references refer to, by slot, which the trace shows the current values
   * of: a shared reference holds a copy of its referent, which a change of the referent after the borrow ends leaves
   * behind.
   */
  readonly referents = new Map<number, { place: Place; root: number }>();

  /** Ends the scope of variables, which leave the trace with the references to them. */
  endScope(slots: readonly number[]): void {
    for (const slot of slots) this.locals[slot] = UNASSIGNED;
    for (const [slot, { root }] of this.referents) if (slots.includes(root)) this.referents.delete(slot);
  }
  /** Values in use that no variable holds, such as the value a `for` loop iterates, for garbage collection. */
  readonly temporaries: Value[] = [];

  constructor(
    readonly runtime: Runtime,
    readonly info: FunctionInfo,
    readonly callRow: number | undefined,
    /** The concrete types of the type parameters of a generic function, by parameter. */
    readonly typeArgs: ReadonlyMap<TypeParam, Type>,
    /** The places a closure's captured variables live in. */
    readonly captures: readonly Place[] = []
  ) {
    this.locals = Array.from({ length: info.slotCount }, () => UNASSIGNED);
  }
}

/** A panic, which unwinds the program to its end. */
export class RustPanic {
  constructor(
    readonly message: string,
    readonly span: Span,
    /** Where in the standard library the panic is, for functions without `#[track_caller]` (`core/src/...:L:C`). */
    readonly libraryLocation?: string
  ) {}
}

/** A `Display` or `Debug` impl returned `Err`, after the formatting wrote `written`; each caller reacts as std does. */
export class FmtFailure {
  constructor(readonly written: string) {}
}

/** `std::process::exit`, which ends the program at once. */
export class ProcessExit {
  constructor(readonly code: number) {}
}

/** `main` returned an `Err`, which Rust reports as `Error: {:?}` and exit status 1. */
export class MainError {
  constructor(readonly description: string) {}
}

/** `break`, `continue`, and `return`, which unwind to the loop or function they leave. */
export class ControlSignal {
  constructor(
    readonly kind: 'break' | 'continue' | 'return',
    readonly label: string | undefined,
    public value: Value
  ) {}
}

export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly frames: Frame[] = [];
  readonly steps = new StepTracker();
  readonly io: ProgramIO;
  private slots = 0;
  private readonly outputDecoders = {
    stdout: new TextDecoder('utf-8', { ignoreBOM: true }),
    stderr: new TextDecoder('utf-8', { ignoreBOM: true }),
  };
  /** Values in use outside frame storage, such as arguments under evaluation and elements being sorted. */
  readonly nativeRoots: Value[][] = [];

  constructor(
    input?: ProgramInput,
    private readonly budget = new ExecutionBudget()
  ) {
    this.io = new ProgramIO(budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  withRoots<T>(values: Value[], use: () => T): T {
    this.nativeRoots.push(values);
    try {
      return use();
    } finally {
      this.nativeRoots.pop();
    }
  }

  /** Counts allocated elements against {@link LIMITS.maxSlots}. */
  allocate(count: number): void {
    this.slots += count;
    if (this.slots > LIMITS.maxSlots) throw new OutOfMemory(count * SLOT_BYTES);
  }

  /**
   * Checks the length of a string built at run time against {@link LIMITS.maxStringLength}, and charges an operation
   * for each 64 characters of the `written` ones that end it, which bounds what a run builds in all; a string grown a
   * character at a time is charged as one built at once.
   */
  allocateString(length: number, written = length): void {
    if (length > LIMITS.maxStringLength) throw new OutOfMemory(length);
    this.spend(Math.floor(length / 64) - Math.floor((length - written) / 64));
  }

  write(stream: 'stdout' | 'stderr', text: string): void {
    this.io[stream].write(this.outputDecoders[stream].decode() + text);
  }

  writeBytes(stream: 'stdout' | 'stderr', bytes: Uint8Array): void {
    this.io[stream].write(this.outputDecoders[stream].decode(bytes, { stream: true }));
  }

  finishOutput(): void {
    this.write('stdout', '');
    this.write('stderr', '');
  }

  pushFrame(frame: Frame): void {
    if (this.frames.length >= LIMITS.maxCallDepth) throw new StackOverflow();
    this.frames.push(frame);
  }

  popFrame(): void {
    this.frames.pop();
  }

  /** Removes the turtles that no variable or value in use reaches, as dropping them in Rust does. */
  collectGarbage(): void {
    const reached = new Set<unknown>();
    const stack: unknown[] = [];
    for (const frame of this.frames) {
      pushAll(stack, frame.locals);
      pushAll(stack, frame.temporaries);
      pushAll(stack, frame.captures);
    }
    for (const roots of this.nativeRoots) pushAll(stack, roots);
    const turtles = new Set<unknown>();
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined || item === null || typeof item !== 'object' || reached.has(item)) continue;
      reached.add(item);
      if (item instanceof TurtleValue) {
        turtles.add(item.state);
        continue;
      }
      pushChildren(item, stack);
    }
    this.world.retain((turtle) => turtles.has(turtle));
  }
}

export class StackOverflow {}

/** The size this interpreter counts for an element against {@link LIMITS.maxSlots}: a `usize` of a 64-bit target. */
const SLOT_BYTES = 8;

/**
 * An allocation over this interpreter's memory limits, which aborts the program as Rust's default allocation error
 * handler does when the system has no more memory.
 */
export class OutOfMemory {
  constructor(readonly bytes: number) {}
}

// code-gauge-allow functionNcss 31 -- One case per kind of value.
function pushChildren(item: object, stack: unknown[]): void {
  if (Array.isArray(item)) {
    pushAll(stack, item);
  } else if (item instanceof StructValue || item instanceof EnumValue) {
    pushAll(stack, item.fields);
  } else if (item instanceof CellPlace) {
    stack.push(item.value);
  } else if (item instanceof ElementPlace) {
    stack.push(item.array);
  } else if (item instanceof SliceView) {
    stack.push(item.base);
  } else if (item instanceof MapValue) {
    for (const [key, value] of item.entries.values()) stack.push(key, value);
  } else if (item instanceof SetValue) {
    pushAll(stack, item.entries.values());
  } else if (item instanceof DynValue) {
    stack.push(item.value);
  } else if (item instanceof IterValue) {
    pushAll(stack, item.roots);
    if (item.stateRoots) pushAll(stack, item.stateRoots());
    if (item.peeked) pushAll(stack, item.peeked);
  } else if (item instanceof FnValue) {
    pushAll(stack, item.roots);
  } else if (item instanceof EntryValue) {
    stack.push(item.map, item.key);
  }
}

/** Pushes many items, which spreading them as arguments would overflow the call stack with. */
function pushAll(stack: unknown[], items: Iterable<unknown>): void {
  for (const item of items) stack.push(item);
}
