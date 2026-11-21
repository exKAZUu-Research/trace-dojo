import { compareValues, spendCollectionWork } from './ops';
import type { Type } from './types';
import type { RangeEndpoint, Value } from './values';

const MIN_KEYS = 5;
const MAX_KEYS = 2 * MIN_KEYS + 1;

class Node<V> {
  size = 0;
  parent: Node<V> | undefined;

  constructor(
    readonly entries: V[] = [],
    readonly children: Node<V>[] = []
  ) {
    for (const child of children) child.parent = this;
    this.updateSize();
  }

  updateSize(): void {
    this.size = this.entries.length + this.children.reduce((count, child) => count + child.size, 0);
  }
}

export interface TreeKey<V> {
  node: Node<V> | undefined;
  index: number;
  present: boolean;
}

const ALL = Symbol('all');
const NONE = Symbol('none');
type Bound = typeof ALL | typeof NONE | RangeEndpoint;
interface Edge<V> {
  node: Node<V>;
  index: number;
  next: Bound;
}

export class BTree<V> {
  root: Node<V> | undefined;
  private bulkLeaf: Node<V> | undefined;

  constructor(private readonly keyOf: (entry: V) => Value) {}

  get size(): number {
    return this.root?.size ?? 0;
  }

  search(type: Type, key: Value): TreeKey<V> {
    this.finishBulk();
    let node = this.root;
    while (node) {
      const found = this.findInNode(node, type, key, 0);
      if (found.present || node.children.length === 0) return found;
      node = node.children[found.index];
    }
    return { node: undefined, index: 0, present: false };
  }

  write(found: TreeKey<V>, value: V): void {
    if (found.present) {
      found.node!.entries[found.index] = value;
      return;
    }
    this.root ??= new Node();
    const position = this.insertAt(found.node ?? this.root, found.index, value);
    Object.assign(found, position);
  }

  remove(found: TreeKey<V>): boolean {
    if (!found.present) return false;
    let node = found.node!;
    let { index } = found;
    if (node.children.length > 0) {
      const predecessor = leaf(node.children[index], false);
      const last = predecessor.entries.length - 1;
      node.entries[index] = predecessor.entries[last];
      node = predecessor;
      index = last;
    }
    node.entries.splice(index, 1);
    updateToRoot(node);
    this.rebalance(node);
    found.present = false;
    return true;
  }

  clear(): void {
    this.root = this.bulkLeaf = undefined;
  }

  *values(): IterableIterator<V> {
    if (this.root) yield* walk(this.root, 0, this.root.size);
  }

  getEdge(first: boolean): V | undefined {
    const key = this.edgeKey(first);
    return key?.node?.entries[key.index];
  }

  takeEdge(first: boolean): V | undefined {
    const key = this.edgeKey(first);
    if (!key) return;
    const value = key.node!.entries[key.index];
    this.remove(key);
    return value;
  }

  edgeKey(first: boolean): TreeKey<V> | undefined {
    this.finishBulk();
    if (!this.root?.size) return undefined;
    const node = leaf(this.root, first);
    const index = first ? 0 : node.entries.length - 1;
    return { node, index, present: true };
  }

  retain(keep: (value: V) => boolean): void {
    this.finishBulk();
    for (let index = 0; index < this.size;) {
      const found = atRank(this.root!, index);
      if (keep(found.node!.entries[found.index])) index++;
      else this.remove(found);
    }
  }

  copyFrom(source: BTree<V>, clone: (value: V) => V): void {
    source.finishBulk();
    this.root = source.root?.size ? cloneNode(source.root, clone) : undefined;
  }

  appendOrdered(value: V): void {
    this.root ??= new Node();
    const tail = this.bulkLeaf ?? leaf(this.root, false);
    this.bulkLeaf = tail;
    if (tail.entries.length < MAX_KEYS) {
      tail.entries.push(value);
      updateToRoot(tail);
      return;
    }
    let full = tail;
    let right = new Node<V>();
    this.bulkLeaf = right;
    while (full.parent?.entries.length === MAX_KEYS) {
      full = full.parent;
      right = new Node([], [right]);
    }
    const parent = full.parent ?? new Node([], [full]);
    if (!parent.parent) this.root = parent;
    parent.entries.push(value);
    parent.children.push(right);
    right.parent = parent;
    updateToRoot(parent);
  }

  /** The ranks, in key order, of a range's first entry and of the first entry after it. */
  rangeRanks(type: Type, start: RangeEndpoint | undefined, end: RangeEndpoint | undefined): [number, number] {
    this.finishBulk();
    if (!this.root) return [0, 0];
    const firstBound = start ?? ALL;
    const lastBound = end ?? ALL;
    let first = this.boundEdge(this.root, type, firstBound, false, 0);
    let last = this.boundEdge(this.root, type, lastBound, true, first.index);
    while (first.node.children.length > 0) {
      const same = first.node === last.node && first.index === last.index;
      first = this.boundEdge(first.node.children[first.index], type, first.next, false, 0);
      last = this.boundEdge(last.node.children[last.index], type, last.next, true, same ? first.index : 0);
    }
    return [edgeRank(first), edgeRank(last)];
  }

  /** The entry of a rank, in key order. */
  entryAt(rank: number): V {
    const { node, index } = atRank(this.root!, rank);
    return node!.entries[index];
  }

  private findInNode(node: Node<V>, type: Type, key: Value, start: number): TreeKey<V> {
    spendCollectionWork(1);
    for (let index = start; index < node.entries.length; index++) {
      const order = compareValues(type, key, this.keyOf(node.entries[index])) ?? 0;
      if (order <= 0) return { node, index, present: order === 0 };
    }
    return { node, index: node.entries.length, present: false };
  }

