import { roundUpToSizeClass } from './conversions';
import { type Type, underlying } from './types';
import { copyValue, Slice, type Value } from './values';

const PAGE_SIZE = 8192;
const MAX_SMALL_SIZE = 32_768;
const MALLOC_HEADER_SIZE = 8;
const MIN_SIZE_FOR_MALLOC_HEADER = 512;
/** The size of the buffer Go's compiler reserves on the stack for appends to a slice whose array stays local. */
export const STACK_BUFFER_SIZE = 32;
/** Arrays that stand for Go's stack buffers, which moving a slice to the heap copies. */
const stackArrays = new WeakSet<Value[]>();

/**
 * How an append may use the stack buffer: `static` gives an empty slice the whole buffer at once, and `buffer` grows
 * into it one size class at a time, as Go's growsliceBuf does.
 */
export type StackBuffer = 'static' | 'buffer';

/** The size of a value of the type in bytes on a 64-bit platform, as `unsafe.Sizeof` reports it. */
export function sizeOf(type: Type): number {
  return layoutOf(type).size;
}

function layoutOf(type: Type): { size: number; align: number } {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      const sizes: Record<string, number> = {
        bool: 1,
        int8: 1,
        uint8: 1,
        int16: 2,
        uint16: 2,
        int32: 4,
        uint32: 4,
        float32: 4,
        complex64: 8,
        complex128: 16,
        string: 16,
      };
      const size = sizes[under.basic] ?? 8;
      return { size, align: under.basic === 'complex64' ? 4 : Math.min(size, 8) };
    }
    case 'slice': {
      return { size: 24, align: 8 };
    }
    case 'interface': {
      return { size: 16, align: 8 };
    }
    case 'array': {
      const element = layoutOf(under.element);
      return { size: element.size * under.length, align: element.align };
    }
    case 'struct': {
      let offset = 0;
      let align = 1;
      let lastSize = 0;
      for (const field of under.fields) {
        const layout = layoutOf(field.type);
        offset = Math.ceil(offset / layout.align) * layout.align + layout.size;
        align = Math.max(align, layout.align);
        lastSize = layout.size;
      }
      // A non-zero-size struct ending in a zero-size field gets padding so that a pointer to that field stays inside the struct.
      if (offset > 0 && lastSize === 0) offset++;
      return { size: Math.ceil(offset / align) * align, align };
    }
    default: {
      return { size: 8, align: 8 };
    }
  }
}

/** Whether an interface holds a value of the type itself rather than a pointer to a copy (types.IsDirectIface). */
export function isPointerShaped(type: Type): boolean {
  const under = underlying(type);
  switch (under.kind) {
    case 'pointer':
    case 'map':
    case 'func': {
      return true;
    }
    case 'array': {
      return under.length === 1 && isPointerShaped(under.element);
    }
    case 'struct': {
      return under.fields.length === 1 && isPointerShaped(under.fields[0].type);
    }
    default: {
      return false;
    }
  }
}

/**
 * Whether Go's compiler passes the address of a value of the type to the runtime function converting it to an
 * interface, rather than the value itself (walk.dataWordFuncName).
 */
export function boxesByAddress(type: Type): boolean {
  const { size, align } = layoutOf(type);
  if ((size === 2 || size === 4 || size === 8) && align === size) return false;
  const sole = soleComponent(type);
  return !sole || (underlying(sole).kind !== 'slice' && !isBasicString(sole));
}

function soleComponent(type: Type): Type | undefined {
  const under = underlying(type);
  if (under.kind === 'struct') return under.fields.length === 1 ? soleComponent(under.fields[0].type) : undefined;
  if (under.kind === 'array') return under.length === 1 ? soleComponent(under.element) : undefined;
  return type;
}

function isBasicString(type: Type): boolean {
  const under = underlying(type);
  return under.kind === 'basic' && under.basic === 'string';
}

/** Whether values of the type hold pointers, which decides whether Go's allocator adds a header to large objects. */
export function hasPointers(type: Type): boolean {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      return under.basic === 'string';
    }
    case 'array': {
      return under.length > 0 && hasPointers(under.element);
    }
    case 'struct': {
      return under.fields.some((field) => hasPointers(field.type));
    }
    default: {
      return true;
    }
  }
}

