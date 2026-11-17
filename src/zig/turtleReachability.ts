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
      for (const value of frame.temporaries) push(value);
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
    try {
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
    } finally {
      seen.delete(type);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 28 -- Dispatches typed edges while preserving native opaque state.
  // code-gauge-allow functionNcss 36 -- Covers each representation that can retain a turtle.
  private typedChildren(value: Value, type: Type, push: Push, turtles: Set<unknown>): void {
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
        if (value instanceof ZStruct && type.fields && !type.native && !type.namespace.internal) {
          for (const [index, field] of type.fields.entries())
            push(field.comptimeValue ? field.comptimeValue.value : value.slots[index], field.type);
        } else if (value && typeof value === 'object') this.children(value, push, turtles);
        return;
      }
      case 'union': {
        if (value instanceof ZUnion) {
          const field = type.fields?.[value.tag];
          if (field) push(value.slots[0], field.type);
        }
        return;
      }
      default: {
        if (value && typeof value === 'object') this.children(value, push, turtles);
      }
    }
  }

  private sequence(value: ZArray | Slice, child: Type, push: Push): void {
    if (!this.mayContainTurtles(child)) return;
    for (let index = 0; BigInt(index) < value.lengthValue; index++) {
      this.spend();
      push(value.get(index), child);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Traverses untyped temporaries and native storage without recursive host calls.
  private children(item: object, push: Push, turtles: Set<unknown>): void {
    if (item instanceof ZArray || item instanceof ZStruct || item instanceof ZUnion) {
      for (const value of item.slots) push(value);
    } else if (item instanceof Pointer || item instanceof Slice) push(item.target);
    else if (item instanceof Some) push(item.value);
    else if (item instanceof NativeHandle) {
      if (item.state.turtle) turtles.add(item.state.turtle);
      for (const value of Object.values(item.state)) push(value);
    } else if (Array.isArray(item)) {
      for (const value of item) push(value);
    } else if ('slots' in item && Array.isArray((item as Slots).slots)) {
      for (const value of (item as Slots).slots) push(value);
    }
  }
}
