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
let ownershipWorkHandler: (cost: number) => void = () => {};

export function setOwnershipWorkHandler(handler: typeof ownershipWorkHandler): void {
  ownershipWorkHandler = handler;
}

export function proofRoot(owner: object): object | undefined {
  return reachProofs.get(owner);
}

export function proofChildrenOf(owner: object): Set<object> | undefined {
  return proofChildren.get(owner);
}

export function invalidateOwner(owner: object): void {
  const pending = [owner];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop() as object;
    if (visited.has(value)) continue;
    visited.add(value);
    reachProofs.delete(value);
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

// code-gauge-allow functionCognitiveComplexity 19 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function rememberOwnership(path: object[], root: object): void {
  for (let index = 0; index < path.length; index++) {
    const value = path[index];
    reachProofs.set(value, root);
    if (value === root) {
      const parent = proofParents.get(value);
      if (parent) proofChildren.get(parent)?.delete(value);
      proofParents.delete(value);
    }
    const child = path[index + 1];
    if (child && child !== value) {
      if (proofChildren.get(child)?.size && wouldProofCycle(value, child)) return;
      const previous = proofParents.get(child);
      if (previous) proofChildren.get(previous)?.delete(child);
      proofParents.set(child, value);
      let children = proofChildren.get(value);
      if (!children) {
        children = new Set();
        proofChildren.set(value, children);
      }
      children.add(child);
    }
  }
}

function wouldProofCycle(owner: object, child: object): boolean {
  let work = 0;
  for (let parent: object | undefined = owner; parent; parent = proofParents.get(parent)) {
    if ((++work & 63) === 0) ownershipWorkHandler(8);
    if (parent === child) {
      ownershipWorkHandler(Math.ceil((work & 63) / 8));
      return true;
    }
  }
  ownershipWorkHandler(Math.ceil((work & 63) / 8));
  return false;
}
