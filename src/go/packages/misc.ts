import type { Entity } from '../entities';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, perRun, typeEntity } from '../native';
import { boundsPanic, divideByZeroPanic, indexPanic, nilPointerPanic, runtimeErrorPanic } from '../runtimeErrors';
import { BASIC, type NamedType, pointerTo, sliceOf, type Type } from '../types';
import { Cell, copyValue, GoFunc, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { callFunction, callMethod, INT, receiverStruct, sliceValues, spendFor, STRING, stringPanic } from './support';

// runtime -------------------------------------------------------------------------------------------------------

function stringConstant(name: string, value: string): Entity {
  return {
    kind: 'const',
    name,
    type: BASIC.untypedString,
    value: { kind: 'string', value },
    span: { row: 0, column: 0 },
    used: true,
  };
}

/** The platform of the reference toolchain that results are compared with, an arm64 Mac. */
const runtimeMembers: Record<string, Entity> = {
  GOOS: stringConstant('GOOS', 'darwin'),
  GOARCH: stringConstant('GOARCH', 'arm64'),
};

export const RUNTIME_PACKAGE = definePackage('runtime', runtimeMembers, [
  'Gosched',
  'GC',
  'NumGoroutine',
  'NumCPU',
  'GOMAXPROCS',
  'Goexit',
  'Caller',
  'Callers',
  'FuncForPC',
  'KeepAlive',
  'SetFinalizer',
  'AddCleanup',
  'ReadMemStats',
  'MemStats',
  'Stack',
  'Version',
  'GOROOT',
  'Error',
  'LockOSThread',
  'UnlockOSThread',
  'Breakpoint',
]);

// image/color and image ---------------------------------------------------------------------------------------------

// image/color and image ---------------------------------------------------------------------------------------------

const UINT8 = BASIC.uint8;
const UINT16 = BASIC.uint16;
const UINT32 = BASIC.uint32;
const RGBA_SIGNATURE = fn([], [UINT32, UINT32, UINT32, UINT32]);
const RGBA_FIELDS = ['R', 'G', 'B', 'A'];

const COLOR = namedType('color', 'Color', {
  kind: 'interface',
  methods: [{ name: 'RGBA', type: RGBA_SIGNATURE }],
});
const CONVERT_SIGNATURE = fn([COLOR], [COLOR]);
const MODEL = namedType('color', 'Model', {
  kind: 'interface',
  methods: [{ name: 'Convert', type: CONVERT_SIGNATURE }],
});

const RGBA = colorType('RGBA', RGBA_FIELDS, UINT8, (channels) => channels.map(widen));
const RGBA64 = colorType('RGBA64', RGBA_FIELDS, UINT16, (channels) => channels);
const NRGBA = colorType('NRGBA', RGBA_FIELDS, UINT8, ([r, g, b, a]) => [
  ...[r, g, b].map((channel) => (widen(channel) * a) / 0xffn),
  widen(a),
]);
const NRGBA64 = colorType('NRGBA64', RGBA_FIELDS, UINT16, ([r, g, b, a]) => [
  ...[r, g, b].map((channel) => (channel * a) / 0xff_ffn),
  a,
]);
const ALPHA = colorType('Alpha', ['A'], UINT8, ([a]) => Array.from({ length: 4 }, () => widen(a)));
const ALPHA16 = colorType('Alpha16', ['A'], UINT16, ([a]) => [a, a, a, a]);
const GRAY = colorType('Gray', ['Y'], UINT8, ([y]) => [widen(y), widen(y), widen(y), 0xff_ffn]);
const GRAY16 = colorType('Gray16', ['Y'], UINT16, ([y]) => [y, y, y, 0xff_ffn]);

function colorType(name: string, fields: string[], fieldType: Type, rgba: (channels: bigint[]) => bigint[]): NamedType {
  const type = namedType('color', name, {
    kind: 'struct',
    fields: fields.map((field) => ({ name: field, type: fieldType, embedded: false })),
  });
  addMethod(type, 'RGBA', RGBA_SIGNATURE, (receiver) => rgba((receiver as GoStruct).fields as bigint[]));
  return type;
}

/** Scales an 8-bit channel to 16 bits as `c |= c << 8` does. */
function widen(channel: bigint): bigint {
  return channel | (channel << 8n);
}

const u8 = (value: bigint): bigint => BigInt.asUintN(8, value);
const u16 = (value: bigint): bigint => BigInt.asUintN(16, value);
const u32 = (value: bigint): bigint => BigInt.asUintN(32, value);

/** `*color.modelFunc`, the type of the models that `color.ModelFunc` returns. */
const MODEL_FUNC = namedType('color', 'modelFunc', {
  kind: 'struct',
  fields: [{ name: 'f', type: CONVERT_SIGNATURE, embedded: false }],
});
addMethod(
  MODEL_FUNC,
  'Convert',
  CONVERT_SIGNATURE,
  (receiver, [color]) => callFunction(receiverStruct(receiver).fields[0], [color]),
  true
);

const toRGBA = conversion(RGBA, (channels) => channels.map((channel) => u8(channel >> 8n)));
const RGBA_MODEL = nativeModel(toRGBA);
const RGBA64_MODEL = nativeModel(conversion(RGBA64, (channels) => channels.map(u16)));
const NRGBA_MODEL = nativeModel(
  conversion(NRGBA, ([r, g, b, a]) => {
    if (a === 0xff_ffn) return [u8(r >> 8n), u8(g >> 8n), u8(b >> 8n), 0xffn];
    if (a === 0n) return [0n, 0n, 0n, 0n];
    return [...[r, g, b].map((channel) => u8((u32(channel * 0xff_ffn) / a) >> 8n)), u8(a >> 8n)];
  })
);
const NRGBA64_MODEL = nativeModel(
  conversion(NRGBA64, ([r, g, b, a]) => {
    if (a === 0xff_ffn) return [u16(r), u16(g), u16(b), 0xff_ffn];
    if (a === 0n) return [0n, 0n, 0n, 0n];
    return [...[r, g, b].map((channel) => u16(u32(channel * 0xff_ffn) / a)), u16(a)];
  })
);
const ALPHA_MODEL = nativeModel(conversion(ALPHA, (channels) => [u8(channels[3] >> 8n)]));
const ALPHA16_MODEL = nativeModel(conversion(ALPHA16, (channels) => [u16(channels[3])]));
const GRAY_MODEL = nativeModel(conversion(GRAY, ([r, g, b]) => [u8(luminance(r, g, b) >> 24n)]));
const GRAY16_MODEL = nativeModel(conversion(GRAY16, ([r, g, b]) => [u16(luminance(r, g, b) >> 16n)]));

/** A conversion as Go's color models do it: one that keeps colors of its type and converts others from their RGBA. */
function conversion(type: NamedType, convert: (channels: bigint[]) => bigint[]): (color: Value) => Iface {
  return (color) => {
    if (color instanceof Iface && color.type === type) return color;
    return new Iface(type, new GoStruct(convert(rgbaOf(color))));
  };
}

function nativeModel(convert: (color: Value) => Iface): Iface {
  return modelFunc(new GoFunc(([color]) => convert(color)));
}

function modelFunc(convert: Value): Iface {
  return new Iface(pointerTo(MODEL_FUNC), new Pointer(new Cell(new GoStruct([convert])), 'v'));
}

function luminance(r: bigint, g: bigint, b: bigint): bigint {
  return u32(19_595n * r + 38_470n * g + 7471n * b + (1n << 15n));
}

function rgbaOf(color: Value): bigint[] {
  if (!(color instanceof Iface)) nilPointerPanic();
  return callMethod(color, 'RGBA') as bigint[];
}

const PALETTE = namedType('color', 'Palette', sliceOf(COLOR));
addMethod(PALETTE, 'Convert', CONVERT_SIGNATURE, (receiver, [color]) => {
  const colors = sliceValues(receiver);
  return colors.length === 0 ? undefined : colors[paletteIndex(colors, color)];
});
addMethod(PALETTE, 'Index', fn([COLOR], [INT]), (receiver, [color]) =>
  BigInt(paletteIndex(sliceValues(receiver), color))
);

/** The index of the palette color closest to `color` in Euclidean RGBA space, as `Palette.Index` finds it. */
function paletteIndex(colors: Value[], color: Value): number {
  const target = rgbaOf(color);
  spendFor(colors.length);
  let best = 0;
  let bestSum = 0xff_ff_ff_ffn;
  for (const [index, candidate] of colors.entries()) {
    const channels = rgbaOf(candidate);
    const sum = u32(target.reduce((total, channel, at) => total + squaredDifference(channel, channels[at]), 0n));
    if (sum < bestSum) {
      if (sum === 0n) return index;
      best = index;
      bestSum = sum;
    }
  }
  return best;
}

function squaredDifference(x: bigint, y: bigint): bigint {
  const difference = u32(x - y);
  return u32(difference * difference) >> 2n;
}

const TRANSPARENT = new GoStruct([0n]);
const OPAQUE = new GoStruct([0xff_ffn]);

function libraryVariable(name: string, type: Type, value: () => Value): Entity {
  return {
    kind: 'var',
    name,
    type,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: value,
  };
}

const colorMembers: Record<string, Entity> = {
  Color: typeEntity(COLOR),
  Model: typeEntity(MODEL),
  Palette: typeEntity(PALETTE),
  RGBA: typeEntity(RGBA),
  RGBA64: typeEntity(RGBA64),
  NRGBA: typeEntity(NRGBA),
  NRGBA64: typeEntity(NRGBA64),
  Alpha: typeEntity(ALPHA),
  Alpha16: typeEntity(ALPHA16),
  Gray: typeEntity(GRAY),
  Gray16: typeEntity(GRAY16),
  ModelFunc: nativeFunction('ModelFunc', fn([CONVERT_SIGNATURE], [MODEL]), ([convert]) => modelFunc(convert)),
  White: libraryVariable('White', GRAY16, () => new GoStruct([0xff_ffn])),
  Black: libraryVariable('Black', GRAY16, () => new GoStruct([0n])),
  Transparent: libraryVariable('Transparent', ALPHA16, () => copyValue(TRANSPARENT)),
  Opaque: libraryVariable('Opaque', ALPHA16, () => copyValue(OPAQUE)),
  RGBAModel: libraryVariable('RGBAModel', MODEL, () => RGBA_MODEL),
  RGBA64Model: libraryVariable('RGBA64Model', MODEL, () => RGBA64_MODEL),
  NRGBAModel: libraryVariable('NRGBAModel', MODEL, () => NRGBA_MODEL),
  NRGBA64Model: libraryVariable('NRGBA64Model', MODEL, () => NRGBA64_MODEL),
  AlphaModel: libraryVariable('AlphaModel', MODEL, () => ALPHA_MODEL),
  Alpha16Model: libraryVariable('Alpha16Model', MODEL, () => ALPHA16_MODEL),
  GrayModel: libraryVariable('GrayModel', MODEL, () => GRAY_MODEL),
  Gray16Model: libraryVariable('Gray16Model', MODEL, () => GRAY16_MODEL),
};

export const COLOR_PACKAGE = definePackage('image/color', colorMembers, [
  'CMYK',
  'YCbCr',
  'NYCbCrA',
  'CMYKModel',
  'YCbCrModel',
  'NYCbCrAModel',
  'CMYKToRGB',
  'RGBToCMYK',
  'RGBToYCbCr',
  'YCbCrToRGB',
]);

const i64 = (value: bigint): bigint => BigInt.asIntN(64, value);

const POINT = namedType('image', 'Point', {
  kind: 'struct',
  fields: [
    { name: 'X', type: INT, embedded: false },
    { name: 'Y', type: INT, embedded: false },
  ],
});
const RECTANGLE = namedType('image', 'Rectangle', {
  kind: 'struct',
  fields: [
    { name: 'Min', type: POINT, embedded: false },
    { name: 'Max', type: POINT, embedded: false },
  ],
});

addMethod(POINT, 'String', fn([], [STRING]), (receiver) => pointText(coordinates(receiver)));
addMethod(POINT, 'Add', fn([POINT], [POINT]), (receiver, [other]) => {
  const [x, y] = coordinates(receiver);
  const [dx, dy] = coordinates(other);
  return point(i64(x + dx), i64(y + dy));
});
addMethod(POINT, 'Sub', fn([POINT], [POINT]), (receiver, [other]) => {
  const [x, y] = coordinates(receiver);
  const [dx, dy] = coordinates(other);
  return point(i64(x - dx), i64(y - dy));
});
addMethod(POINT, 'Mul', fn([INT], [POINT]), (receiver, [k]) => {
  const [x, y] = coordinates(receiver);
  return point(i64(x * (k as bigint)), i64(y * (k as bigint)));
});
addMethod(POINT, 'Div', fn([INT], [POINT]), (receiver, [k]) => {
  const [x, y] = coordinates(receiver);
  return point(divide(x, k as bigint), divide(y, k as bigint));
});
addMethod(POINT, 'In', fn([RECTANGLE], [BASIC.bool]), (receiver, [bounds]) => {
  const [x, y] = coordinates(receiver);
  return contains(edges(bounds), x, y);
});
addMethod(POINT, 'Mod', fn([RECTANGLE], [POINT]), (receiver, [bounds]) => {
  const [x, y] = coordinates(receiver);
  const [x0, y0, x1, y1] = edges(bounds);
  return point(i64(wrap(i64(x - x0), i64(x1 - x0)) + x0), i64(wrap(i64(y - y0), i64(y1 - y0)) + y0));
});
addMethod(POINT, 'Eq', fn([POINT], [BASIC.bool]), (receiver, [other]) => {
  const [x, y] = coordinates(receiver);
  const [ox, oy] = coordinates(other);
  return x === ox && y === oy;
});

addMethod(RECTANGLE, 'String', fn([], [STRING]), (receiver) => {
  const [x0, y0, x1, y1] = edges(receiver);
  return `${pointText([x0, y0])}-${pointText([x1, y1])}`;
});
addMethod(RECTANGLE, 'Dx', fn([], [INT]), (receiver) => width(edges(receiver)));
addMethod(RECTANGLE, 'Dy', fn([], [INT]), (receiver) => height(edges(receiver)));
addMethod(RECTANGLE, 'Size', fn([], [POINT]), (receiver) => {
  const bounds = edges(receiver);
  return point(width(bounds), height(bounds));
});
addMethod(RECTANGLE, 'Add', fn([POINT], [RECTANGLE]), (receiver, [offset]) => {
  const [x0, y0, x1, y1] = edges(receiver);
  const [dx, dy] = coordinates(offset);
  return rectangle([i64(x0 + dx), i64(y0 + dy), i64(x1 + dx), i64(y1 + dy)]);
});
addMethod(RECTANGLE, 'Sub', fn([POINT], [RECTANGLE]), (receiver, [offset]) => {
  const [x0, y0, x1, y1] = edges(receiver);
  const [dx, dy] = coordinates(offset);
  return rectangle([i64(x0 - dx), i64(y0 - dy), i64(x1 - dx), i64(y1 - dy)]);
});
addMethod(RECTANGLE, 'Inset', fn([INT], [RECTANGLE]), (receiver, [n]) => {
  const [x0, y0, x1, y1] = edges(receiver);
  const [minX, maxX] = inset(x0, x1, n as bigint);
  const [minY, maxY] = inset(y0, y1, n as bigint);
  return rectangle([minX, minY, maxX, maxY]);
});
addMethod(RECTANGLE, 'Intersect', fn([RECTANGLE], [RECTANGLE]), (receiver, [other]) =>
  rectangle(intersect(edges(receiver), edges(other)))
);
addMethod(RECTANGLE, 'Union', fn([RECTANGLE], [RECTANGLE]), (receiver, [other]) => {
  const bounds = edges(receiver);
  const others = edges(other);
  if (isEmpty(bounds)) return rectangle(others);
  if (isEmpty(others)) return rectangle(bounds);
  const [x0, y0, x1, y1] = bounds;
  const [ox0, oy0, ox1, oy1] = others;
  return rectangle([min(x0, ox0), min(y0, oy0), max(x1, ox1), max(y1, oy1)]);
});
addMethod(RECTANGLE, 'Empty', fn([], [BASIC.bool]), (receiver) => isEmpty(edges(receiver)));
addMethod(RECTANGLE, 'Eq', fn([RECTANGLE], [BASIC.bool]), (receiver, [other]) => {
  const bounds = edges(receiver);
  const others = edges(other);
  return bounds.every((edge, index) => edge === others[index]) || (isEmpty(bounds) && isEmpty(others));
});
addMethod(RECTANGLE, 'Overlaps', fn([RECTANGLE], [BASIC.bool]), (receiver, [other]) => {
  const bounds = edges(receiver);
  const others = edges(other);
  const [x0, y0, x1, y1] = bounds;
  const [ox0, oy0, ox1, oy1] = others;
  return !isEmpty(bounds) && !isEmpty(others) && x0 < ox1 && ox0 < x1 && y0 < oy1 && oy0 < y1;
});
addMethod(RECTANGLE, 'In', fn([RECTANGLE], [BASIC.bool]), (receiver, [other]) => {
  const bounds = edges(receiver);
  const [x0, y0, x1, y1] = bounds;
  const [ox0, oy0, ox1, oy1] = edges(other);
  return isEmpty(bounds) || (ox0 <= x0 && x1 <= ox1 && oy0 <= y0 && y1 <= oy1);
});
addMethod(RECTANGLE, 'Canon', fn([], [RECTANGLE]), (receiver) => rectangle(canonical(edges(receiver))));
addMethod(RECTANGLE, 'At', fn([INT, INT], [COLOR]), (receiver, [x, y]) =>
  contains(edges(receiver), x as bigint, y as bigint)
    ? new Iface(ALPHA16, copyValue(OPAQUE))
    : new Iface(ALPHA16, copyValue(TRANSPARENT))
);
addMethod(RECTANGLE, 'RGBA64At', fn([INT, INT], [RGBA64]), (receiver, [x, y]) => {
  const channel = contains(edges(receiver), x as bigint, y as bigint) ? 0xff_ffn : 0n;
  return new GoStruct([channel, channel, channel, channel]);
});
addMethod(RECTANGLE, 'Bounds', fn([], [RECTANGLE]), (receiver) => copyValue(receiver));
addMethod(RECTANGLE, 'ColorModel', fn([], [MODEL]), () => ALPHA16_MODEL);

function point(x: bigint, y: bigint): GoStruct {
  return new GoStruct([x, y]);
}

function coordinates(value: Value): bigint[] {
  return (value as GoStruct).fields as bigint[];
}

function pointText([x, y]: bigint[]): string {
  return `(${x},${y})`;
}

function divide(dividend: bigint, divisor: bigint): bigint {
  if (divisor === 0n) divideByZeroPanic();
  return i64(dividend / divisor);
}

/** `offset % size` moved into `[0, size)`, as `Point.Mod` computes each coordinate. */
function wrap(offset: bigint, size: bigint): bigint {
  if (size === 0n) divideByZeroPanic();
  const remainder = offset % size;
  return remainder < 0n ? i64(remainder + size) : remainder;
}

/** A rectangle's coordinates as `[Min.X, Min.Y, Max.X, Max.Y]`. */
function edges(value: Value): bigint[] {
  const [min, max] = (value as GoStruct).fields;
  return [...coordinates(min), ...coordinates(max)];
}

function rectangle([x0, y0, x1, y1]: bigint[]): GoStruct {
  return new GoStruct([point(x0, y0), point(x1, y1)]);
}

function width([x0, , x1]: bigint[]): bigint {
  return i64(x1 - x0);
}

function height([, y0, , y1]: bigint[]): bigint {
  return i64(y1 - y0);
}

function isEmpty([x0, y0, x1, y1]: bigint[]): boolean {
  return x0 >= x1 || y0 >= y1;
}

function contains([x0, y0, x1, y1]: bigint[], x: bigint, y: bigint): boolean {
  return x0 <= x && x < x1 && y0 <= y && y < y1;
}

function inset(low: bigint, high: bigint, n: bigint): [bigint, bigint] {
  if (i64(high - low) < i64(2n * n)) {
    const middle = i64(low + high) / 2n;
    return [middle, middle];
  }
  return [i64(low + n), i64(high - n)];
}

function intersect(bounds: bigint[], others: bigint[]): bigint[] {
  const [x0, y0, x1, y1] = bounds;
  const [ox0, oy0, ox1, oy1] = others;
  const result = [max(x0, ox0), max(y0, oy0), min(x1, ox1), min(y1, oy1)];
  return isEmpty(result) ? [0n, 0n, 0n, 0n] : result;
}

function canonical([x0, y0, x1, y1]: bigint[]): bigint[] {
  return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)];
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