  private boundEdge(node: Node<V>, type: Type, bound: Bound, end: boolean, start: number): Edge<V> {
    if (bound === ALL || bound === NONE) {
      return { node, index: (bound === ALL) === end ? node.entries.length : 0, next: bound };
    }
    const { index, present } = this.findInNode(node, type, bound.key, start);
    return {
      node,
      index: index + Number(present && bound.included === end),
      next: present ? (bound.included ? NONE : ALL) : bound,
    };
  }

  private insertAt(node: Node<V>, edge: number, value: V, rightChild?: Node<V>): TreeKey<V> {
    const size = node.entries.length;
    node.entries.splice(edge, 0, value);
    if (rightChild) {
      node.children.splice(edge + 1, 0, rightChild);
      rightChild.parent = node;
    }
    if (size < MAX_KEYS) {
      updateToRoot(node);
      return { node, index: edge, present: true };
    }
    // Rust 1.99.1's node split point depends on the insertion edge.
    const middle = edge < MIN_KEYS || edge === MIN_KEYS + 1 ? MIN_KEYS : MIN_KEYS + 1;
    const right = new Node(node.entries.splice(middle + 1), node.children.splice(middle + 1));
    const divider = node.entries.pop()!;
    node.updateSize();
    const parent = node.parent ?? new Node([], [node]);
    if (!parent.parent) this.root = parent;
    this.insertAt(parent, parent.children.indexOf(node), divider, right);
    return edge < middle
      ? { node, index: edge, present: true }
      : { node: right, index: edge - middle - 1, present: true };
  }

  private rebalance(start: Node<V>): void {
    let node = start;
    while (node.parent && node.entries.length < MIN_KEYS) {
      const parent = node.parent;
      const index = parent.children.indexOf(node);
      const separator = Math.max(0, index - 1);
      const [left, right] = [parent.children[separator], parent.children[separator + 1]];
      if (left.entries.length + right.entries.length + 1 > MAX_KEYS) {
        if (index > 0) stealLeft(parent, separator, left, right);
        else stealRight(parent, separator, left, right);
        return;
      }
      left.entries.push(parent.entries.splice(separator, 1)[0], ...right.entries);
      for (const child of right.children) {
        child.parent = left;
        left.children.push(child);
      }
      parent.children.splice(separator + 1, 1);
      left.updateSize();
      updateToRoot(parent);
      node = parent;
    }
    if (this.root?.entries.length === 0 && this.root.children.length > 0) {
      this.root = this.root.children[0];
      this.root.parent = undefined;
    }
  }

  private finishBulk(): void {
    if (!this.bulkLeaf) return;
    this.bulkLeaf = undefined;
    let node = this.root!;
    while (node.children.length > 0) {
      const separator = node.entries.length - 1;
      const left = node.children[separator];
      const right = node.children[separator + 1];
      while (right.entries.length < MIN_KEYS) stealLeft(node, separator, left, right);
      node = right;
    }
  }
}

function stealLeft<V>(parent: Node<V>, index: number, left: Node<V>, right: Node<V>): void {
  right.entries.unshift(parent.entries[index]);
  parent.entries[index] = left.entries.pop()!;
  const child = left.children.pop();
  if (child) {
    child.parent = right;
    right.children.unshift(child);
  }
  left.updateSize();
  right.updateSize();
}

function stealRight<V>(parent: Node<V>, index: number, left: Node<V>, right: Node<V>): void {
  left.entries.push(parent.entries[index]);
  parent.entries[index] = right.entries.shift()!;
  const child = right.children.shift();
  if (child) {
    child.parent = left;
    left.children.push(child);
  }
  left.updateSize();
  right.updateSize();
}

function updateToRoot<V>(node: Node<V>): void {
  let current: Node<V> | undefined = node;
  while (current) {
    current.updateSize();
    current = current.parent;
  }
}

function leaf<V>(node: Node<V>, first: boolean): Node<V> {
  let next = node;
  while (next.children.length > 0) next = next.children[first ? 0 : next.children.length - 1];
  return next;
}

function cloneNode<V>(node: Node<V>, clone: (value: V) => V): Node<V> {
  const entries: V[] = [];
  const children: Node<V>[] = [];
  for (const [index, entry] of node.entries.entries()) {
    if (node.children[index]) children.push(cloneNode(node.children[index], clone));
    entries.push(clone(entry));
  }
  const tail = node.children.at(-1);
  if (tail) children.push(cloneNode(tail, clone));
  return new Node(entries, children);
}

function atRank<V>(node: Node<V>, rank: number): TreeKey<V> {
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index];
    if (rank < child.size) return atRank(child, rank);
    rank -= child.size;
    if (rank === 0) return { node, index, present: true };
    rank--;
  }
  return { node, index: rank, present: true };
}

function edgeRank<V>(edge: Edge<V>): number {
  let { node } = edge;
  let rank = edge.index;
  while (node.parent) {
    const parent = node.parent;
    const index = parent.children.indexOf(node);
    rank += index;
    for (let sibling = 0; sibling < index; sibling++) rank += parent.children[sibling].size;
    node = parent;
  }
  return rank;
}

function* walk<V>(node: Node<V>, from: number, to: number): IterableIterator<V> {
  let rank = 0;
  for (let index = 0; index <= node.entries.length && rank < to; index++) {
    const child = node.children[index];
    if (child) {
      if (rank + child.size > from) yield* walk(child, Math.max(0, from - rank), Math.min(child.size, to - rank));
      rank += child.size;
    }
    if (index < node.entries.length && rank >= from && rank < to) yield node.entries[index];
    rank++;
  }
}
