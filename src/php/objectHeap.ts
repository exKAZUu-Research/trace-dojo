import type { PhpObject } from './values';

export class ObjectHeap {
  private readonly slots: (PhpObject | undefined)[] = [];
  private readonly live = new Set<PhpObject>();

  get size(): number {
    return this.live.size;
  }

  get(id: number): PhpObject | undefined {
    return this.slots[id];
  }

  set(id: number, object: PhpObject): void {
    const previous = this.slots[id];
    if (previous) this.live.delete(previous);
    this.slots[id] = object;
    this.live.add(object);
  }

  delete(id: number): void {
    const object = this.slots[id];
    if (object) this.live.delete(object);
    this.slots[id] = undefined;
  }

  values(): SetIterator<PhpObject> {
    return this.live.values();
  }
}
