import { addMethod, fn, namedType } from '../native';
import { BASIC, type FuncType, sliceOf } from '../types';
import { copyValue, GoStruct, Iface, Slice, type Value } from '../values';
import {
  add2NonNeg,
  byteAt,
  IMAGE,
  imageValue,
  makePixels,
  mul3NonNeg,
  sliceFrom,
  sliceRange,
  ZERO_RECTANGLE,
} from './imageBytes';
import { COLOR, colorRGBA, flatFields, MODEL, NYCBCRA, NYCBCRA_MODEL, RGBA64, YCBCR, YCBCR_MODEL } from './imageColor';
import { contains, edges, i64, intersect, isEmpty, RECTANGLE, rectangle, width } from './imageGeometry';
import { BOOL, INT, receiverStruct, STRING, stringPanic } from './support';

const UINT8 = BASIC.uint8;

// YCbCr and NYCbCrA -------------------------------------------------------------------------------------------------

export const SUBSAMPLE_RATIO = namedType('image', 'YCbCrSubsampleRatio', INT);
export const RATIO_NAMES = ['444', '422', '420', '440', '411', '410'];
addMethod(SUBSAMPLE_RATIO, 'String', fn([], [STRING]), (receiver) => {
  const name = RATIO_NAMES[Number(receiver as bigint)] as string | undefined;
  return `YCbCrSubsampleRatio${(receiver as bigint) >= 0n && name ? name : 'Unknown'}`;
});

export const YCBCR_IMAGE = namedType('image', 'YCbCr', {
  kind: 'struct',
  fields: [
    { name: 'Y', type: sliceOf(UINT8), embedded: false },
    { name: 'Cb', type: sliceOf(UINT8), embedded: false },
    { name: 'Cr', type: sliceOf(UINT8), embedded: false },
    { name: 'YStride', type: INT, embedded: false },
    { name: 'CStride', type: INT, embedded: false },
    { name: 'SubsampleRatio', type: SUBSAMPLE_RATIO, embedded: false },
    { name: 'Rect', type: RECTANGLE, embedded: false },
  ],
});
export const NYCBCRA_IMAGE = namedType('image', 'NYCbCrA', {
  kind: 'struct',
  fields: [
    { name: 'YCbCr', type: YCBCR_IMAGE, embedded: true },
    { name: 'A', type: sliceOf(UINT8), embedded: false },
    { name: 'AStride', type: INT, embedded: false },
  ],
});

/** The fields of a `*YCbCr`, or of the YCbCr that a `*NYCbCrA` embeds. */
function yCbCrFields(receiver: Value, embedded: boolean): Value[] {
  const fields = receiverStruct(receiver).fields;
  return embedded ? (fields[0] as GoStruct).fields : fields;
}

function yOffset(fields: Value[], x: bigint, y: bigint): bigint {
  const [x0, y0] = edges(fields[6]);
  return i64(i64(i64(y - y0) * (fields[3] as bigint)) + i64(x - x0));
}

function cOffset(fields: Value[], x: bigint, y: bigint): bigint {
  const [x0, y0] = edges(fields[6]);
  const stride = fields[4] as bigint;
  const [xDivisor, yDivisor] = (
    { 1: [2n, 1n], 2: [2n, 2n], 3: [1n, 2n], 4: [4n, 1n], 5: [4n, 2n] } as Record<string, bigint[]>
  )[String(fields[5] as bigint)] ?? [1n, 1n];
  return i64(i64(i64(y / yDivisor - y0 / yDivisor) * stride) + i64(x / xDivisor - x0 / xDivisor));
}

function yCbCrAt(fields: Value[], x: bigint, y: bigint): bigint[] {
  if (!contains(edges(fields[6]), x, y)) return [0n, 0n, 0n];
  const yi = yOffset(fields, x, y);
  const ci = cOffset(fields, x, y);
  return [byteAt(fields[0], yi), byteAt(fields[1], ci), byteAt(fields[2], ci)];
}

