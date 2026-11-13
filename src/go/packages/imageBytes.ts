import { currentRuntime, fn, namedType } from '../native';
import { boundsPanic, indexPanic, runtimeErrorPanic } from '../runtimeErrors';
import { BASIC, type NamedType, pointerTo } from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { COLOR, MODEL, RGBA64 } from './imageColor';
import { i64, RECTANGLE, rectangle } from './imageGeometry';
import { makeBytes } from './io';
import { INT, spendFor } from './support';

const UINT8 = BASIC.uint8;

const IMAGE_METHODS = [
  { name: 'At', type: fn([INT, INT], [COLOR]) },
  { name: 'Bounds', type: fn([], [RECTANGLE]) },
  { name: 'ColorModel', type: fn([], [MODEL]) },
];
export const IMAGE = namedType('image', 'Image', { kind: 'interface', methods: IMAGE_METHODS });
export const RGBA64_IMAGE = namedType('image', 'RGBA64Image', {
  kind: 'interface',
  methods: [...IMAGE_METHODS, { name: 'RGBA64At', type: fn([INT, INT], [RGBA64]) }],
});
export const PALETTED_IMAGE = namedType('image', 'PalettedImage', {
  kind: 'interface',
  methods: [...IMAGE_METHODS, { name: 'ColorIndexAt', type: fn([INT, INT], [UINT8]) }].toSorted((a, b) =>
    a.name < b.name ? -1 : 1
  ),
});

export function pointerValue(fields: Value[]): Pointer {
  currentRuntime().allocate(1);
  return new Pointer(new Cell(new GoStruct(fields)), 'v');
}

export function imageValue(type: NamedType, fields: Value[]): Iface {
  return new Iface(pointerTo(type), pointerValue(fields));
}

export const ZERO_RECTANGLE = (): GoStruct => rectangle([0n, 0n, 0n, 0n]);

// Byte access with Go's panics ---------------------------------------------------------------------------------------

export const lengthOf = (slice: Value): number => (slice as Slice | undefined)?.length ?? 0;

/** `s[i]` of a byte slice, panicking as Go does out of range. */
export function byteAt(slice: Value, index: bigint): bigint {
  const length = lengthOf(slice);
  if (index < 0n || index >= BigInt(length)) indexPanic(index, length);
  return (slice as Slice).get(Number(index)) as bigint;
}

export function setByteAt(slice: Value, index: bigint, value: bigint): void {
  const length = lengthOf(slice);
  if (index < 0n || index >= BigInt(length)) indexPanic(index, length);
  (slice as Slice).set(Number(index), value);
}

/** Checks `pix[offset : offset+n : offset+n]` as Go does and returns where it starts. */
export function pixelStart(pix: Value, offset: bigint, n: number): number {
  const capacity = (pix as Slice | undefined)?.capacity ?? 0;
  const end = i64(offset + BigInt(n));
  if (end < 0n) boundsPanic(`slice bounds out of range [::${end}]`);
  if (end > capacity) boundsPanic(`slice bounds out of range [::${end}] with capacity ${capacity}`);
  if (offset < 0n) boundsPanic(`slice bounds out of range [${offset}::]`);
  return Number(offset);
}

/** `s[from:]`, with Go's bounds check. */
export function sliceFrom(slice: Value, offset: bigint): Slice | undefined {
  const s = slice as Slice | undefined;
  const length = s?.length ?? 0;
  if (offset < 0n) boundsPanic(`slice bounds out of range [${offset}:]`);
  if (offset > length) boundsPanic(`slice bounds out of range [${offset}:${length}]`);
  if (!s) return undefined;
  const start = Number(offset);
  return new Slice(s.array, s.offset + start, s.length - start, s.capacity - start);
}

/** The bytes of `s[low:high]`, with Go's bounds checks. */
export function sliceRange(slice: Value, low: bigint, high: bigint): bigint[] {
  const s = slice as Slice | undefined;
  const capacity = s?.capacity ?? 0;
  if (high < 0n) boundsPanic(`slice bounds out of range [:${high}]`);
  if (high > capacity) boundsPanic(`slice bounds out of range [:${high}] with capacity ${capacity}`);
  if (low < 0n) boundsPanic(`slice bounds out of range [${low}:]`);
  if (low > high) boundsPanic(`slice bounds out of range [${low}:${high}]`);
  spendFor(Number(high - low));
  return Array.from({ length: Number(high - low) }, (_, at) => s?.array[s.offset + Number(low) + at] as bigint);
}

// Allocation --------------------------------------------------------------------------------------------------------

/** `mul3NonNeg`: x*y*z, or -1 when an operand is negative or the product overflows an int. */
export function mul3NonNeg(x: bigint, y: bigint, z: bigint): bigint {
  if (x < 0n || y < 0n || z < 0n) return -1n;
  const product = x * y * z;
  return product >= 1n << 63n || x * y >= 1n << 64n ? -1n : product;
}

export function add2NonNeg(x: bigint, y: bigint): bigint {
  if (x < 0n || y < 0n) return -1n;
  return x + y >= 1n << 63n ? -1n : x + y;
}

export function makePixels(length: bigint): Slice {
  if (length > 1n << 48n) runtimeErrorPanic('makeslice: len out of range');
  spendFor(Number(length));
  return makeBytes(Number(length));
}
