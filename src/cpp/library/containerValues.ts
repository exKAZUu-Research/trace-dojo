import type { DisplayNode } from '../../problems/trace';
import { CppRuntimeError } from '../errors';
import type { Type } from '../types';
import { Store, UNINIT, type Value } from '../values';

/** The elements of a sequence container: `std::vector`, `std::deque`, `std::array`, or `std::list`. */
export class SequenceValue extends Store {
  constructor(
    public items: Value[],
    readonly elementType: Type,
    /** Whether the trace shows the container as an array, as it shows a Java array. */
    readonly isArrayLike: boolean
  ) {
    super();
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
