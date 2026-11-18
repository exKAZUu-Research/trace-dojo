import { physicalUnion } from './bufferMemory';
import type { FunctionInstance } from './functions';
import type { Frame } from './runtime';
import type { Type } from './types';
import {
  isUndefinedMemory,
  NativeHandle,
  Pointer,
  Slice,
  type Slots,
  Some,
  type Value,
  ZArray,
  zeroArrayElement,
  ZStruct,
  ZUnion,
} from './values';

interface Root {
  cell: Slots;
  type: Type;
}
interface WorkItem {
  value: unknown;
  type?: Type;
}
type Push = (value: unknown, type?: Type) => void;

export class TurtleReachability {
  private readonly typeCache = new WeakMap<Type, boolean>();
  private readonly frameTypes = new WeakMap<FunctionInstance, ReadonlyMap<number, Type>>();

  constructor(private readonly spend: (cost?: number) => void) {}

  // code-gauge-allow functionCognitiveComplexity 21 -- Collects typed roots and walks the graph without host recursion.
  // code-gauge-allow functionNcss 33 -- Keeps per-collection work and cycle tracking together.
  collect(globals: readonly Root[], frames: readonly Frame[]): Set<unknown> {
    const stack: WorkItem[] = [];
    const push: Push = (value, type) => {
      this.spend();
      if (type && !this.mayContainTurtles(type)) return;
      if (typeof value === 'object' && value !== null) stack.push({ value, type });
    };
    for (const global of globals) push(global.cell.slots[0], global.type);
    for (const frame of frames) {
      const types = this.typesOf(frame.fn);
      for (const [index, value] of frame.slots.entries()) push(value, types.get(index));
      for (const { value, type } of frame.temporaries) push(value, type);
    }
    const reached = new WeakMap<object, Set<Type | undefined>>();
    const turtles = new Set<unknown>();
    while (stack.length > 0) {
      const { value, type } = stack.pop() as WorkItem;
      const item = value as object;
      let types = reached.get(item);
      if (types?.has(type) || isUndefinedMemory(value as Value)) continue;
      if (!types) {
        types = new Set();
        reached.set(item, types);
      }
      types.add(type);
      if (type) this.typedChildren(value as Value, type, push, turtles);
      else this.children(item, push, turtles);
    }
    return turtles;
  }

  private typesOf(fn: FunctionInstance): ReadonlyMap<number, Type> {
    let types = this.frameTypes.get(fn);
    if (!types) {
      const slots = new Map<number, Type>();
      for (const [index, slot] of fn.paramSlots.entries()) {
        this.spend();
        slots.set(slot, fn.params[index]);
      }
      for (const local of fn.locals) {
        this.spend();
        slots.set(local.slot, local.type);
      }
      types = slots;
      this.frameTypes.set(fn, types);
    }
    return types;
  }

  private mayContainTurtles(type: Type): boolean {
    let result = this.typeCache.get(type);
    if (result === undefined) {
      result = this.contains(type, new Set());
      this.typeCache.set(type, result);
    }
    return result;
  }

  private contains(type: Type, seen: Set<Type>): boolean {
    this.spend();
    if (seen.has(type)) return false;
    seen.add(type);
    switch (type.kind) {
      case 'array': {
        return (type.length !== 0n || type.sentinel !== undefined) && this.contains(type.child, seen);
      }
      case 'pointer':
      case 'optional': {
        return this.contains(type.child, seen);
      }
      case 'error_union': {
        return this.contains(type.payload, seen);
      }
      case 'struct': {
        return Boolean(
          type.native !== undefined ||
          type.namespace.internal ||
          !type.fields ||
          type.fields.some((field) => this.contains(field.type, seen))
        );
      }
      case 'union': {
        return !type.fields || type.fields.some((field) => this.contains(field.type, seen));
      }
      case 'anyopaque':
      case 'anytype': {
        return true;
      }
      default: {
        return false;
      }
    }
  }