function aOffset(receiver: Value, x: bigint, y: bigint): bigint {
  const fields = receiverStruct(receiver).fields;
  const [x0, y0] = edges((fields[0] as GoStruct).fields[6]);
  return i64(i64(i64(y - y0) * (fields[2] as bigint)) + i64(x - x0));
}

function nYCbCrAAt(receiver: Value, x: bigint, y: bigint): GoStruct {
  const fields = yCbCrFields(receiver, true);
  if (!contains(edges(fields[6]), x, y)) return new GoStruct([new GoStruct([0n, 0n, 0n]), 0n]);
  const channels = yCbCrAt(fields, x, y);
  const alpha = byteAt(receiverStruct(receiver).fields[1], aOffset(receiver, x, y));
  return new GoStruct([new GoStruct(channels), alpha]);
}

/** The Y, Cb, and Cr slices of a sub-image starting at a point, as SubImage takes them. */
function yCbCrSub(fields: Value[], sub: bigint[]): Value[] {
  const yi = yOffset(fields, sub[0], sub[1]);
  const ci = cOffset(fields, sub[0], sub[1]);
  return [
    sliceFrom(fields[0], yi),
    sliceFrom(fields[1], ci),
    sliceFrom(fields[2], ci),
    fields[3],
    fields[4],
    fields[5],
    rectangle(sub),
  ];
}

const emptyYCbCr = (ratio: Value): GoStruct =>
  new GoStruct([undefined, undefined, undefined, 0n, 0n, ratio, ZERO_RECTANGLE()]);

const yCbCrMethod = (
  name: string,
  signature: FuncType,
  impl: (fields: Value[], args: Value[]) => Value | Value[]
): void => {
  addMethod(YCBCR_IMAGE, name, signature, (receiver, args) => impl(yCbCrFields(receiver, false), args), true);
};
yCbCrMethod('ColorModel', fn([], [MODEL]), () => YCBCR_MODEL);
yCbCrMethod('Bounds', fn([], [RECTANGLE]), (fields) => copyValue(fields[6]));
yCbCrMethod(
  'At',
  fn([INT, INT], [COLOR]),
  (fields, [x, y]) => new Iface(YCBCR, new GoStruct(yCbCrAt(fields, x as bigint, y as bigint)))
);
yCbCrMethod(
  'RGBA64At',
  fn([INT, INT], [RGBA64]),
  (fields, [x, y]) => new GoStruct(colorRGBA(YCBCR, yCbCrAt(fields, x as bigint, y as bigint)))
);
yCbCrMethod(
  'YCbCrAt',
  fn([INT, INT], [YCBCR]),
  (fields, [x, y]) => new GoStruct(yCbCrAt(fields, x as bigint, y as bigint))
);
yCbCrMethod('YOffset', fn([INT, INT], [INT]), (fields, [x, y]) => yOffset(fields, x as bigint, y as bigint));
yCbCrMethod('COffset', fn([INT, INT], [INT]), (fields, [x, y]) => cOffset(fields, x as bigint, y as bigint));
yCbCrMethod('SubImage', fn([RECTANGLE], [IMAGE]), (fields, [bounds]) => {
  const sub = intersect(edges(bounds), edges(fields[6]));
  if (isEmpty(sub)) return imageValue(YCBCR_IMAGE, emptyYCbCr(fields[5]).fields);
  return imageValue(YCBCR_IMAGE, yCbCrSub(fields, sub));
});
yCbCrMethod('Opaque', fn([], [BOOL]), () => true);

