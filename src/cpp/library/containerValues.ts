import type { DisplayNode } from '../../problems/trace';
import { CppRuntimeError } from '../errors';
import type { Frame } from '../runtime';
import { isArithmetic, sizeOf, type Type } from '../types';
import { type ArrayStore, Box, CObject, holdValues, Ptr, Store, UNINIT, type Value } from '../values';

interface IndexedValue {
  index: number;
  value: Value;
}

export function sequenceAddress(pointer: Ptr): { store: SequenceValue; index: number } | undefined {
  const { store, index } = pointer.storageAddress;
  const address = store instanceof NodeCell ? store.sequenceAddress(index) : { store, index };
  if (address.store instanceof SequenceValue) return { store: address.store, index: address.index };
}

class NodePosition extends Ptr {
  private cell?: Ptr;
  private dequeCell?: Ptr;

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

  cellLocation(type: Type): Ptr {
    this.cell ??= new NodeCell(this, type).location(0);
    return this.cell;
  }

  dequeLocation(storage: DequeStorage): Ptr {
    this.dequeCell ??= new DequeElementPointer(storage, this);
    return this.dequeCell;
  }
}

export class NodeCell extends Store {
  readonly length = 1;

  constructor(
    private readonly node: Ptr,
    private readonly type: Type
  ) {
    super();
  }

  override checkAlive(): void {
    this.node.target();
  }

  sequenceAddress(offset: number): Ptr['storageAddress'] {
    const { store, index } = this.node.storageAddress;
    return { store, index: index + offset };
  }

  override projectAddress(index: number, byteOffset: number): { store: Store; index: number } {
    return { store: this, index: index * sizeOf(this.type) + byteOffset };
  }

  get(index: number): Value {
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
    return this.node.read();
  }

  set(index: number, value: Value): void {
    if (index !== 0) throw new CppRuntimeError('outOfBounds');
    this.node.write(value);
  }