const IMAGE_METHODS = [
  { name: 'At', type: fn([INT, INT], [COLOR]) },
  { name: 'Bounds', type: fn([], [RECTANGLE]) },
  { name: 'ColorModel', type: fn([], [MODEL]) },
];
const IMAGE = namedType('image', 'Image', { kind: 'interface', methods: IMAGE_METHODS });
const RGBA64_IMAGE = namedType('image', 'RGBA64Image', {
  kind: 'interface',
  methods: [...IMAGE_METHODS, { name: 'RGBA64At', type: fn([INT, INT], [RGBA64]) }],
});

const IMAGE_RGBA = namedType('image', 'RGBA', {
  kind: 'struct',
  fields: [
    { name: 'Pix', type: sliceOf(UINT8), embedded: false },
    { name: 'Stride', type: INT, embedded: false },
    { name: 'Rect', type: RECTANGLE, embedded: false },
  ],
});
const IMAGE_RGBA_POINTER = pointerTo(IMAGE_RGBA);

addMethod(IMAGE_RGBA, 'ColorModel', fn([], [MODEL]), () => RGBA_MODEL, true);
addMethod(IMAGE_RGBA, 'Bounds', fn([], [RECTANGLE]), (receiver) => copyValue(receiverStruct(receiver).fields[2]), true);
addMethod(
  IMAGE_RGBA,
  'At',
  fn([INT, INT], [COLOR]),
  (receiver, [x, y]) => new Iface(RGBA, new GoStruct(pixelAt(receiver, x as bigint, y as bigint))),
  true
);
addMethod(
  IMAGE_RGBA,
  'RGBAAt',
  fn([INT, INT], [RGBA]),
  (receiver, [x, y]) => new GoStruct(pixelAt(receiver, x as bigint, y as bigint)),
  true
);
addMethod(
  IMAGE_RGBA,
  'RGBA64At',
  fn([INT, INT], [RGBA64]),
  (receiver, [x, y]) => new GoStruct(pixelAt(receiver, x as bigint, y as bigint).map(widen)),
  true
);
addMethod(
  IMAGE_RGBA,
  'PixOffset',
  fn([INT, INT], [INT]),
  (receiver, [x, y]) => pixelOffset(receiverStruct(receiver), x as bigint, y as bigint),
  true
);
addMethod(
  IMAGE_RGBA,
  'Set',
  fn([INT, INT, COLOR], []),
  (receiver, [x, y, color]) => {
    setPixel(receiver, x as bigint, y as bigint, () => coordinates(toRGBA(color).value));
  },
  true
);
addMethod(
  IMAGE_RGBA,
  'SetRGBA',
  fn([INT, INT, RGBA], []),
  (receiver, [x, y, color]) => {
    setPixel(receiver, x as bigint, y as bigint, () => coordinates(color));
  },
  true
);
addMethod(
  IMAGE_RGBA,
  'SetRGBA64',
  fn([INT, INT, RGBA64], []),
  (receiver, [x, y, color]) => {
    setPixel(receiver, x as bigint, y as bigint, () => coordinates(color).map((channel) => u8(channel >> 8n)));
  },
  true
);
addMethod(
  IMAGE_RGBA,
  'SubImage',
  fn([RECTANGLE], [IMAGE]),
  (receiver, [bounds]) => {
    const image = receiverStruct(receiver);
    const [pix, stride, rect] = image.fields;
    const sub = intersect(edges(bounds), edges(rect));
    if (isEmpty(sub)) return newImage(undefined, 0n, rectangle([0n, 0n, 0n, 0n]));
    const offset = pixelOffset(image, sub[0], sub[1]);
    return newImage(sliceFrom(pix as Slice | undefined, offset), stride, rectangle(sub));
  },
  true
);
addMethod(
  IMAGE_RGBA,
  'Opaque',
  fn([], [BASIC.bool]),
  (receiver) => {
    const [pix, stride, rect] = receiverStruct(receiver).fields as [Slice | undefined, bigint, GoStruct];
    const bounds = edges(rect);
    if (isEmpty(bounds)) return true;
    let start = 3n;
    let end = i64(width(bounds) * 4n);
    for (let y = bounds[1]; y < bounds[3]; y++) {
      spendFor(Math.max(0, Number(end - start) / 4));
      for (let index = start; index < end; index += 4n) {
        if (index < 0n || index >= BigInt(pix?.length ?? 0)) indexPanic(index, pix?.length ?? 0);
        if ((pix as Slice).get(Number(index)) !== 0xffn) return false;
      }
      start = i64(start + stride);
      end = i64(end + stride);
    }
    return true;
  },
  true
);