  // code-gauge-allow functionNcss 35 -- Covers each representation that can retain a turtle.
  private typedChildren(value: Value, type: Type, push: Push, turtles: Set<unknown>): void {
    if (value instanceof ZUnion && value.backingReferences) {
      this.unionChildren(value, push);
      return;
    }
    switch (type.kind) {
      case 'array': {
        if (value instanceof ZArray) this.sequence(value, type.child, push);
        return;
      }
      case 'pointer': {
        if (value instanceof Slice) this.sequence(value, type.child, push);
        else if (value instanceof Pointer) push(value.load(), type.child);
        return;
      }
      case 'optional': {
        push(value instanceof Some ? value.value : value, type.child);
        return;
      }
      case 'error_union': {
        push(value, type.payload);
        return;
      }
      case 'struct': {
        this.structChildren(value, type, push, turtles);
        return;
      }
      case 'union': {
        if (value instanceof ZUnion) this.unionChildren(value, push, type);
        return;
      }
      default: {
        if (value && typeof value === 'object') this.children(value, push, turtles);
      }
    }
  }

  private unionChildren(union: ZUnion, push: Push, type?: Extract<Type, { kind: 'union' }>): void {
    const retained = union.retainedPayloads;
    if (retained) {
      type ??= retained.type;
      for (const tag of retained.values.keys()) {
        this.spend();
        if (this.mayContainTurtles(retained.type.fields![tag].type)) {
          physicalUnion(retained.type, union);
          break;
        }
      }
    }
    if (union.backingReferences) {
      for (const { value, type } of union.backingReferences()) push(value, type);
      return;
    }
    const active = type?.fields?.[union.tag];
    if (!type || active) push(union.slots[0], active?.type);
  }

  private structChildren(
    value: Value,
    type: Extract<Type, { kind: 'struct' }>,
    push: Push,
    turtles: Set<unknown>
  ): void {
    if (!(value instanceof ZStruct && type.fields && !type.namespace.internal)) {
      if (value && typeof value === 'object') this.children(value, push, turtles);
      return;
    }
    for (const [index, field] of type.fields.entries())
      push(field.comptimeValue ? field.comptimeValue.value : value.slots[index], field.type);
    for (let index = type.fields.length; index < value.slots.length; index++) push(value.slots[index]);
  }

  private sequence(value: ZArray | Slice, child: Type, push: Push): void {
    if (!this.mayContainTurtles(child)) return;
    const extent = value instanceof Slice ? value.target.slots.length - value.start : value.length;
    const length = Math.min(value.length, extent);
    for (let index = 0; index < length; index++) {
      this.spend();
      push(value.get(index), child);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Traverses untyped temporaries and native storage without recursive host calls.
  private children(item: object, push: Push, turtles: Set<unknown>): void {
    if (item instanceof ZUnion) this.unionChildren(item, push);
    else if (item instanceof ZArray || item instanceof Slice) this.untypedSequence(item, push);
    else if (item instanceof ZStruct) {
      for (const value of item.slots) push(value);
    } else if (item instanceof Pointer) push(item.load());
    else if (item instanceof Some) push(item.value);
    else if (item instanceof NativeHandle) {
      if (item.state.turtle) turtles.add(item.state.turtle);
      for (const { value, type } of item.references(
        () => this.spend(),
        (type) => this.mayContainTurtles(type)
      ))
        push(value, type);
    } else if (Array.isArray(item)) {
      for (const value of item) push(value);
    } else if ('slots' in item && Array.isArray((item as Slots).slots)) {
      for (const value of (item as Slots).slots) push(value);
    }
  }
  private untypedSequence(value: ZArray | Slice, push: Push): void {
    if (value.lengthValue === 0n) return;
    const storage = value instanceof Slice ? value.target : value;
    const singleton = storage instanceof ZArray ? zeroArrayElement(storage) : undefined;
    if (singleton) {
      push(singleton.value);
      return;
    }
    for (let index = 0; BigInt(index) < value.lengthValue; index++) {
      this.spend();
      push(value.get(index));
    }
  }
}
