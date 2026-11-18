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
  private readonly budget = new ExecutionBudget();
  private slots = 0;
  /** Values that native code holds while it runs, such as the elements a sort is ordering. */
  readonly nativeRoots: Value[][] = [];

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Counts allocated elements against {@link LIMITS.maxSlots}. */
  allocate(count: number): void {
    this.slots += count;
    if (this.slots > LIMITS.maxSlots) throw new RustPanic('memory allocation failed', { row: 0, col: 0 });
  }

  write(stream: 'stdout' | 'stderr', text: string): void {
    this.io[stream].write(text);
  }

  pushFrame(frame: Frame): void {
    if (this.frames.length >= LIMITS.maxCallDepth) throw new StackOverflow();
    this.frames.push(frame);
  }

  popFrame(): void {
    this.frames.pop();
  }

  /** Removes the turtles that no variable or value in use reaches, as dropping them in Rust does. */
  // code-gauge-allow duplicateLines 16 -- Each language's runtime collects the turtles its values no longer reach alike.
  collectGarbage(): void {
    const reached = new Set<unknown>();
    const stack: unknown[] = [];
    for (const frame of this.frames) {
      stack.push(...frame.locals, ...frame.temporaries, ...frame.captures);
    }
    for (const roots of this.nativeRoots) stack.push(...roots);
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

// code-gauge-allow functionNcss 31 -- One case per kind of value.
function pushChildren(item: object, stack: unknown[]): void {
  if (Array.isArray(item)) {
    stack.push(...item);
  } else if (item instanceof StructValue || item instanceof EnumValue) {
    stack.push(...item.fields);
  } else if (item instanceof CellPlace) {
    stack.push(item.value);
  } else if (item instanceof ElementPlace) {
    stack.push(item.array);
  } else if (item instanceof SliceView) {
    stack.push(item.base);
  } else if (item instanceof MapValue) {
    for (const [key, value] of item.entries.values()) stack.push(key, value);
  } else if (item instanceof SetValue) {
    stack.push(...item.entries.values());
  } else if (item instanceof DynValue) {
    stack.push(item.value);
  } else if (item instanceof FnValue || item instanceof IterValue) {
    stack.push(...item.roots);
  } else if (item instanceof EntryValue) {
    stack.push(item.map, item.key);
  }
}