function newImage(pix: Slice | undefined, stride: Value, bounds: GoStruct): Iface {
  return new Iface(IMAGE_RGBA_POINTER, new Pointer(new Cell(new GoStruct([pix, stride, bounds])), 'v'));
}

/** The RGBA channels at a point, which are zero outside the image. */
function pixelAt(receiver: Value, x: bigint, y: bigint): bigint[] {
  const image = receiverStruct(receiver);
  if (!contains(edges(image.fields[2]), x, y)) return [0n, 0n, 0n, 0n];
  const [pix] = image.fields as [Slice | undefined];
  const start = pixelStart(pix, pixelOffset(image, x, y));
  return [0, 1, 2, 3].map((channel) => (pix as Slice).get(start + channel) as bigint);
}

/** Writes the channels that `color` computes to a point inside the image, ignoring points outside it. */
function setPixel(receiver: Value, x: bigint, y: bigint, color: () => bigint[]): void {
  const image = receiverStruct(receiver);
  if (!contains(edges(image.fields[2]), x, y)) return;
  const offset = pixelOffset(image, x, y);
  const channels = color();
  const [pix] = image.fields as [Slice | undefined];
  const start = pixelStart(pix, offset);
  for (const [channel, value] of channels.entries()) (pix as Slice).set(start + channel, value);
}

