import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { Span } from './ast';
import type { Dropper } from './drops';
import type { Scheduler } from './natives/threads';
import { canReachTurtle, turtleCaptureRoots } from './turtleTypes';
import { shallow, type Type, type TypeParam } from './types';
import { utf8Reader } from './utf8';
import {
  AccessorPlace,
  BorrowGuard,
  CellBox,
  CellPlace,
  DynValue,
  ElementPlace,
  EntryValue,
  EnumValue,
  FnValue,
  isPlace,
  IterValue,
  MapValue,
  type Place,
  SetValue,
  SharedBox,
  SliceView,
  StructValue,
  TurtleValue,
  type Value,
  WeakRef,
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
  readonly scalarSlots: ReadonlySet<number>;
  readonly captureRoots: readonly Place[];
  /**
   * The places that variables holding shared references refer to, by slot, which the trace shows the current values
   * of: a shared reference holds a copy of its referent, which a change of the referent after the borrow ends leaves
   * behind. A reference coerced on borrowing (to `&str` or a trait object) shows the coercion (`view`) of that value.
   */
  readonly referents = new Map<number, { place: Place; root: number; view?: (value: Value) => Value }>();
  /** The temporaries a `let` extends to the life of the variable in each slot (`let r = &make();`), in order made. */
  readonly extendedTemporaries = new Map<number, (() => void)[]>();

  holdUntilDropped(slot: number, release: () => void): void {
    const held = this.extendedTemporaries.get(slot);
    if (held) held.push(release);
    else this.extendedTemporaries.set(slot, [release]);
  }

  /**
   * Ends the scope of variables, which leave the trace with the references to them, dropping their values; with
   * `drops` false, as when a match guard fails, the values stay with the value matched, which the bindings never took.
   */
  endScope(slots: readonly number[], drops = true): void {
    if (drops) this.runtime.dropper?.dropSlots(this, slots);
    for (const slot of slots) {
      this.locals[slot] = UNASSIGNED;
      this.referents.delete(slot);
    }
    for (const [slot, { root }] of this.referents) {
      if (!slots.includes(root)) continue;
      this.locals[slot] = UNASSIGNED;
      this.referents.delete(slot);
    }
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
    this.scalarSlots = new Set(
      info.locals.filter(({ type }) => !canReachTurtle(type, typeArgs)).map(({ slot }) => slot)
    );
    this.captureRoots = turtleCaptureRoots(captures, info.captures, typeArgs);
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

/** A use of what the interpreter does not support, found while running, which ends the whole program, not a thread. */
export class UnsupportedAtRun extends RustPanic {}

/** A `Display` or `Debug` impl returned `Err`, after the formatting wrote `written`; each caller reacts as std does. */
export class FmtFailure {
  constructor(readonly written: string) {}
}

/** The text a formatting wrote, up to where an impl failed: a panic's message keeps that much. */
export function writtenText(format: () => string): string {
  try {
    return format();
  } catch (error) {
    if (error instanceof FmtFailure) return error.written;
    throw error;
  }
}

/** `std::process::exit`, which ends the program at once. */
export class ProcessExit {
  constructor(readonly code: number) {}
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
  /** The descriptor the next `File` opened gets, after standard input, output and error. */
  nextFileDescriptor = 3;
  private slots = 0;
  private readonly outputDecoders = {
    stdout: new TextDecoder('utf-8', { ignoreBOM: true }),
    stderr: new TextDecoder('utf-8', { ignoreBOM: true }),
  };
  /** Values in use outside frame storage, such as arguments under evaluation and elements being sorted. */
  readonly nativeRoots: Value[][] = [];
  // A collection keeps the type of its storage even when an iterator takes ownership of the buffer.
  private readonly scalarStorage = new WeakSet<object>();
  readonly utf8 = utf8Reader;

  constructor(
    input?: ProgramInput,
    private readonly budget = new ExecutionBudget()
  ) {
    this.io = new ProgramIO(budget, input);
    this.utf8.clear();
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

  rememberScalarStorage(value: Value): void {
    const storage = collectionStorage(value);
    if (storage) this.scalarStorage.add(storage);
  }

  copyScalarStorage(source: object, copy: object): void {
    if (this.scalarStorage.has(source)) this.scalarStorage.add(copy);
  }

  borrowCandidate(value: Value, type?: Type, bindings?: ReadonlyMap<TypeParam, Type>): boolean {
    const storage = collectionStorage(value);
    if (storage && this.scalarStorage.has(storage)) return false;
    if (!this.world.hasTurtles && !storage) return false;
    if (type && !canReachTurtle(type, bindings)) {
      if (storage) this.scalarStorage.add(storage);
      return false;
    }
    return this.world.hasTurtles;
  }

  withActiveBorrows<T>(values: Value[], use: () => T): T {
    const roots = this.borrowRoots(values);
    return roots.length === 0 ? use() : this.withRoots(roots, use);
  }

  borrowRoots(values: Value[]): Value[] {
    if (!this.world.hasTurtles) return [];
    const roots: Value[] = [];
    const pending: unknown[] = [...values];
    const seen = new Set<object>();
    while (pending.length > 0) {
      const item = pending.pop();
      if (typeof item !== 'object' || item === null || seen.has(item) || this.scalarStorage.has(item)) continue;
      seen.add(item);
      pushActiveBorrowChildren(item, pending, roots);
    }
    return roots;
  }

  /** Counts allocated elements against {@link LIMITS.maxSlots}. */
  allocate(count: number, bytes: number | bigint = count * SLOT_BYTES): void {
    this.slots += count;
    if (this.slots > LIMITS.maxSlots) throw new OutOfMemory(bytes);
  }

  /**
   * Checks the length of a string built at run time against {@link LIMITS.maxStringLength}, and charges an operation
   * for each 64 characters of the `written` ones that end it, which bounds what a run builds in all; a string grown a
   * character at a time is charged as one built at once.
   */
  allocateString(length: number, written = length, bytes: number | bigint = length): void {
    if (length > LIMITS.maxStringLength) throw new OutOfMemory(bytes);
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

  /** Drops the values of variables whose scope ends, for programs with `Drop` impls. */
  dropper: Dropper | undefined;
  /** The threads the program spawned, once it spawns one. */
  scheduler: Scheduler | undefined;
  /**
   * The temporaries that go at the end of their statement: the guards of `RefCell` borrows, and values a method
   * borrows as its receiver (`v.into_iter().next()`), which need dropping.
   */
  readonly liveGuards: { release(): void }[] = [];
  /** Whether a panic is unwinding the running thread, dropping its values on the way out. */
  unwinding = false;

  /**
   * Ends the borrows of the guards made since `mark` that no variable of the frame holds (and that `kept` is not),
   * as Rust drops temporaries at the end of a statement or a condition.
   */
  releaseGuards(frame: Frame, mark: number, kept?: Value): void {
    if (this.liveGuards.length <= mark) return;
    // Rust drops a statement's temporaries in the reverse order of their making.
    for (const guard of this.liveGuards.splice(mark).toReversed()) {
      if (guard === kept || frame.locals.some((value) => holds(value, guard))) continue;
      guard.release();
    }
  }

  pushFrame(frame: Frame): void {
    if (this.frames.length >= LIMITS.maxCallDepth) throw new StackOverflow();
    // A body of calls alone charges nothing else, so each call spends.
    this.spend();
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
      for (const [slot, value] of frame.locals.entries()) {
        if (!frame.scalarSlots.has(slot) && !frame.referents.has(slot)) stack.push(value);
      }
      pushAll(stack, frame.temporaries);
      pushAll(stack, frame.captureRoots);
    }
    for (const roots of this.nativeRoots) pushAll(stack, roots);
    const turtles = new Set<unknown>();
    while (stack.length > 0) {
      const item = stack.pop();
      if (typeof item !== 'object' || item === null || reached.has(item) || this.scalarStorage.has(item)) continue;
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

/** Whether a value is a guard, or holds it directly in an `Option`, a tuple, or a struct. */
function holds(value: unknown, guard: { release(): void }): boolean {
  if (value === guard) return true;
  if (value instanceof StructValue || value instanceof EnumValue) return value.fields.includes(guard as Value);
  return Array.isArray(value) && value.includes(guard as Value);
}

export class StackOverflow {}

/** The size this interpreter counts for an element against {@link LIMITS.maxSlots}: a `usize` of a 64-bit target. */
const SLOT_BYTES = 8;

/**
 * An allocation over this interpreter's memory limits, which aborts the program as Rust's default allocation error
 * handler does when the system has no more memory.
 */
export class OutOfMemory {
  constructor(readonly bytes: number | bigint) {}
}

function collectionStorage(value: Value): object | undefined {
  let storage = value;
  while (isPlace(storage)) storage = storage.get();
  if (storage instanceof SliceView) return storage.base;
  if (Array.isArray(storage) || storage instanceof MapValue || storage instanceof SetValue) return storage;
  return undefined;
}

function pushActiveBorrowChildren(item: object, pending: unknown[], roots: Value[]): void {
  if (isPlace(item)) {
    const target = item.get();
    roots.push(target);
    pending.push(target);
    return;
  }
  if (item instanceof SliceView) {
    roots.push(item.base);
    pending.push(item.base);
  } else if (item instanceof IterValue) {
    pushAll(roots, item.borrowedRoots);
    pushAll(pending, item.borrowedRoots);
    if (item.peeked) pushAll(pending, item.peeked);
  }
  pushChildren(item, pending);
}

// code-gauge-allow functionNcss -- One case per kind of value.
// code-gauge-allow functionCognitiveComplexity -- Each runtime value representation exposes its own reachable objects.
function pushChildren(item: object, stack: unknown[]): void {
  if (Array.isArray(item)) {
    pushAll(stack, item);
  } else if (item instanceof StructValue || item instanceof EnumValue) {
    pushAll(stack, item.fields);
  } else if (item instanceof CellPlace || item instanceof SharedBox || item instanceof CellBox) {
    stack.push(item.value);
  } else if (item instanceof WeakRef) {
    if (item.box && item.box.strong > 0) stack.push(item.box);
  } else if (item instanceof BorrowGuard) {
    stack.push(item.cell);
  } else if (item instanceof AccessorPlace) {
    stack.push(item.target);
  } else if (item instanceof ElementPlace) {
    stack.push(item.owner);
  } else if (item instanceof SliceView) {
    stack.push(item.owner);
  } else if (item instanceof MapValue) {
    for (const [key, value] of item.entries.values()) stack.push(key, value);
  } else if (item instanceof SetValue) {
    pushAll(stack, item.entries.values());
  } else if (item instanceof DynValue) {
    stack.push(item.value);
  } else if (item instanceof IterValue) {
    pushAll(stack, item.roots);
    if (item.stateRoots) pushAll(stack, item.stateRoots());
    if (item.peeked && item.peekedType) {
      for (const next of item.peeked) pushOwned(stack, next, item.peekedType);
    }
  } else if (item instanceof FnValue) {
    pushAll(stack, item.roots);
  } else if (item instanceof EntryValue) {
    stack.push(item.map, item.key);
  }
}

function pushOwned(stack: unknown[], value: unknown, type: Type): void {
  const t = shallow(type);
  if (t.kind === 'ref') return;
  if (t.kind === 'tuple' && Array.isArray(value)) {
    for (const [index, elem] of t.elems.entries()) pushOwned(stack, value[index], elem);
  } else stack.push(value);
}

/** Pushes many items, which spreading them as arguments would overflow the call stack with. */
function pushAll<T>(stack: T[], items: Iterable<T>): void {
  for (const item of items) stack.push(item);
}
