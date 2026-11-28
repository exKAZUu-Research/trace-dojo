import type { FileHandle, TextReader } from '../interpreter/programIo';
import type { TurtleState } from '../interpreter/turtleWorld';
import { CollectionEntries, type CollectionKey } from './collectionEntries';
import type { DebugPart } from './debugText';
import type { DebugValue } from './iterDebug';
import type { AdtDef, Type } from './types';

/**
 * A value at run time. Types decide how a value reads, so values carry no types: integers are bigints, floats
 * numbers or payload-preserving NaN values, `char`s and text JS strings, tuples, arrays, and `Vec`s JS arrays, and a shared reference is the value it
 * refers to, since nothing can change that value while the reference lives. A mutable reference is a {@link Place}.
 * `Box<T>` is the boxed value itself.
 */
export type Value =
  | bigint
  | number
  | NaNValue
  | boolean
  | string
  | StringValue
  | Value[]
  | StructValue
  | EnumValue
  | Place
  | SliceView
  | FnValue
  | IterValue
  | MapValue
  | SetValue
  | RangeValue
  | DynValue
  | TurtleValue
  | FormatterValue
  | EntryValue
  | SharedBox
  | WeakRef
  | CellBox
  | BorrowGuard
  | RawPtr
  | IoStream
  | BufferedWriter
  | ChannelEnd
  | ThreadHandle
  | DurationValue
  | FutureValue
  | undefined;

export const UNIT_VALUE: Value[] = Object.freeze([]) as unknown as Value[];

export class NaNValue {
  constructor(
    readonly bits: bigint,
    readonly width: 32 | 64
  ) {}
}

export class StringValue {
  constructor(
    readonly text: string,
    readonly capacity: number,
    readonly byteLength: number
  ) {}
}

export function textOf(value: Value): string {
  let text = value;
  while (isPlace(text)) text = text.get();
  return text instanceof StringValue ? text.text : (text as string);
}

export class StructValue {
  constructor(
    readonly def: AdtDef,
    readonly fields: Value[]
  ) {}
}

export class EnumValue {
  constructor(
    readonly def: AdtDef,
    readonly variant: number,
    readonly fields: Value[]
  ) {}
}

export interface Place {
  readonly isPlace: true;
  get(): Value;
  set(value: Value): void;
}

export class CellPlace implements Place {
  readonly isPlace = true;
  constructor(public value: Value) {}

  get(): Value {
    return this.value;
  }

  set(value: Value): void {
    this.value = value;
  }
}

export class ElementPlace implements Place {
  readonly isPlace = true;
  constructor(
    readonly array: Value[],
    readonly index: number,
    readonly owner?: CellPlace | ElementPlace
  ) {}

  get(): Value {
    return this.array[this.index];
  }

  set(value: Value): void {
    this.array[this.index] = value;
  }
}

export class AccessorPlace implements Place {
  readonly isPlace = true;
  constructor(
    readonly get: () => Value,
    readonly set: (value: Value) => void,
    /** The place that `get` and `set` reach, which a collection follows as it follows a reference to that place. */
    readonly target?: Place
  ) {}
}

export function isPlace(value: unknown): value is Place {
  return typeof value === 'object' && value !== null && (value as Place).isPlace === true;
}

export class SliceView {
  constructor(
    readonly base: Value[],
    readonly start: number,
    readonly end: number,
    readonly owner?: Place
  ) {}

  get length(): number {
    return this.end - this.start;
  }
}

/** A slice as an array of its elements, which copies a window and returns a whole array as it is. */
export function sliceItems(value: Value): Value[] {
  if (value instanceof SliceView) return value.base.slice(value.start, value.end);
  return value as Value[];
}

export function sliceLength(value: Value): number {
  if (value instanceof SliceView) return value.end - value.start;
  return (value as Value[]).length;
}

export function sliceGet(value: Value, index: number): Value {
  if (value instanceof SliceView) return value.base[value.start + index];
  return (value as Value[])[index];
}

export function sliceSet(value: Value, index: number, element: Value): void {
  if (value instanceof SliceView) value.base[value.start + index] = element;
  else (value as Value[])[index] = element;
}

export function swapOwnedElements(items: Value[], first: number, second: number): void {
  [items[first], items[second]] = [items[second], items[first]];
}

export function sliceBase(value: Value): { base: Value[]; start: number } {
  if (value instanceof SliceView) return { base: value.base, start: value.start };
  return { base: value as Value[], start: 0 };
}