function pixelOffset(image: GoStruct, x: bigint, y: bigint): bigint {
  const [, stride, rect] = image.fields as [unknown, bigint, GoStruct];
  const [x0, y0] = edges(rect);
  return i64(i64(i64(y - y0) * stride) + i64(i64(x - x0) * 4n));
}

/** Checks `pix[offset : offset+4 : offset+4]` as Go does and returns where it starts. */
function pixelStart(pix: Slice | undefined, offset: bigint): number {
  const capacity = pix?.capacity ?? 0;
  const end = i64(offset + 4n);
  if (end < 0n) boundsPanic(`slice bounds out of range [::${end}]`);
  if (end > capacity) boundsPanic(`slice bounds out of range [::${end}] with capacity ${capacity}`);
  if (offset < 0n) boundsPanic(`slice bounds out of range [${offset}::]`);
  return Number(offset);
}

/** `pix[offset:]`, with Go's bounds check. */
function sliceFrom(pix: Slice | undefined, offset: bigint): Slice | undefined {
  const length = pix?.length ?? 0;
  if (offset < 0n) boundsPanic(`slice bounds out of range [${offset}:]`);
  if (offset > length) boundsPanic(`slice bounds out of range [${offset}:${length}]`);
  if (!pix) return undefined;
  const start = Number(offset);
  return new Slice(pix.array, pix.offset + start, pix.length - start, pix.capacity - start);
}

