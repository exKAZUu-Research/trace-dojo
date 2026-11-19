import type { DisplayNode } from '../../problems/trace';
import { CppRuntimeError } from '../errors';
import type { Type } from '../types';
import { Ptr, Store, UNINIT, type Value } from '../values';

interface IndexedValue {
  index: number;
  value: Value;
}

class NodePosition extends Ptr {
  constructor(
    public owner: Store,
    public position: number | undefined
  ) {
    super(undefined, 0);
  }

  override get store(): Store {
    return this.owner;
  }

  override get index(): number {
    if (this.position === -1) throw new CppRuntimeError('invalidIterator');
    return this.position ?? this.owner.length;
  }
}

class DequeIterator extends Ptr {
  private readonly generation: number;
  private readonly endGeneration: number | undefined;

  constructor(
    private readonly location: Ptr,
    private readonly epoch: { all: number; end: number },
    isEnd: boolean
  ) {
    super(undefined, 0);
    this.generation = epoch.all;
    this.endGeneration = isEnd ? epoch.end : undefined;
  }

  override get store(): Store | undefined {
    return this.location.store;
  }

  override get index(): number {
    if (
      this.epoch.all !== this.generation ||
      (this.endGeneration !== undefined && this.epoch.end !== this.endGeneration)
    )
      throw new CppRuntimeError('invalidIterator');
    return this.location.index;
  }
}

/** Associates a node's address with its current position in a container's traversal order. */
export class NodePositions {
  private positions = new Map<number, NodePosition>();
  private end: NodePosition;

  constructor(private readonly owner: Store) {
    this.end = new NodePosition(owner, undefined);
  }

  at(index: number): Ptr {
    if (index === this.owner.length) return this.end;
    if (index < 0 || index > this.owner.length) throw new CppRuntimeError('invalidIterator');
    let node = this.positions.get(index);
    if (!node) {
      node = new NodePosition(this.owner, index);
      this.positions.set(index, node);
    }
    return node;
  }

  invalidateEnd(): void {
    this.end.position = -1;
    this.end = new NodePosition(this.owner, undefined);
  }

  invalidateFrom(index: number): void {
    this.invalidateEnd();
    for (const [position, node] of this.positions) {
      if (position < index) continue;
      node.position = -1;
      this.positions.delete(position);
    }
  }

  splice(from: number, remove: number, insert: number): void {
    if (this.positions.size === 0 || (remove === 0 && from === this.owner.length)) return;
    const next = new Map<number, NodePosition>();
    for (const [index, node] of this.positions) {
      if (index < from) next.set(index, node);
      else if (index < from + remove) node.position = -1;
      else {
        node.position = index - remove + insert;
        next.set(node.position, node);
      }
    }
    this.positions = next;
  }

  reorder(order: IndexedValue[]): void {
    const previous = this.positions;
    this.positions = new Map();
    for (const [index, entry] of order.entries()) {
      const node = previous.get(entry.index);
      if (!node) continue;
      node.position = index;
      this.positions.set(index, node);
      previous.delete(entry.index);
    }
    for (const discarded of previous.values()) discarded.position = -1;
  }

  take(other: NodePositions): void {
    for (const node of this.positions.values()) node.position = -1;
    this.positions = other.positions;
    other.positions = new Map();
    for (const node of this.positions.values()) node.owner = this.owner;
  }

  swap(other: NodePositions): void {
    if (this === other) return;
    [this.positions, other.positions] = [other.positions, this.positions];
    for (const node of this.positions.values()) node.owner = this.owner;
    for (const node of other.positions.values()) node.owner = other.owner;
  }
}

/** The elements of a sequence container: `std::vector`, `std::deque`, `std::array`, or `std::list`. */
export class SequenceValue extends Store {
  constructor(
    public items: Value[],
    readonly elementType: Type,
    /** Whether the trace shows the container as an array, as it shows a Java array. */
    public isArrayLike: boolean,
    private readonly storageKind?: 'list' | 'deque' | 'vector'
  ) {
    super();
    this.nodes = storageKind ? new NodePositions(this) : undefined;
    this.dequeEpoch = storageKind === 'deque' ? { all: 0, end: 0 } : undefined;
  }

  private readonly nodes?: NodePositions;
  private dequeEpoch?: { all: number; end: number };

  override location(index: number): Ptr {
    return this.nodes?.at(index) ?? super.location(index);
  }

