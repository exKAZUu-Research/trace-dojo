import { indexPanic } from '../runtimeErrors';
import { grownCapacity } from '../sliceOps';
import { BASIC } from '../types';
import { Slice, type Value } from '../values';
import { makeBytes } from './io';

/** Indexed access to a `[]byte` that panics out of range as Go's `b[i]` does, for transcribing Go's byte loops. */
export class ByteView {
  readonly length: number;

  constructor(
    readonly slice: Slice | undefined,
    private readonly start = 0,
    length?: number
  ) {
    this.length = length ?? (slice?.length ?? 0) - start;
  }

  get(index: number): number {
    if (index < 0 || index >= this.length) indexPanic(index, this.length);
    return Number((this.slice as Slice).get(this.start + index) as bigint);
  }

  set(index: number, byte: number): void {
    if (index < 0 || index >= this.length) indexPanic(index, this.length);
    (this.slice as Slice).set(this.start + index, BigInt(byte & 0xff));
  }

  /** `b[from:]`, which still panics with indexes relative to the new start. */
  from(offset: number): ByteView {
    return new ByteView(this.slice, this.start + offset);
  }

  /** `b[:length]`. */
  prefix(length: number): ByteView {
    return new ByteView(this.slice, this.start, length);
  }
}

export function byteView(value: Value): ByteView {
  return new ByteView(value as Slice | undefined);
}

/** `slices.Grow(s, n)`: the slice with room for n more elements, reallocated as append grows it. */
export function growBytes(value: Value, n: number): Slice | undefined {
  const slice = value as Slice | undefined;
  const length = slice?.length ?? 0;
  const capacity = slice?.capacity ?? 0;
  if (capacity - length >= n) return slice;
  const grown = makeBytes(length, grownCapacity(capacity, capacity + n - (capacity - length), BASIC.uint8));
  for (let index = 0; index < length; index++) grown.array[index] = (slice as Slice).get(index);
  return grown;
}

/** `dst[len(dst):][:n]`, the view of the spare capacity that the Append functions encode into. */
export function spareView(slice: Slice | undefined, n: number): Slice | undefined {
  if (!slice) return undefined;
  return new Slice(slice.array, slice.offset + slice.length, n, slice.capacity - slice.length);
}

/** `make([]byte, n)` holding the bytes of a JavaScript byte string, sliced to `length`. */
export function bytesWithCapacity(bytes: string, length: number, capacity: number): Slice {
  const slice = makeBytes(length, capacity);
  // oxlint-disable-next-line unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255.
  for (let index = 0; index < bytes.length; index++) slice.array[index] = BigInt(bytes.charCodeAt(index));
  return slice;
}