const UNIFORM = namedType('image', 'Uniform', {
  kind: 'struct',
  fields: [{ name: 'C', type: COLOR, embedded: false }],
});
const UNIFORM_POINTER = pointerTo(UNIFORM);
const uniformColor = (receiver: Value): Value => receiverStruct(receiver).fields[0];
addMethod(UNIFORM, 'RGBA', RGBA_SIGNATURE, (receiver) => rgbaOf(uniformColor(receiver)), true);
addMethod(UNIFORM, 'ColorModel', fn([], [MODEL]), (receiver) => new Iface(UNIFORM_POINTER, receiver), true);
addMethod(UNIFORM, 'Convert', CONVERT_SIGNATURE, (receiver) => uniformColor(receiver), true);
addMethod(
  UNIFORM,
  'Bounds',
  fn([], [RECTANGLE]),
  () => rectangle([-1_000_000_000n, -1_000_000_000n, 1_000_000_000n, 1_000_000_000n]),
  true
);
addMethod(UNIFORM, 'At', fn([INT, INT], [COLOR]), (receiver) => uniformColor(receiver), true);
addMethod(
  UNIFORM,
  'RGBA64At',
  fn([INT, INT], [RGBA64]),
  (receiver) => new GoStruct(rgbaOf(uniformColor(receiver)).map(u16)),
  true
);
addMethod(UNIFORM, 'Opaque', fn([], [BASIC.bool]), (receiver) => rgbaOf(uniformColor(receiver))[3] === 0xff_ffn, true);

