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

/** Associates a node's address with its current position in a container's traversal order. */
export class NodePositions {
  private positions = new Map<number, NodePosition>();
  private readonly end: NodePosition;

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
    readonly isArrayLike: boolean
  ) {
    super();
    this.nodes = isArrayLike ? undefined : new NodePositions(this);
  }

  private readonly nodes?: NodePositions;

  override location(index: number): Ptr {
    return this.nodes?.at(index) ?? super.location(index);
  }

  splice(from: number, remove: number, ...items: Value[]): Value[] {
    this.nodes?.splice(from, remove, items.length);
    return this.items.splice(from, remove, ...items);
  }

  reorder(edit: (items: IndexedValue[]) => IndexedValue[]): void {
    const next = edit(this.items.map((value, index) => ({ value, index })));
    this.nodes?.reorder(next);
    this.items = next.map(({ value }) => value);
  }

  takeItems(other: SequenceValue): void {
    if (this.nodes && other.nodes) this.nodes.take(other.nodes);
    this.items = other.items;
    this.capacity = other.capacity;
    other.items = [];
    other.capacity = 0;
  }

  swapItems(other: SequenceValue): void {
    if (this.nodes && other.nodes) this.nodes.swap(other.nodes);
    [this.items, other.items] = [other.items, this.items];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
  }

  /** The capacity a `std::vector` has, which libc++ grows by doubling. */
  capacity = 0;

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