/** The capacity of the new array that `append` allocates, as Go's growslice computes it. */
export function grownCapacity(oldCapacity: number, newLength: number, element: Type): number {
  const size = sizeOf(element);
  if (size === 0) return newLength;
  return Math.floor(roundUpSize(nextCapacity(newLength, oldCapacity) * size, !hasPointers(element)) / size);
}

function nextCapacity(newLength: number, oldCapacity: number): number {
  const double = oldCapacity * 2;
  if (newLength > double) return newLength;
  const threshold = 256;
  if (oldCapacity < threshold) return double;
  let capacity = oldCapacity;
  while (capacity < newLength) capacity += (capacity + 3 * threshold) >> 2;
  return capacity;
}

function roundUpSize(size: number, noScan: boolean): number {
  if (size <= MAX_SMALL_SIZE - MALLOC_HEADER_SIZE) {
    const header = !noScan && size > MIN_SIZE_FOR_MALLOC_HEADER ? MALLOC_HEADER_SIZE : 0;
    return roundUpToSizeClass(size + header) - header;
  }
  return Math.ceil(size / PAGE_SIZE) * PAGE_SIZE;
}

/** `append(slice, values...)`, which writes into the slice's array while it has room, as Go does. */
export function appendValues(
  slice: Slice | undefined,
  values: Value[],
  element: Type,
  zero: () => Value,
  allocate: (count: number) => void,
  stack?: StackBuffer
): Slice | undefined {
  const length = slice?.length ?? 0;
  const capacity = slice?.capacity ?? 0;
  const newLength = length + values.length;
  if (values.length === 0) return slice;
  if (slice && newLength <= capacity) {
    const copied = values.map(copyValue);
    for (const [index, value] of copied.entries()) slice.set(length + index, value);
    return new Slice(slice.array, slice.offset, newLength, capacity);
  }
  const stackCapacity = stack && stackBufferCapacity(stack, length, newLength, element);
  const newCapacity = stackCapacity ?? grownCapacity(capacity, newLength, element);
  allocate(newCapacity);
  const array: Value[] = slice ? slice.values().map(copyValue) : [];
  for (const value of values) array.push(copyValue(value));
  while (array.length < newCapacity) array.push(zero());
  if (stackCapacity !== undefined) stackArrays.add(array);
  return new Slice(array, 0, newLength, newCapacity);
}

/** The capacity an append gets from the stack buffer, or undefined when it cannot use the buffer. */
function stackBufferCapacity(
  stack: StackBuffer,
  oldLength: number,
  newLength: number,
  element: Type
): number | undefined {
  const size = sizeOf(element);
  if (size === 0 || newLength * size > STACK_BUFFER_SIZE) return undefined;
  if (stack === 'static') return oldLength === 0 ? Math.floor(STACK_BUFFER_SIZE / size) : undefined;
  return Math.floor(roundUpSize(newLength * size, !hasPointers(element)) / size);
}

/** Whether the slice's array is a stack buffer, which tells whether an append used one. */
export function inStackBuffer(slice: Slice | undefined): boolean {
  return slice !== undefined && stackArrays.has(slice.array);
}

/**
 * Go's move2heap for a slice whose capacity the function never reads: an array in a stack buffer moves to the heap with
 * the capacity of the size class its length needs, as runtime.moveSliceNoCap allocates it.
 */
export function moveToHeap(
  slice: Slice | undefined,
  element: Type,
  zero: () => Value,
  allocate: (count: number) => void
): Slice | undefined {
  if (!inStackBuffer(slice)) return slice;
  const { length } = slice as Slice;
  const size = sizeOf(element);
  const capacity = length === 0 ? 0 : Math.floor(roundUpSize(length * size, !hasPointers(element)) / size);
  allocate(capacity);
  const array: Value[] = (slice as Slice).values().map(copyValue);
  while (array.length < capacity) array.push(zero());
  return new Slice(array, 0, length, capacity);
}