function newUniform(color: Value): Pointer {
  return new Pointer(new Cell(new GoStruct([color])), 'v');
}

function uniformVariable(name: string, color: () => Iface): Entity {
  return libraryVariable(
    name,
    UNIFORM_POINTER,
    perRun(() => newUniform(color()))
  );
}

const imageMembers: Record<string, Entity> = {
  Image: typeEntity(IMAGE),
  RGBA64Image: typeEntity(RGBA64_IMAGE),
  Point: typeEntity(POINT),
  Rectangle: typeEntity(RECTANGLE),
  RGBA: typeEntity(IMAGE_RGBA),
  Uniform: typeEntity(UNIFORM),
  ZP: libraryVariable('ZP', POINT, () => point(0n, 0n)),
  ZR: libraryVariable('ZR', RECTANGLE, () => rectangle([0n, 0n, 0n, 0n])),
  Black: uniformVariable('Black', () => new Iface(GRAY16, new GoStruct([0n]))),
  White: uniformVariable('White', () => new Iface(GRAY16, new GoStruct([0xff_ffn]))),
  Transparent: uniformVariable('Transparent', () => new Iface(ALPHA16, copyValue(TRANSPARENT))),
  Opaque: uniformVariable('Opaque', () => new Iface(ALPHA16, copyValue(OPAQUE))),
  Rect: nativeFunction('Rect', fn([INT, INT, INT, INT], [RECTANGLE]), (corners) =>
    rectangle(canonical(corners as bigint[]))
  ),
  Pt: nativeFunction('Pt', fn([INT, INT], [POINT]), ([x, y]) => point(x as bigint, y as bigint)),
  NewUniform: nativeFunction('NewUniform', fn([COLOR], [UNIFORM_POINTER]), ([color]) => newUniform(color)),
  NewRGBA: nativeFunction('NewRGBA', fn([RECTANGLE], [IMAGE_RGBA_POINTER]), ([bounds]) => {
    const corners = edges(bounds);
    const length = pixelBufferLength(width(corners), height(corners));
    if (length > 1n << 48n) runtimeErrorPanic('makeslice: len out of range');
    const size = Number(length);
    currentRuntime().allocate(size);
    spendFor(size);
    const pix = new Slice(
      Array.from({ length: size }, () => 0n),
      0,
      size,
      size
    );
    return newImage(pix, i64(4n * width(corners)), rectangle(corners)).value;
  }),
};

