import { roundUpToSizeClass } from './conversions';
import { type Type, underlying } from './types';
import { copyValue, Slice, type Value } from './values';

const PAGE_SIZE = 8192;
const MAX_SMALL_SIZE = 32_768;
const MALLOC_HEADER_SIZE = 8;
const MIN_SIZE_FOR_MALLOC_HEADER = 512;
/**
 * Go's compiler gives a slice variable that starts empty a 32-byte buffer on the stack for its first append when the
 * slice does not escape, which shows in the capacity after that append.
 */
const STACK_BUFFER_SIZE = 32;
const stackArrays = new WeakSet<Value[]>();

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
export function grownCapacity(oldCapacity: number, newLength: number, element: Type, onStack: boolean): number {
  let capacity = nextCapacity(newLength, oldCapacity);
  const size = sizeOf(element);
  if (size === 0) return newLength;
  if (onStack && oldCapacity === 0 && newLength * size <= STACK_BUFFER_SIZE) {
    return Math.max(capacity, Math.floor(STACK_BUFFER_SIZE / size));
  }
  const bytes = roundUpSize(capacity * size, !hasPointers(element));
  capacity = Math.floor(bytes / size);
  return capacity;
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
  onStack = false
): Slice | undefined {
  const length = slice?.length ?? 0;
  const capacity = slice?.capacity ?? 0;
  const newLength = length + values.length;
  if (values.length === 0) return slice;
  if (slice && newLength <= capacity) {
    for (const [index, value] of values.entries()) slice.set(length + index, copyValue(value));
    return new Slice(slice.array, slice.offset, newLength, capacity);
  }
  const size = sizeOf(element);
  const usedStack = onStack && capacity === 0 && size > 0 && newLength * size <= STACK_BUFFER_SIZE;
  const newCapacity = grownCapacity(capacity, newLength, element, onStack);
  allocate(newCapacity);
  const array: Value[] = slice ? slice.values().map(copyValue) : [];
  for (const value of values) array.push(copyValue(value));
  while (array.length < newCapacity) array.push(zero());
  if (usedStack) stackArrays.add(array);
  return new Slice(array, 0, newLength, newCapacity);
}

/** Copies a stack-backed slice to a size-classed heap array when returning it cannot keep the stack buffer. */
export function moveSliceToHeap(
  slice: Slice | undefined,
  element: Type,
  zero: () => Value,
  allocate: (count: number) => void
): Slice | undefined {
  if (!slice || !stackArrays.has(slice.array)) return slice;
  const length = slice.length;
  const capacity = grownCapacity(0, Math.max(length, 1), element, false);
  allocate(capacity);
  const array: Value[] = slice.values().map(copyValue);
  while (array.length < capacity) array.push(zero());
  return new Slice(array, 0, length, capacity);
}
