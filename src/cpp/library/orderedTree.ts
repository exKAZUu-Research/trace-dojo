import type { Value } from '../values';

type Side = 0 | 1;

interface EntryOperations {
  copy: (entry: Value) => Value;
  assign: (target: Value, source: Value) => Value;
  destroy: (entry: Value) => void;
}

class Node {
  parent?: Node;
  readonly children: [Node?, Node?] = [];

  constructor(
    public value: Value,
    public black = false
  ) {}
}

/** The red-black shape libc++ uses to decide which ordered entries to assign during a copy. */
export class OrderedTree {
  private root?: Node;
  private order: Node[] = [];
  private entries: Value[] = [];

  get values(): readonly Value[] {
    return this.entries;
  }

  splice(index: number, count: number, inserted: Value[]): Value[] {
    for (let offset = 0; offset < count; offset++) this.remove(this.order[index + offset]);
    this.order.splice(index, count);
    for (const [offset, value] of inserted.entries()) this.insert(index + offset, value);
    return this.entries.splice(index, count, ...inserted);
  }

  set(index: number, value: Value): void {
    this.order[index].value = value;
    this.entries[index] = value;
  }

  takeAll(): Value[] {
    const values = this.entries;
    this.root = undefined;
    this.order = [];
    this.entries = [];
    return values;
  }

  assignFrom(
    source: OrderedTree,
    operations: EntryOperations,
    publish: (order: { index: number; value: Value }[]) => void
  ): void {
    const previous = new Map(this.order.map((node, index) => [node, index]));
    try {
      this.root = assignSubtree(this.root, source.root, operations);
    } finally {
      const order: Node[] = [];
      inorder(this.root, order);
      this.order = order;
      this.entries = order.map((node) => node.value);
      publish(order.map((node) => ({ index: previous.get(node) ?? -1, value: node.value })));
    }
  }

  private insert(index: number, value: Value): void {
    const node = new Node(value);
    const successor = this.order[index];
    const predecessor = this.order[index - 1];
    this.order.splice(index, 0, node);
    if (successor && !successor.children[0]) setChild(successor, 0, node);
    else if (predecessor) setChild(predecessor, 1, node);
    else this.root = node;
    this.balanceInsertion(node);
  }

  private balanceInsertion(node: Node): void {
    while (node.parent && !node.parent.black) {
      let parent = node.parent;
      const grandparent = parent.parent as Node;
      const side = sideOf(parent);
      const other = opposite(side);
      const uncle = grandparent.children[other];
      if (uncle && !uncle.black) {
        parent.black = true;
        uncle.black = true;
        grandparent.black = false;
        node = grandparent;
        continue;
      }
      if (sideOf(node) !== side) {
        this.rotate(parent, side);
        parent = node;
      }
      parent.black = true;
      grandparent.black = false;
      this.rotate(grandparent, other);
      break;
    }
    if (this.root) this.root.black = true;
  }

  private remove(node: Node): void {
    const [left, right] = node.children;
    let removed = node;
    if (left && right) {
      removed = right;
      while (removed.children[0]) removed = removed.children[0];
    }
    const hole = removed.children[0] ?? removed.children[1];
    const removedBlack = removed.black;
    let parent = removed.parent;
    let side = sideOf(removed);
    this.replace(removed, hole);
    if (removed !== node) {
      this.replace(node, removed);
      setChild(removed, 0, node.children[0]);
      setChild(removed, 1, node.children[1]);
      removed.black = node.black;
      if (parent === node) {
        parent = removed;
        side = 1;
      }
    }
    if (!removedBlack) return;
    if (hole) hole.black = true;
    else this.balanceRemoval(parent, side);
  }

  private balanceRemoval(parent: Node | undefined, side: Side): void {
    while (parent) {
      const other = opposite(side);
      let sibling = parent.children[other];
      if (sibling && !sibling.black) {
        sibling.black = true;
        parent.black = false;
        this.rotate(parent, side);
        sibling = parent.children[other];
      }
      const inner = sibling?.children[side];
      const outer = sibling?.children[other];
      if (sibling && (isRed(inner) || isRed(outer))) {
        this.rebalanceWithRedChild(parent, sibling, side);
        return;
      }
      if (sibling) sibling.black = false;
      if (!parent.black) {
        parent.black = true;
        return;
      }
      side = sideOf(parent);
      parent = parent.parent;
    }
  }

  private rebalanceWithRedChild(parent: Node, sibling: Node, side: Side): void {
    const other = opposite(side);
    if (!isRed(sibling.children[other])) {
      const inner = sibling.children[side] as Node;
      inner.black = true;
      sibling.black = false;
      this.rotate(sibling, other);
      sibling = inner;
    }
    sibling.black = parent.black;
    parent.black = true;
    const outer = sibling.children[other] as Node;
    outer.black = true;
    this.rotate(parent, side);
  }

  private rotate(node: Node, side: Side): void {
    const other = opposite(side);
    const pivot = node.children[other] as Node;
    const inner = pivot.children[side];
    this.replace(node, pivot);
    setChild(node, other, inner);
    setChild(pivot, side, node);
  }

  private replace(node: Node, substitute: Node | undefined): void {
    const parent = node.parent;
    if (parent) setChild(parent, sideOf(node), substitute);
    else {
      this.root = substitute;
      if (substitute) substitute.parent = undefined;
    }
  }
}

function assignSubtree(
  target: Node | undefined,
  source: Node | undefined,
  operations: EntryOperations
): Node | undefined {
  if (!source) {
    destroySubtree(target, operations.destroy);
    return undefined;
  }
  if (!target) return copySubtree(source, operations);
  target.value = operations.assign(target.value, source.value);
  target.black = source.black;
  for (const side of [0, 1] as const) {
    const child = assignSubtree(target.children[side], source.children[side], operations);
    setChild(target, side, child);
  }
  return target;
}

function copySubtree(source: Node, operations: EntryOperations): Node {
  const node = new Node(operations.copy(source.value), source.black);
  try {
    for (const side of [0, 1] as const) {
      const child = source.children[side];
      if (child) setChild(node, side, copySubtree(child, operations));
    }
    return node;
  } catch (error) {
    destroySubtree(node, operations.destroy);
    throw error;
  }
}

function inorder(node: Node | undefined, to: Node[]): void {
  if (!node) return;
  inorder(node.children[0], to);
  to.push(node);
  inorder(node.children[1], to);
}

function destroySubtree(node: Node | undefined, destroy: (value: Value) => void): void {
  if (!node) return;
  destroySubtree(node.children[0], destroy);
  destroy(node.value);
  destroySubtree(node.children[1], destroy);
}

function setChild(parent: Node, side: Side, child: Node | undefined): void {
  parent.children[side] = child;
  if (child) child.parent = parent;
}

function sideOf(node: Node): Side {
  return node.parent?.children[1] === node ? 1 : 0;
}

function opposite(side: Side): Side {
  return side === 0 ? 1 : 0;
}

function isRed(node: Node | undefined): boolean {
  return !!node && !node.black;
}