/** `4 * dx * dy`, the length of an RGBA image's pixels, which panics as Go's `pixelBufferLength` does. */
function pixelBufferLength(dx: bigint, dy: bigint): bigint {
  const length = 4n * dx * dy;
  if (dx < 0n || dy < 0n || length >= 1n << 63n)
    stringPanic('image: NewRGBA Rectangle has huge or negative dimensions');
  return length;
}

export const IMAGE_PACKAGE = definePackage('image', imageMembers, [
  'Alpha',
  'Alpha16',
  'CMYK',
  'Config',
  'Gray',
  'Gray16',
  'NRGBA',
  'NRGBA64',
  'NYCbCrA',
  'Paletted',
  'PalettedImage',
  'RGBA64',
  'YCbCr',
  'YCbCrSubsampleRatio',
  'YCbCrSubsampleRatio444',
  'YCbCrSubsampleRatio422',
  'YCbCrSubsampleRatio420',
  'YCbCrSubsampleRatio440',
  'YCbCrSubsampleRatio411',
  'YCbCrSubsampleRatio410',
  'NewAlpha',
  'NewAlpha16',
  'NewCMYK',
  'NewGray',
  'NewGray16',
  'NewNRGBA',
  'NewNRGBA64',
  'NewNYCbCrA',
  'NewPaletted',
  'NewRGBA64',
  'NewYCbCr',
  'Decode',
  'DecodeConfig',
  'RegisterFormat',
  'ErrFormat',
]);
