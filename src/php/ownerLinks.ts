interface Entry<Owner, Key> {
  owner: Owner;
  keys: Set<Key>;
  previous?: Entry<Owner, Key>;
  next?: Entry<Owner, Key>;
}

export class OwnerLinks<Owner, Key> {
  private readonly entries = new Map<Owner, Entry<Owner, Key>>();
  private newest?: Entry<Owner, Key>;

  add(owner: Owner, key: Key): void {
    let entry = this.entries.get(owner);
    if (!entry) {
      entry = { owner, keys: new Set() };
      this.entries.set(owner, entry);
    } else if (entry === this.newest) {
      entry.keys.add(key);
      return;
    } else this.unlink(entry);
    entry.keys.add(key);
    entry.previous = this.newest;
    entry.next = undefined;
    if (this.newest) this.newest.next = entry;
    this.newest = entry;
  }

  get(owner: Owner): Set<Key> | undefined {
    return this.entries.get(owner)?.keys;
  }

  delete(owner: Owner): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    this.unlink(entry);
    this.entries.delete(owner);
  }

  *[Symbol.iterator](): Generator<[Owner, Set<Key>]> {
    let cursor = this.newest;
    while (cursor) {
      const previous = cursor.previous;
      yield [cursor.owner, cursor.keys];
      cursor = previous;
    }
  }

  private unlink(entry: Entry<Owner, Key>): void {
    if (entry.next) entry.next.previous = entry.previous;
    else this.newest = entry.previous;
    if (entry.previous) entry.previous.next = entry.next;
  }
}

const reachProofs = new WeakMap<object, object>();
const proofChildren = new WeakMap<object, Set<object>>();
const proofParents = new WeakMap<object, object>();
const proofDepths = new WeakMap<object, number>();

export function proofRoot(owner: object): object | undefined {
  return reachProofs.get(owner);
}

export function hasProofParent(child: object, owner: object): boolean {
  return proofParents.get(child) === owner;
}

export function invalidateOwner(owner: object): void {
  const pending = [owner];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop() as object;
    if (visited.has(value)) continue;
    visited.add(value);
    reachProofs.delete(value);
    proofDepths.delete(value);
    const parent = proofParents.get(value);
    if (parent) proofChildren.get(parent)?.delete(value);
    proofParents.delete(value);
    const children = proofChildren.get(value);
    if (children) {
      for (const child of children) if (proofParents.get(child) === value) pending.push(child);
      proofChildren.delete(value);
    }
  }
}

export function ownershipProof(value: object, isRoot: (value: object) => boolean): object | undefined {
  const root = reachProofs.get(value);
  return root !== undefined && isRoot(root) ? root : undefined;
}

export function rememberOwnership(path: object[], root: object): void {
  if (path.length === 0) return;
  const first = path[0];
  if (first === root && reachProofs.get(first) !== root) {
    if (proofChildren.get(first)?.size) invalidateOwner(first);
    detachParent(first);
    reachProofs.set(first, root);
    proofDepths.set(first, 0);
  }
  if (reachProofs.get(first) !== root) return;
  for (let index = 0; index + 1 < path.length; index++) attachProofChild(path[index], path[index + 1], root);
}

function attachProofChild(value: object, child: object, root: object): void {
  if (child === value) return;
  const nextDepth = (proofDepths.get(value) ?? 0) + 1;
  const sameRoot = reachProofs.get(child) === root;
  if (sameRoot && (proofDepths.get(child) ?? Infinity) <= nextDepth) return;
  if (!sameRoot && proofChildren.get(child)?.size) invalidateOwner(child);
  detachParent(child);
  proofParents.set(child, value);
  let children = proofChildren.get(value);
  if (!children) {
    children = new Set();
    proofChildren.set(value, children);
  }
  children.add(child);
  reachProofs.set(child, root);
  proofDepths.set(child, nextDepth);
}

function detachParent(node: object): void {
  const parent = proofParents.get(node);
  if (parent) proofChildren.get(parent)?.delete(node);
  proofParents.delete(node);
}