export class FnValue {
  constructor(
    readonly call: (args: Value[], callRow: number | undefined) => Value,
    readonly name: string,
    /** What the function keeps alive, such as a closure's captured values, for garbage collection. */
    readonly roots: unknown[] = []
  ) {}

  /**
   * For a closure, a copy (or a clone) of it: what it captures by value goes through `copy` (with the capture's
   * concrete type), and what it captures by reference stays shared.
   */
  duplicate: ((copy: (value: Value, type: Type) => Value) => FnValue) | undefined;
  dropCaptures: (() => void) | undefined;
}

export const DONE: unique symbol = Symbol('done');
export type Next = Value | typeof DONE;

export class IterValue {
  constructor(
    public next: () => Next,
    public nextBack?: () => Next,
    public remaining?: () => number | bigint,
    /** Owned values the iterator keeps alive across calls. */
    readonly roots: unknown[] = []
  ) {}

  readonly borrowedRoots: Value[] = [];
  remainingTextBytes?: () => number;
  sizeHintLower?: () => bigint;
  trustedSizeHint?: boolean;
  stateRoots?: () => Iterable<unknown>;

  peeked: Next[] | undefined;

  /** What goes when the iterator does: the captured values of the closures its adaptors took (`map(move |x| ..)`). */
  releases: (() => void)[] | undefined;

  release(): void {
    const releases = this.releases;
    this.releases = undefined;
    for (const release of releases ?? []) release();
  }

  /**
   * The next element when a consumer folds the iterator (`collect`, `sum`, `for_each`), where it differs from `next`:
   * a `zip` of two `TrustedLen` iterators folds as many pairs as the shorter has, taking nothing more from the longer.
   */
  foldNext: (() => Next) | undefined;
  nth?: (n: bigint) => Next;
  nthBack?: (n: bigint) => Next;

  /**
   * `{:?}` of the iterator as std writes it, for iterators whose own state shows (`Windows { v: .., size: 2 }`):
   * `show` writes a value of a type, and `item` is the type of the iterator's elements.
   */
  debug: ((show: DebugValue, item: Type) => DebugPart) | undefined;

  /** The elements left, for iterators over an array (`Chars::as_str` reads them without taking them). */
  rest: (() => Value[]) | undefined;

  frontIndex?: () => number;

  fork: (() => IterValue) | undefined;
  ownedItemType?: Type;
  /** An adapter's source and own state, whose iterators (`chain`'s second, `zip`'s other) go when the adapter does. */
  adapterSource?: IterValue;
  adapterState?: object;
  peekedType?: Type;
}

export class MapValue {
  readonly entries: CollectionEntries<[Value, Value]>;
  constructor(readonly sorted: boolean) {
    this.entries = new CollectionEntries(sorted, ([key]) => key);
  }
}

export class SetValue {
  readonly entries: CollectionEntries<Value>;
  constructor(readonly sorted: boolean) {
    this.entries = new CollectionEntries(sorted, (value) => value);
  }
}

export class RangeValue {
  constructor(
    public start: Value,
    public end: Value,
    readonly inclusive: boolean,
    public exhausted = false
  ) {}

  sliceStart(): bigint | undefined {
    if (this.exhausted && this.inclusive) return this.sliceEnd();
    return this.start as bigint | undefined;
  }

  sliceEnd(): bigint | undefined {
    return this.end === undefined ? undefined : (this.end as bigint) + (this.inclusive ? 1n : 0n);
  }
}

export interface RangeEndpoint {
  key: Value;
  included: boolean;
}

export class DynValue {
  constructor(
    readonly type: Type,
    readonly value: Value
  ) {}
}

export class TurtleValue {
  constructor(readonly state: TurtleState) {}
}

export class FormatterValue {
  text = '';
  constructor(
    readonly spec: {
      alternate: boolean;
      width: number | undefined;
      precision: number | undefined;
      fill: string;
      align: '<' | '>' | '^' | undefined;
      sign: '+' | '-' | undefined;
      zero: boolean;
    },
    readonly writeChunk?: (text: string) => void
  ) {}

  write(text: string): void {
    this.writeChunk?.(text);
    this.text += text;
  }
}

export class EntryValue {
  constructor(
    readonly map: MapValue,
    readonly lookup: CollectionKey<[Value, Value]>,
    readonly key: Value
  ) {}
}

export class SharedBox {
  strong = 1;
  weak = 0;
  constructor(public value: Value) {}
}