  children(): Value[] {
    return [this.node];
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

interface DequeAddress {
  store: Store;
  index: number;
  block: number;
}

class DequeElementPointer extends Ptr {
  constructor(
    private readonly storage: DequeStorage,
    private readonly position: NodePosition | DequeAddress
  ) {
    super(undefined, 0);
  }

  override get store(): Store {
    return this.storage.owner;
  }

  override get index(): number {
    const { position } = this;
    return position instanceof NodePosition ? position.index : this.storage.cellIndex(position);
  }

  override embeddedAddress(byteOffset: number): DequeAddress {
    const { position } = this;
    if (position instanceof NodePosition) return this.storage.address(position.index, byteOffset);
    return { ...position, index: position.index + byteOffset };
  }

  override sharesRange(other: Ptr): boolean {
    return other instanceof DequeElementPointer && this.address.store === other.address.store;
  }

  override offset(delta: number | bigint): Ptr {
    const store = this.target();
    const start = this.index;
    if (delta < -start || delta > store.pointerLength - start) throw new CppRuntimeError('pointerOutOfRange');
    const offset = Number(delta);
    const index = start + offset;
    const address = this.embeddedAddress(offset * this.storage.elementSize);
    const { blockBytes } = this.storage;
    if (address.index < 0 || address.index > blockBytes) throw new CppRuntimeError('pointerOutOfRange');
    if (offset === 0) return this;
    if (address.index === blockBytes || index === store.pointerLength)
      return new DequeElementPointer(this.storage, address);
    const target = store.location(index);
    if (target.address.store !== address.store) throw new CppRuntimeError('invalidIterator');
    return target;
  }

  override read(): Value {
    this.checkElement();
    return super.read();
  }

  override readRaw(): Value {
    this.checkElement();
    return super.readRaw();
  }

  override write(value: Value): void {
    this.checkElement();
    super.write(value);
  }

  private checkElement(): void {
    if (!(this.position instanceof NodePosition)) throw new CppRuntimeError('outOfBounds');
  }
}

class DequeStorage {
  all = 0;
  end = 0;
  private start = 0;
  private firstBlock?: number;
  private lastBlock?: number;
  private readonly blocks = new Map<number, Store>();
  private readonly width: number;

  constructor(
    public owner: SequenceValue,
    readonly elementSize: number,
    length: number
  ) {
    this.width = dequeBlockElements(elementSize);
    this.extend(length);
  }

  get blockBytes(): number {
    return this.width * this.elementSize;
  }

  cellIndex(address: DequeAddress): number {
    return address.block * this.width + address.index / this.elementSize - this.start;
  }

  address(index: number, byteOffset: number): DequeAddress {
    const slot = this.start + index;
    const block = Math.floor(slot / this.width);
    let storage = this.blocks.get(block);
    if (!storage) {
      storage = new Box();
      this.blocks.set(block, storage);
    }
    return { store: storage, index: (slot - block * this.width) * this.elementSize + byteOffset, block };
  }

  extend(length: number): void {
    if (length === 0) return;
    const first = Math.floor(this.start / this.width);
    const end = Math.floor((this.start + length) / this.width);
    this.firstBlock = Math.min(this.firstBlock ?? first, first);
    this.lastBlock = Math.max(this.lastBlock ?? end, end);
  }

  insert(length: number, count: number, front: boolean): void {
    const occupiedFirst = Math.floor(this.start / this.width);
    const occupiedLast = Math.floor((this.start + length - count) / this.width);
    if (front) {
      if (this.firstBlock === undefined) this.start = Math.floor(this.width / 2);
      this.start -= count;
    }
    if (this.firstBlock !== undefined && this.lastBlock !== undefined) {
      if (front) {
        const needed = Math.max(0, this.firstBlock - Math.floor(this.start / this.width));
        this.lastBlock -= Math.min(needed, this.lastBlock - occupiedLast);
      } else {
        const needed = Math.max(0, Math.floor((this.start + length) / this.width) - this.lastBlock);
        this.firstBlock += Math.min(needed, occupiedFirst - this.firstBlock);
      }
      this.trimAddresses(this.firstBlock, this.lastBlock);
    }
    this.extend(length);
  }

  remove(length: number, count: number, side: 'front' | 'back' | 'clear'): void {
    if (this.firstBlock === undefined || this.lastBlock === undefined) return;
    if (side === 'front') {
      this.start += count;
      this.firstBlock = Math.max(this.firstBlock, Math.floor(this.start / this.width) - 1);
    } else if (side === 'back') {
      this.lastBlock = Math.min(this.lastBlock, Math.floor((this.start + length) / this.width) + 1);
    } else {
      this.firstBlock = Math.max(this.firstBlock, this.lastBlock - 1);
      this.start = this.lastBlock * this.width;
      if (this.firstBlock === this.lastBlock) this.start += Math.floor(this.width / 2);
    }
    this.trimAddresses(this.firstBlock, this.lastBlock);
  }

  private trimAddresses(first: number, last: number): void {
    for (const block of this.blocks.keys()) if (block < first || block > last) this.blocks.delete(block);
  }
}

function dequeBlockElements(elementSize: number): number {
  return elementSize < 256 ? Math.floor(4096 / elementSize) : 16;
}

/** Associates a node's address with its current position in a container's traversal order. */
export class NodePositions {
  private positions = new Map<number, NodePosition>();
  private end: NodePosition;

  constructor(private readonly owner: Store) {
    this.end = new NodePosition(owner, undefined);
  }

  at(index: number): NodePosition {
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

  invalidate(index: number): void {
    const node = this.positions.get(index);
    if (node) node.position = -1;
    this.positions.delete(index);
  }

  install(node: NodePosition): void {
    this.positions.set(node.index, node);
  }

  detach(index: number, value: Value): NodePosition | undefined {
    const node = this.positions.get(index);
    if (!node) return;
    this.positions.delete(index);
    node.owner = new Box(value, false);
    node.position = 0;
    return node;
  }

  transferTo(destination: NodePositions, from: number, count: number): void {
    const start = destination.owner.length;
    for (let offset = 0; offset < count; offset++) {
      const index = from + offset;
      const node = this.positions.get(index);
      if (!node) continue;
      this.positions.delete(index);
      node.owner = destination.owner;
      node.position = start + offset;
      destination.install(node);
    }
  }

  moveBefore(first: number, last: number, destination: number): void {
    const moved: NodePosition[] = [];
    const count = last - first;
    for (let index = destination; index < last; index++) {
      const node = this.positions.get(index);
      if (!node) continue;
      this.positions.delete(index);
      node.position = index < first ? index + count : destination + index - first;
      moved.push(node);
    }
    for (const node of moved) this.install(node);
  }

  invalidateFrom(index: number, until = Infinity): void {
    // No position lies past the owner's length while its suffix is invalidated, so a short range is visited directly.
    const last = Math.min(until, this.owner.length + 1);
    if (last - index < this.positions.size) {
      for (let position = Math.max(index, 0); position < last; position++) this.invalidate(position);
      return;
    }
    for (const [position, node] of this.positions) {
      if (position < index || position >= until) continue;
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
    private cells: Value[],
    readonly elementType: Type,
    /** Whether the trace shows the container as an array, as it shows a Java array. */
    public isArrayLike: boolean,
    private readonly storageKind?: 'list' | 'deque' | 'vector',
    private readonly fixedStorage?: ArrayStore
  ) {
    super();
    this.nodes = storageKind ? new NodePositions(this) : undefined;
    if (storageKind === 'deque') this.deque = new DequeStorage(this, sizeOf(elementType), cells.length);
  }

  private readonly nodes?: NodePositions;
  private deque?: DequeStorage;
  private head = 0;
  private constructingEnd?: { location: NodePosition; value: Value };
  private pendingListDestructions = 0;

  get items(): Value[] {
    if (this.head) {
      this.cells = this.cells.slice(this.head);
      this.head = 0;
    }
    return this.cells;
  }

  set items(values: Value[]) {
    this.cells = values;
    this.head = 0;
    this.deque?.extend(values.length);
    this.bindElements(0, values.length);
  }

  sliceItems(from: number, to: number): Value[] {
    return this.cells.slice(this.head + from, this.head + to);
  }

  override location(index: number): Ptr {
    if (this.constructingEnd && index === this.length + 1) return new Ptr(this, index);
    if (this.fixedStorage) return this.fixedStorage.location(index);
    const node = this.nodes?.at(index);
    if (!node) return super.location(index);
    if (this.storageKind === 'list' && index !== this.length) return node.cellLocation(this.elementType);
    return this.deque ? node.dequeLocation(this.deque) : node;
  }

  override iteratorLocation(index: number): Ptr {
    const location = this.nodes?.at(index) ?? this.location(index);
    return this.deque ? new DequeIterator(location, this.deque, index === this.length) : location;
  }

  bindInlineStorage(location: Ptr): void {
    this.inlineArray?.bindLocation(this.elementType, location);
  }

  override get inlineArray(): ArrayStore | undefined {
    if (this.fixedStorage?.length) return this.fixedStorage;
  }

  override projectAddress(index: number, byteOffset: number): { store: Store; index: number } | undefined {
    if (this.storageKind === 'vector') return { store: this, index: index * sizeOf(this.elementType) + byteOffset };
    return this.deque?.address(index, byteOffset);
  }

  append(value: Value): void {
    if (this.deque) this.deque.all++;
    if (this.storageKind === 'vector') this.nodes?.invalidateEnd();
    this.cells.push(value);
    const index = this.length - 1;
    this.deque?.insert(this.length, 1, false);
    this.bindElements(index, index + 1);
  }

  appendInPlace(initialize: (location: Ptr) => Value): void {
    const location = new NodePosition(this, this.length);
    this.constructingEnd = { location, value: UNINIT };
    try {
      const receiver = this.deque
        ? location.dequeLocation(this.deque)
        : this.storageKind === 'list'
          ? location.cellLocation(this.elementType)
          : location;
      const value = initialize(receiver);
      this.nodes?.install(location);
      this.append(value);
    } catch (error) {
      location.position = -1;
      throw error;
    } finally {
      this.constructingEnd = undefined;
    }
  }

  splice(from: number, remove: number, ...items: Value[]): Value[] {
    const start = from < 0 ? Math.max(0, this.length + from) : from;
    const dequeMiddle = this.storageKind === 'deque' && start > 0 && start + remove < this.length;
    if (this.deque && start === 0 && remove === 0 && items.length > 0) {
      this.insertDequeEnd('front', items);
      return [];
    }
    this.editPositions(start, remove, items.length);
    const removed = this.items.splice(start, remove, ...items);
    if (dequeMiddle) this.bindElements(0, this.length);
    else this.bindElements(start, this.storageKind === 'vector' ? this.length : start + items.length);
    return removed;
  }

  insertValues(at: number, values: Value[]): void {
    if (values.length === 0) return;
    this.editPositions(at, 0, values.length);
    // oxlint-disable-next-line unicorn/prefer-spread -- Bulk insertion concatenates whole arrays directly.
    this.items = this.items.slice(0, at).concat(values, this.items.slice(at));
  }

  insertDequeEnd(side: 'front' | 'back', values: Value[]): void {
    if (values.length === 0) return;
    const atFront = side === 'front';
    const at = atFront ? 0 : this.length;
    this.editPositions(at, 0, values.length, atFront);
    if (atFront) this.prependDequeValues(values);
    else for (const value of values) this.cells.push(value);
    this.bindElements(at, at + values.length);
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

  newAllocation(length: number, capacity: number): SequenceValue {
    const items = Array.from({ length }, (): Value => UNINIT);
    const value = new SequenceValue(items, this.elementType, this.isArrayLike, this.storageKind);
    value.capacity = capacity;
    return value;
  }

  installAllocation(allocation: SequenceValue): void {
    this.invalidateVectorSuffix(0);
    this.takeItems(allocation);
  }

  invalidateVectorSuffix(from: number): void {
    if (this.storageKind === 'vector') {
      this.nodes?.invalidateEnd();
      this.nodes?.invalidateFrom(from);
    }
  }

  finishVectorEdit(from: number, oldLength = this.length): void {
    this.nodes?.invalidateEnd();
    this.nodes?.invalidateFrom(from, oldLength);
    this.bindElements(from, oldLength);
  }

  finishMemberAssign(reused: number): void {
    if (this.storageKind !== 'list') this.nodes?.invalidateEnd();
    if (this.deque) this.deque.all++;
    this.nodes?.invalidateFrom(0, reused);
    this.bindElements(0, reused);
  }

  bindElements(from: number, to: number): void {
    if (this.elementType.kind !== 'class' || this.fixedStorage) return;
    for (let index = from; index < to; index++) {
      const item = this.cells[this.head + index];
      if (item instanceof CObject) item.bindContainerCell(this.location(index));
      else if (item instanceof SequenceValue && item.inlineArray) item.bindInlineStorage(this.location(index));
    }
  }

  editPositions(from: number, remove: number, insert: number, shiftsFront = from === 0): void {
    const atEnd = from + remove === this.length;
    const changesMiddle = from > 0 && !atEnd;
    const epoch = this.deque;
    if (epoch && insert > 0) epoch.insert(this.length + insert - remove, insert, shiftsFront);
    if (this.storageKind === 'vector' && (remove || insert)) {
      this.invalidateVectorSuffix(from);
      return;
    }
    if (epoch && changesMiddle) this.nodes?.splice(0, this.length, this.length - remove + insert);
    else this.nodes?.splice(from, remove, insert);
    if (epoch && (insert || changesMiddle)) epoch.all++;
    else if (epoch && remove && atEnd) epoch.end++;
  }

  removeDequeValues(from: number, count: number, position: number, side: 'front' | 'back' | 'clear'): void {
    const middle = position > 0 && position + count < this.length;
    this.editPositions(position, count, 0);
    if (side === 'front') {
      this.cells.fill(UNINIT, this.head, this.head + count);
      this.head += count;
      // Compact infrequently so front removal can pay for the surviving values it copies.
      if (this.head >= Math.max(32, this.length * 2)) {
        this.cells = this.cells.slice(this.head);
        this.head = 0;
      }
    } else if (side === 'clear') {
      this.cells = [];
      this.head = 0;
    } else {
      this.cells.splice(this.head + from, count);
    }
    this.deque?.remove(this.length, count, side);
    if (middle) this.bindElements(0, this.length);
  }

  private prependDequeValues(values: Value[]): void {
    if (this.head < values.length) {
      const extra = Math.max(16, this.length, values.length - this.head);
      this.cells = [...Array.from<Value>({ length: extra }).fill(UNINIT), ...this.cells];
      this.head += extra;
    }
    this.head -= values.length;
    for (const [offset, value] of values.entries()) this.cells[this.head + offset] = value;
  }

  reorder(edit: (items: IndexedValue[]) => IndexedValue[]): void {
    const next = edit(this.items.map((value, index) => ({ value, index })));
    this.nodes?.reorder(next);
    this.items = next.map(({ value }) => value);
  }

  transferNodesTo(destination: SequenceValue, from: number, count: number): void {
    if (!this.nodes || !destination.nodes) throw new Error('Node transfer requires two node stores');
    this.nodes.transferTo(destination.nodes, from, count);
    for (const value of this.splice(from, count)) destination.items.push(value);
  }

  moveNodesBefore(first: number, last: number, destination: number): void {
    const moved = this.cells.slice(first, last);
    this.cells.copyWithin(destination + moved.length, destination, first);
    for (const [offset, value] of moved.entries()) this.cells[destination + offset] = value;
    this.nodes?.moveBefore(first, last, destination);
  }

  eraseNodes(
    frame: Frame,
    from: number,
    count: number,
    publishSize: 'per-element' | 'all',
    destroy: ((frame: Frame, value: Value) => void) | undefined
  ): void {
    const removed = this.items.slice(from, from + count);
    const nodes = removed.map((value, offset) => this.nodes?.detach(from + offset, value));
    const pending = this.pendingListDestructions;
    this.splice(from, count);
    if (publishSize === 'per-element') this.pendingListDestructions += removed.length;
    try {
      holdValues(frame, removed, () => {
        for (const [index, value] of removed.entries()) {
          frame.runtime.spend();
          if (publishSize === 'per-element') this.pendingListDestructions--;
          destroy?.(frame, value);
          const node = nodes[index];
          if (node) node.position = -1;
        }
      });
    } finally {
      this.pendingListDestructions = pending;
      for (const node of nodes) {
        if (node) node.position = -1;
      }
    }
  }

  takeItems(other: SequenceValue): void {
    if (this.deque && other.deque) {
      this.deque.all++;
      this.deque = other.deque;
      this.deque.owner = this;
      other.deque = new DequeStorage(other, sizeOf(other.elementType), 0);
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
    if (this.deque && other.deque) {
      this.deque.end++;
      other.deque.end++;
      [this.deque, other.deque] = [other.deque, this.deque];
      this.deque.owner = this;
      other.deque.owner = other;
    }
    if (this.nodes && other.nodes) this.nodes.swap(other.nodes);
    [this.cells, other.cells] = [other.cells, this.cells];
    [this.head, other.head] = [other.head, this.head];
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
    return this.cells.length - this.head;
  }

  get size(): number {
    return this.length + this.pendingListDestructions;
  }

  override get pointerLength(): number {
    return this.constructingEnd ? this.length + 1 : this.length;
  }

  get(index: number): Value {
    this.checkAlive();
    if (index < 0 || index >= this.pointerLength) throw new CppRuntimeError('outOfBounds');
    const value = index === this.length ? this.constructingEnd?.value : this.cells[this.head + index];
    if (value === UNINIT) throw new CppRuntimeError('uninitialized');
    return value;
  }

  set(index: number, value: Value): void {
    this.checkAlive();
    if (index < 0 || index >= this.pointerLength) throw new CppRuntimeError('outOfBounds');
    if (index === this.length && this.constructingEnd) this.constructingEnd.value = value;
    else this.cells[this.head + index] = value;
  }

  children(): Iterable<Value> {
    if (this.fixedStorage) return [this.fixedStorage];
    if (isArithmetic(this.elementType)) return [];
    return this.constructingEnd ? [...this.items, this.constructingEnd.value] : this.items;
  }
}

export abstract class MapValue extends Store {
  constructor(protected readonly entryType: Type) {
    super();
  }

  abstract children(): Iterable<Value>;

  displayNode(nodeOf: (value: Value, type: Type) => DisplayNode): DisplayNode {
    const entries: Record<string, DisplayNode> = {};
    let index = 0;
    for (const entry of this.children()) entries[index++] = nodeOf(entry, this.entryType);
    return { kind: 'array', entries };
  }
}