const nYCbCrAMethod = (
  name: string,
  signature: FuncType,
  impl: (receiver: Value, args: Value[]) => Value | Value[]
): void => {
  addMethod(NYCBCRA_IMAGE, name, signature, impl, true);
};
nYCbCrAMethod('ColorModel', fn([], [MODEL]), () => NYCBCRA_MODEL);
nYCbCrAMethod(
  'At',
  fn([INT, INT], [COLOR]),
  (receiver, [x, y]) => new Iface(NYCBCRA, nYCbCrAAt(receiver, x as bigint, y as bigint))
);
nYCbCrAMethod(
  'RGBA64At',
  fn([INT, INT], [RGBA64]),
  (receiver, [x, y]) => new GoStruct(colorRGBA(NYCBCRA, flatFields(nYCbCrAAt(receiver, x as bigint, y as bigint))))
);
nYCbCrAMethod('NYCbCrAAt', fn([INT, INT], [NYCBCRA]), (receiver, [x, y]) =>
  nYCbCrAAt(receiver, x as bigint, y as bigint)
);
nYCbCrAMethod('AOffset', fn([INT, INT], [INT]), (receiver, [x, y]) => aOffset(receiver, x as bigint, y as bigint));
nYCbCrAMethod('SubImage', fn([RECTANGLE], [IMAGE]), (receiver, [bounds]) => {
  const fields = yCbCrFields(receiver, true);
  const sub = intersect(edges(bounds), edges(fields[6]));
  if (isEmpty(sub)) return imageValue(NYCBCRA_IMAGE, [emptyYCbCr(fields[5]), undefined, 0n]);
  const [, a, aStride] = receiverStruct(receiver).fields;
  const ai = aOffset(receiver, sub[0], sub[1]);
  const ycbcr = new GoStruct(yCbCrSub(fields, sub));
  return imageValue(NYCBCRA_IMAGE, [ycbcr, sliceFrom(a, ai), aStride]);
});
nYCbCrAMethod('Opaque', fn([], [BOOL]), (receiver) => {
  const [ycbcr, a, aStride] = receiverStruct(receiver).fields;
  const bounds = edges((ycbcr as GoStruct).fields[6]);
  if (isEmpty(bounds)) return true;
  let start = 0n;
  let end = width(bounds);
  for (let y = bounds[1]; y < bounds[3]; y++) {
    if (sliceRange(a, start, end).some((alpha) => alpha !== 0xffn)) return false;
    start = i64(start + (aStride as bigint));
    end = i64(end + (aStride as bigint));
  }
  return true;
});

/** `yCbCrSize`: the luma and chroma dimensions of a rectangle under a subsample ratio. */
function yCbCrSize(bounds: Value, ratio: bigint): bigint[] {
  const [x0, y0, x1, y1] = edges(bounds);
  const w = i64(x1 - x0);
  const h = i64(y1 - y0);
  const halfWidth = i64(i64(x1 + 1n) / 2n - x0 / 2n);
  const quarterWidth = i64(i64(x1 + 3n) / 4n - x0 / 4n);
  const halfHeight = i64(i64(y1 + 1n) / 2n - y0 / 2n);
  const sizes: Record<string, bigint[]> = {
    1: [halfWidth, h],
    2: [halfWidth, halfHeight],
    3: [w, halfHeight],
    4: [quarterWidth, h],
    5: [quarterWidth, halfHeight],
  };
  return [w, h, ...(sizes[String(ratio)] ?? [w, h])];
}

export function newYCbCr(bounds: Value, ratio: bigint, withAlpha: boolean): Value[] {
  const [w, h, cw, ch] = yCbCrSize(bounds, ratio);
  const total = add2NonNeg(mul3NonNeg(withAlpha ? 2n : 1n, w, h), mul3NonNeg(2n, cw, ch));
  if (total < 0n) {
    stringPanic(
      withAlpha
        ? 'image: NewNYCbCrA Rectangle has huge or negative dimension'
        : 'image: NewYCbCr Rectangle has huge or negative dimensions'
    );
  }
  const i0 = w * h;
  const i1 = i0 + cw * ch;
  const i2 = i1 + cw * ch;
  const buffer = makePixels(withAlpha ? i2 + w * h : i2);
  const part = (from: bigint, to: bigint, capped = true): Slice =>
    new Slice(
      buffer.array,
      Number(from),
      Number(to - from),
      capped ? Number(to - from) : buffer.capacity - Number(from)
    );
  const ycbcr = new GoStruct([part(0n, i0), part(i0, i1), part(i1, i2), w, cw, ratio, copyValue(bounds)]);
  return withAlpha ? [ycbcr, part(i2, BigInt(buffer.length), false), w] : ycbcr.fields;
}