  override iteratorLocation(index: number): Ptr {
    const location = this.location(index);
    return this.dequeEpoch ? new DequeIterator(location, this.dequeEpoch, index === this.length) : location;
  }

  append(value: Value): void {
    if (this.dequeEpoch) this.dequeEpoch.all++;
    if (this.storageKind === 'vector') this.nodes?.invalidateEnd();
    this.items.push(value);
  }

  splice(from: number, remove: number, ...items: Value[]): Value[] {
    const start = from < 0 ? Math.max(0, this.length + from) : from;
    this.editPositions(start, remove, items.length);
    return this.items.splice(start, remove, ...items);
  }

  insertValues(at: number, values: Value[]): void {
    this.editPositions(at, 0, values.length);
    // oxlint-disable-next-line unicorn/prefer-spread -- Bulk insertion concatenates whole arrays directly.
    this.items = this.items.slice(0, at).concat(values, this.items.slice(at));
  }

  replaceItems(items: Value[]): Value[] {
    const previous = this.items;
    this.editPositions(0, previous.length, items.length);
    this.items = items;
    return previous;
  }

  replaceAllocation(items: Value[], capacity: number): void {
    this.invalidateVectorSuffix(0);
    this.items = items;
    this.capacity = capacity;
  }

  invalidateVectorSuffix(from: number): void {
    if (this.storageKind === 'vector') this.nodes?.invalidateFrom(from);
  }

  editPositions(from: number, remove: number, insert: number): void {
    const atEnd = from + remove === this.length;
    const changesMiddle = from > 0 && !atEnd;
    const epoch = this.dequeEpoch;
    if (this.storageKind === 'vector' && (remove || insert)) {
      this.invalidateVectorSuffix(from);
      return;
    }
    if (epoch && changesMiddle) this.nodes?.splice(0, this.length, this.length - remove + insert);
    else this.nodes?.splice(from, remove, insert);
    if (epoch && (insert || changesMiddle)) epoch.all++;
    else if (epoch && remove && atEnd) epoch.end++;
  }

  reorder(edit: (items: IndexedValue[]) => IndexedValue[]): void {
    const next = edit(this.items.map((value, index) => ({ value, index })));
    this.nodes?.reorder(next);
    this.items = next.map(({ value }) => value);
  }

  takeItems(other: SequenceValue): void {
    if (this.dequeEpoch && other.dequeEpoch) {
      this.dequeEpoch.all++;
      [this.dequeEpoch, other.dequeEpoch] = [other.dequeEpoch, this.dequeEpoch];
    }
    if (this.nodes && other.nodes) this.nodes.take(other.nodes);
    this.items = other.items;
    this.capacity = other.capacity;
    other.items = [];
    other.capacity = 0;
  }

  moveStorage(): SequenceValue {
    const destination = new SequenceValue([], this.elementType, this.isArrayLike, this.storageKind);
    destination.takeItems(this);
    return destination;
  }

  swapItems(other: SequenceValue): void {
    if (this.dequeEpoch && other.dequeEpoch) {
      this.dequeEpoch.end++;
      other.dequeEpoch.end++;
      [this.dequeEpoch, other.dequeEpoch] = [other.dequeEpoch, this.dequeEpoch];
    }
    if (this.nodes && other.nodes) this.nodes.swap(other.nodes);
    [this.items, other.items] = [other.items, this.items];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
  }

  /** The capacity a `std::vector` has, which libc++ grows by doubling. */
  private reserved = 0;

  get capacity(): number {
    return this.reserved;
  }

  set capacity(value: number) {
    this.reserved =
      this.storageKind === 'vector' && this.elementType.kind === 'int' && this.elementType.name === 'bool'
        ? Math.ceil(value / 64) * 64
        : value;
  }

  get length(): number {
    return this.items.length;
  }

  get(index: number): Value {
    this.checkAlive();
    if (index < 0 || index >= this.items.length) throw new CppRuntimeError('outOfBounds');
    const value = this.items[index];
    if (value === UNINIT) throw new CppRuntimeError('uninitialized');
    return value;
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    if (index < 0 || index >= this.items.length) throw new CppRuntimeError('outOfBounds');
    this.items[index] = value;
  }

  children(): Iterable<Value> {
    return this.items;
  }
}

/** The entries of an associative container, which shows as an object keyed by its keys. */
export abstract class MapValue extends Store {
  abstract displayNode(nodeOf: (value: Value, type: Type) => DisplayNode): DisplayNode;
}