/** A `Weak` pointer, to an allocation that may have gone (or none, from `Weak::new`). */
export class WeakRef {
  constructor(readonly box: SharedBox | undefined) {}
}

/**
 * A value with interior mutability (`Cell`, `RefCell`, and the locks of threads), which the program changes through
 * shared references; `RefCell` counts its borrows to panic as std does on a conflicting one.
 */
export class CellBox {
  /** The shared borrows in use, or -1 while a mutable one is. */
  borrows = 0;
  /** Whether a thread panicked while it held the lock for writing, as a `Mutex` or an `RwLock` records. */
  poisoned = false;
  /** For a lock, the threads holding it, one entry per guard. */
  readonly holders: number[] = [];
  constructor(public value: Value) {}
}

export class BorrowGuard {
  released = false;
  constructor(
    readonly cell: CellBox,
    readonly mutable: boolean,
    /** For a lock's guard, whether a panic is unwinding the thread, which poisons a lock held for writing. */
    readonly unwinding?: () => boolean,
    readonly holder?: number
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.holder !== undefined) this.cell.holders.splice(this.cell.holders.indexOf(this.holder), 1);
    if (this.mutable && this.unwinding?.()) this.cell.poisoned = true;
    if (this.mutable) this.cell.borrows = 0;
    else this.cell.borrows--;
  }

  place(): Place {
    const { cell } = this;
    return new AccessorPlace(
      () => cell.value,
      (value) => {
        cell.value = value;
      }
    );
  }
}

let nextAddress = 0x7f_f7_b0_00_00_00;

/** A raw pointer (`*const T`, `*mut T`): the place it points to, or none for a null pointer. */
export class RawPtr {
  /** The address `{:?}` shows, which only tells pointers apart, as real addresses differ between runs. */
  readonly address: number;
  constructor(readonly place: Place | undefined) {
    this.address = place ? (nextAddress += 16) : 0;
  }
}

export class IoStream {
  constructor(
    readonly reader: TextReader | undefined,
    readonly writer: FileHandle | undefined,
    /** For a `File`, what its `Debug` shows. */
    readonly file?: { fd: number; path: string }
  ) {}
}

/** std's default capacity of a `BufWriter`, in bytes. */
const BUF_WRITER_CAPACITY = 8 * 1024;

/**
 * A `BufWriter`: the text written to it that it has not passed on yet to the writer it wraps, which a full buffer,
 * `flush`, and its drop pass on, as std's buffers bytes up to its capacity. `writeInner` gives the `io::Error` of a
 * failed write.
 */
export class BufferedWriter {
  private pending = '';
  private pendingBytes = 0;
  constructor(private readonly writeInner: (text: string) => Value | undefined) {}

  write(text: string): Value | undefined {
    const bytes = new TextEncoder().encode(text).length;
    if (this.pendingBytes + bytes > BUF_WRITER_CAPACITY) {
      const error = this.flush();
      if (error) return error;
    }
    if (bytes >= BUF_WRITER_CAPACITY) return this.writeInner(text);
    this.pending += text;
    this.pendingBytes += bytes;
    return undefined;
  }

  flush(): Value | undefined {
    const text = this.pending;
    this.pending = '';
    this.pendingBytes = 0;
    return text ? this.writeInner(text) : undefined;
  }
}

export class ChannelEnd {
  /** Whether the `Receiver` has gone, after which a send gives back its message as an error. */
  receiverDropped = false;
  /** The `Sender`s that have not gone, while one of which a receive with nothing to receive waits. */
  senders = 1;
  constructor(readonly queue: Value[]) {}
}

export class ThreadHandle {
  state: 'pending' | 'running' | 'done' | 'panicked' = 'pending';
  result: Value;
  /** Whether a thread joined it, which `thread::scope` leaves to report its panic. */
  joined = false;
  constructor(
    readonly id: number,
    readonly run: () => Value
  ) {}
}

export const PENDING: unique symbol = Symbol('pending');

export class FutureValue {
  constructor(
    readonly poll: (context: Value) => Value | typeof PENDING,
    /** What the future keeps alive, such as its closure, for garbage collection. */
    readonly roots: unknown[] = []
  ) {}
}

/** The longest `Duration`, in nanoseconds: `u64::MAX` seconds and 999_999_999 nanoseconds. */
export const MAX_DURATION = (2n ** 64n - 1n) * 1_000_000_000n + 999_999_999n;

export class DurationValue {
  constructor(readonly nanos: bigint) {}
}
