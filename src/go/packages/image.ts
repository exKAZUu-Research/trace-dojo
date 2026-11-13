// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt reads as they are.
import type { Entity, FuncEntity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, definePackage, fn, namedType, nativeFunction, perRun, typeEntity } from '../native';
import { indexPanic } from '../runtimeErrors';
import { BASIC, type FuncType, type NamedType, pointerTo, sliceOf, type StructType, type Type } from '../types';
import { Cell, copyValue, GoStruct, Iface, Pointer, type Slice, type Value } from '../values';
import { BUFIO_PACKAGE } from './bufio';
import {
  byteAt,
  IMAGE,
  imageValue,
  lengthOf,
  makePixels,
  mul3NonNeg,
  PALETTED_IMAGE,
  pixelStart,
  pointerValue,
  RGBA64_IMAGE,
  setByteAt,
  sliceFrom,
  sliceRange,
  ZERO_RECTANGLE,
} from './imageBytes';
import {
  ALPHA,
  ALPHA16,
  ALPHA16_MODEL,
  ALPHA_MODEL,
  CMYK,
  CMYK_MODEL,
  COLOR,
  colorRGBA,
  CONVERT_SIGNATURE,
  flatFields,
  GRAY,
  GRAY16,
  GRAY16_MODEL,
  GRAY_MODEL,
  MODEL,
  NRGBA,
  NRGBA64,
  NRGBA64_MODEL,
  NRGBA_MODEL,
  OPAQUE,
  PALETTE,
  paletteIndex,
  RGBA,
  RGBA64,
  RGBA64_MODEL,
  RGBA_MODEL,
  RGBA_SIGNATURE,
  rgbaOf,
  rgbToCMYK,
  toAlpha,
  toAlpha16,
  toCMYK,
  toGray,
  toGray16,
  toNRGBA,
  toNRGBA64,
  toRGBA,
  toRGBA64,
  TRANSPARENT,
  u8,
  u16,
  u32,
} from './imageColor';
import {
  canonical,
  contains,
  edges,
  height,
  i64,
  intersect,
  isEmpty,
  POINT,
  point,
  RECTANGLE,
  rectangle,
  width,
} from './imageGeometry';
import { newYCbCr, NYCBCRA_IMAGE, RATIO_NAMES, SUBSAMPLE_RATIO, YCBCR_IMAGE } from './imageYCbCr';
import { implementsInterface, IO_READER, libraryVariable } from './io';
import {
  BOOL,
  BYTES,
  callFunction,
  callMethod,
  ERROR_TYPE,
  INT,
  receiverStruct,
  sliceValues,
  spendFor,
  STRING,
  stringPanic,
} from './support';

const UINT8 = BASIC.uint8;

// Pixel images ------------------------------------------------------------------------------------------------------

/** The layout of one of the images whose pixels are `bytes` consecutive bytes of `Pix`. */
interface PixelFormat {
  name: string;
  bytes: number;
  /** Whether Go reads a pixel through `s := p.Pix[i : i+n : i+n]` rather than indexing `p.Pix` directly. */
  sliced: boolean;
  color: NamedType;
  model: Iface;
  convert: (color: Value) => Iface;
  decode: (bytes: bigint[]) => bigint[];
  encode: (fields: bigint[]) => bigint[];
  fromRGBA64: (channels: bigint[]) => bigint[];
  /** The offset of the first alpha byte in a pixel and whether alpha takes two bytes, for `Opaque`. */
  alpha?: { start: number; wide: boolean };
}

const PIXEL_FIELDS = (): StructType['fields'] => [
  { name: 'Pix', type: sliceOf(UINT8), embedded: false },
  { name: 'Stride', type: INT, embedded: false },
  { name: 'Rect', type: RECTANGLE, embedded: false },
];

function pixelOffset(fields: Value[], x: bigint, y: bigint, bytes: number): bigint {
  const [x0, y0] = edges(fields[2]);
  return i64(i64(i64(y - y0) * (fields[1] as bigint)) + i64(i64(x - x0) * BigInt(bytes)));
}

function readPixel(format: PixelFormat, fields: Value[], offset: bigint): bigint[] {
  const pix = fields[0];
  if (format.sliced) {
    const start = pixelStart(pix, offset, format.bytes);
    return Array.from({ length: format.bytes }, (_, at) => (pix as Slice).get(start + at) as bigint);
  }
  return Array.from({ length: format.bytes }, (_, at) => byteAt(pix, offset + BigInt(at)));
}

function writePixel(format: PixelFormat, fields: Value[], offset: bigint, bytes: bigint[]): void {
  const pix = fields[0];
  if (format.sliced) {
    const start = pixelStart(pix, offset, format.bytes);
    for (const [at, byte] of bytes.entries()) (pix as Slice).set(start + at, byte);
    return;
  }
  for (const [at, byte] of bytes.entries()) setByteAt(pix, offset + BigInt(at), byte);
}

/** The color fields of the pixel at a point, which are zero outside the image. */
function pixelColor(format: PixelFormat, receiver: Value, x: bigint, y: bigint): bigint[] {
  const fields = receiverStruct(receiver).fields;
  if (!contains(edges(fields[2]), x, y)) return format.decode(Array.from({ length: format.bytes }, () => 0n));
  return format.decode(readPixel(format, fields, pixelOffset(fields, x, y, format.bytes)));
}

/** Writes the bytes that `bytes` computes to a point inside the image, ignoring points outside it. */
function setPixel(format: PixelFormat, receiver: Value, x: bigint, y: bigint, bytes: () => bigint[]): void {
  const fields = receiverStruct(receiver).fields;
  if (!contains(edges(fields[2]), x, y)) return;
  const offset = pixelOffset(fields, x, y, format.bytes);
  writePixel(format, fields, offset, bytes());
}

/** `Opaque` of an image with alpha: every alpha byte of every row is 0xff. */
function opaque(format: PixelFormat, receiver: Value): boolean {
  const fields = receiverStruct(receiver).fields;
  const { alpha } = format;
  if (!alpha) return true;
  const bounds = edges(fields[2]);
  if (isEmpty(bounds)) return true;
  const stride = fields[1] as bigint;
  const step = BigInt(format.bytes);
  let start = BigInt(alpha.start);
  let end = i64(width(bounds) * step);
  for (let y = bounds[1]; y < bounds[3]; y++) {
    spendFor(Math.max(0, Number(end - start) / format.bytes));
    for (let index = start; index < end; index += step) {
      if (byteAt(fields[0], index) !== 0xffn) return false;
      if (alpha.wide && byteAt(fields[0], index + 1n) !== 0xffn) return false;
    }
    start = i64(start + stride);
    end = i64(end + stride);
  }
  return true;
}

function newPixelImage(format: PixelFormat, bounds: Value): Pointer {
  const length = mul3NonNeg(BigInt(format.bytes), width(edges(bounds)), height(edges(bounds)));
  if (length < 0n) stringPanic(`image: New${format.name} Rectangle has huge or negative dimensions`);
  return pointerValue([makePixels(length), i64(BigInt(format.bytes) * width(edges(bounds))), copyValue(bounds)]);
}

function pixelImageType(format: PixelFormat): NamedType {
  const type = namedType('image', format.name, { kind: 'struct', fields: PIXEL_FIELDS() });
  const method = (
    name: string,
    signature: FuncType,
    impl: (receiver: Value, args: Value[]) => Value | Value[]
  ): void => {
    if (!type.methods.some((existing) => existing.name === name)) addMethod(type, name, signature, impl, true);
  };
  const colorAt = (receiver: Value, [x, y]: Value[]): GoStruct =>
    new GoStruct(pixelColor(format, receiver, x as bigint, y as bigint));
  method('ColorModel', fn([], [MODEL]), () => format.model);
  method('Bounds', fn([], [RECTANGLE]), (receiver) => copyValue(receiverStruct(receiver).fields[2]));
  method('At', fn([INT, INT], [COLOR]), (receiver, args) => new Iface(format.color, colorAt(receiver, args)));
  method(
    'RGBA64At',
    fn([INT, INT], [RGBA64]),
    (receiver, args) => new GoStruct(colorRGBA(format.color, colorAt(receiver, args).fields as bigint[]).map(u16))
  );
  method(`${format.name}At`, fn([INT, INT], [format.color]), colorAt);
  method('PixOffset', fn([INT, INT], [INT]), (receiver, [x, y]) =>
    pixelOffset(receiverStruct(receiver).fields, x as bigint, y as bigint, format.bytes)
  );
  method('Set', fn([INT, INT, COLOR], []), (receiver, [x, y, color]) => {
    setPixel(format, receiver, x as bigint, y as bigint, () =>
      format.encode(flatFields(format.convert(color).value as GoStruct))
    );
    return;
  });
  method('SetRGBA64', fn([INT, INT, RGBA64], []), (receiver, [x, y, color]) => {
    setPixel(format, receiver, x as bigint, y as bigint, () => format.fromRGBA64(flatFields(color as GoStruct)));
    return;
  });
  method(`Set${format.name}`, fn([INT, INT, format.color], []), (receiver, [x, y, color]) => {
    setPixel(format, receiver, x as bigint, y as bigint, () => format.encode(flatFields(color as GoStruct)));
    return;
  });
  method('SubImage', fn([RECTANGLE], [IMAGE]), (receiver, [bounds]) => {
    const [pix, stride, rect] = receiverStruct(receiver).fields;
    const sub = intersect(edges(bounds), edges(rect));
    if (isEmpty(sub)) return imageValue(type, [undefined, 0n, ZERO_RECTANGLE()]);
    const offset = pixelOffset(receiverStruct(receiver).fields, sub[0], sub[1], format.bytes);
    return imageValue(type, [sliceFrom(pix, offset), stride, rectangle(sub)]);
  });
  method('Opaque', fn([], [BOOL]), (receiver) => opaque(format, receiver));
  return type;
}

const high = (value: bigint): bigint => u8(value >> 8n);
const split16 = (value: bigint): bigint[] => [u8(value >> 8n), u8(value)];
const join16 = (bytes: bigint[]): bigint[] =>
  Array.from({ length: bytes.length / 2 }, (_, at) => (bytes[2 * at] << 8n) | bytes[2 * at + 1]);

/** `(c * 0xffff) / a` for each color channel unless alpha is 0 or 0xffff, as SetRGBA64 of the non-premultiplied images does. */
function straight([r, g, b, a]: bigint[]): bigint[] {
  if (a === 0n || a === 0xff_ffn) return [r, g, b, a];
  return [...[r, g, b].map((channel) => u32(channel * 0xff_ffn) / a), a];
}

const gray = ([r, g, b]: bigint[], shift: bigint): bigint =>
  u32(19_595n * r + 38_470n * g + 7471n * b + (1n << 15n)) >> shift;

const FORMATS: PixelFormat[] = [
  {
    name: 'RGBA',
    bytes: 4,
    sliced: true,
    color: RGBA,
    model: RGBA_MODEL,
    convert: toRGBA,
    decode: (bytes) => bytes,
    encode: (fields) => fields,
    fromRGBA64: (channels) => channels.map(high),
    alpha: { start: 3, wide: false },
  },
  {
    name: 'RGBA64',
    bytes: 8,
    sliced: true,
    color: RGBA64,
    model: RGBA64_MODEL,
    convert: toRGBA64,
    decode: join16,
    encode: (fields) => fields.flatMap(split16),
    fromRGBA64: (channels) => channels.flatMap(split16),
    alpha: { start: 6, wide: true },
  },
  {
    name: 'NRGBA',
    bytes: 4,
    sliced: true,
    color: NRGBA,
    model: NRGBA_MODEL,
    convert: toNRGBA,
    decode: (bytes) => bytes,
    encode: (fields) => fields,
    fromRGBA64: (channels) => straight(channels).map(high),
    alpha: { start: 3, wide: false },
  },
  {
    name: 'NRGBA64',
    bytes: 8,
    sliced: true,
    color: NRGBA64,
    model: NRGBA64_MODEL,
    convert: toNRGBA64,
    decode: join16,
    encode: (fields) => fields.flatMap(split16),
    fromRGBA64: (channels) => straight(channels).flatMap(split16),
    alpha: { start: 6, wide: true },
  },
  {
    name: 'Alpha',
    bytes: 1,
    sliced: false,
    color: ALPHA,
    model: ALPHA_MODEL,
    convert: toAlpha,
    decode: (bytes) => bytes,
    encode: (fields) => fields,
    fromRGBA64: (channels) => [high(channels[3])],
    alpha: { start: 0, wide: false },
  },
  {
    name: 'Alpha16',
    bytes: 2,
    sliced: false,
    color: ALPHA16,
    model: ALPHA16_MODEL,
    convert: toAlpha16,
    decode: join16,
    encode: (fields) => split16(fields[0]),
    fromRGBA64: (channels) => split16(channels[3]),
    alpha: { start: 0, wide: true },
  },
  {
    name: 'Gray',
    bytes: 1,
    sliced: false,
    color: GRAY,
    model: GRAY_MODEL,
    convert: toGray,
    decode: (bytes) => bytes,
    encode: (fields) => fields,
    fromRGBA64: (channels) => [u8(gray(channels, 24n))],
  },
  {
    name: 'Gray16',
    bytes: 2,
    sliced: false,
    color: GRAY16,
    model: GRAY16_MODEL,
    convert: toGray16,
    decode: join16,
    encode: (fields) => split16(fields[0]),
    fromRGBA64: (channels) => split16(gray(channels, 16n)),
  },
  {
    name: 'CMYK',
    bytes: 4,
    sliced: true,
    color: CMYK,
    model: CMYK_MODEL,
    convert: toCMYK,
    decode: (bytes) => bytes,
    encode: (fields) => fields,
    fromRGBA64: (channels) => rgbToCMYK(high(channels[0]), high(channels[1]), high(channels[2])),
  },
];

const PIXEL_TYPES = FORMATS.map((format) => ({ format, type: pixelImageType(format) }));

function pixelMembers(): Record<string, Entity> {
  return Object.fromEntries(
    PIXEL_TYPES.flatMap(({ format, type }) => [
      [format.name, typeEntity(type)],
      [
        `New${format.name}`,
        nativeFunction(`New${format.name}`, fn([RECTANGLE], [pointerTo(type)]), ([bounds]) =>
          newPixelImage(format, bounds)
        ),
      ],
    ])
  );
}

// Paletted ----------------------------------------------------------------------------------------------------------

const PALETTED = namedType('image', 'Paletted', {
  kind: 'struct',
  fields: [...PIXEL_FIELDS(), { name: 'Palette', type: PALETTE, embedded: false }],
});

/** `p.Palette[index]`, panicking as Go does out of range. */
function paletteColor(palette: Value, index: bigint): Value {
  const length = lengthOf(palette);
  if (index >= BigInt(length)) indexPanic(index, length);
  return (palette as Slice).get(Number(index));
}

function palettedAt(receiver: Value, x: bigint, y: bigint): Value {
  const fields = receiverStruct(receiver).fields;
  if (lengthOf(fields[3]) === 0) return undefined;
  if (!contains(edges(fields[2]), x, y)) return paletteColor(fields[3], 0n);
  return paletteColor(fields[3], byteAt(fields[0], pixelOffset(fields, x, y, 1)));
}

function setPaletted(receiver: Value, x: bigint, y: bigint, index: () => bigint): void {
  const fields = receiverStruct(receiver).fields;
  if (!contains(edges(fields[2]), x, y)) return;
  const offset = pixelOffset(fields, x, y, 1);
  setByteAt(fields[0], offset, index());
}

const palettedMethod = (
  name: string,
  signature: FuncType,
  impl: (receiver: Value, args: Value[]) => Value | Value[]
): void => {
  addMethod(PALETTED, name, signature, impl, true);
};
palettedMethod('ColorModel', fn([], [MODEL]), (receiver) => new Iface(PALETTE, receiverStruct(receiver).fields[3]));
palettedMethod('Bounds', fn([], [RECTANGLE]), (receiver) => copyValue(receiverStruct(receiver).fields[2]));
palettedMethod('At', fn([INT, INT], [COLOR]), (receiver, [x, y]) => palettedAt(receiver, x as bigint, y as bigint));
palettedMethod('RGBA64At', fn([INT, INT], [RGBA64]), (receiver, [x, y]) => {
  if (lengthOf(receiverStruct(receiver).fields[3]) === 0) return new GoStruct([0n, 0n, 0n, 0n]);
  return new GoStruct(rgbaOf(palettedAt(receiver, x as bigint, y as bigint)).map(u16));
});
palettedMethod('PixOffset', fn([INT, INT], [INT]), (receiver, [x, y]) =>
  pixelOffset(receiverStruct(receiver).fields, x as bigint, y as bigint, 1)
);
palettedMethod('Set', fn([INT, INT, COLOR], []), (receiver, [x, y, color]) => {
  setPaletted(receiver, x as bigint, y as bigint, () =>
    u8(BigInt(paletteIndex(sliceValues(receiverStruct(receiver).fields[3]), color)))
  );
  return;
});
palettedMethod('SetRGBA64', fn([INT, INT, RGBA64], []), (receiver, [x, y, color]) => {
  setPaletted(receiver, x as bigint, y as bigint, () =>
    u8(BigInt(paletteIndex(sliceValues(receiverStruct(receiver).fields[3]), new Iface(RGBA64, copyValue(color)))))
  );
  return;
});
palettedMethod('ColorIndexAt', fn([INT, INT], [UINT8]), (receiver, [x, y]) => {
  const fields = receiverStruct(receiver).fields;
  if (!contains(edges(fields[2]), x as bigint, y as bigint)) return 0n;
  return byteAt(fields[0], pixelOffset(fields, x as bigint, y as bigint, 1));
});
palettedMethod('SetColorIndex', fn([INT, INT, UINT8], []), (receiver, [x, y, index]) => {
  setPaletted(receiver, x as bigint, y as bigint, () => index as bigint);
  return;
});
palettedMethod('SubImage', fn([RECTANGLE], [IMAGE]), (receiver, [bounds]) => {
  const fields = receiverStruct(receiver).fields;
  const [pix, stride, rect, palette] = fields;
  const sub = intersect(edges(bounds), edges(rect));
  if (isEmpty(sub)) return imageValue(PALETTED, [undefined, 0n, ZERO_RECTANGLE(), palette]);
  const offset = pixelOffset(fields, sub[0], sub[1], 1);
  return imageValue(PALETTED, [sliceFrom(pix, offset), stride, rectangle(intersect(edges(rect), sub)), palette]);
});
palettedMethod('Opaque', fn([], [BOOL]), (receiver) => {
  const [pix, stride, rect, palette] = receiverStruct(receiver).fields;
  const bounds = edges(rect);
  const present = new Set<bigint>();
  let start = 0n;
  let end = width(bounds);
  for (let y = bounds[1]; y < bounds[3]; y++) {
    for (const index of sliceRange(pix, start, end)) present.add(index);
    start = i64(start + (stride as bigint));
    end = i64(end + (stride as bigint));
  }
  for (const [index, color] of sliceValues(palette).entries()) {
    if (!present.has(BigInt(index))) continue;
    if (rgbaOf(color)[3] !== 0xff_ffn) return false;
  }
  return true;
});

// Uniform -----------------------------------------------------------------------------------------------------------

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
addMethod(UNIFORM, 'Opaque', fn([], [BOOL]), (receiver) => rgbaOf(uniformColor(receiver))[3] === 0xff_ffn, true);

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

// Formats -----------------------------------------------------------------------------------------------------------

const CONFIG = namedType('image', 'Config', {
  kind: 'struct',
  fields: [
    { name: 'ColorModel', type: MODEL, embedded: false },
    { name: 'Width', type: INT, embedded: false },
    { name: 'Height', type: INT, embedded: false },
  ],
});
const ERR_FORMAT = newError('image: unknown format');
const DECODE_FUNC = fn([IO_READER], [IMAGE, ERROR_TYPE]);
const DECODE_CONFIG_FUNC = fn([IO_READER], [CONFIG, ERROR_TYPE]);
const PEEKER: Type = {
  kind: 'interface',
  methods: [
    { name: 'Peek', type: fn([INT], [BYTES, ERROR_TYPE]) },
    { name: 'Read', type: fn([BYTES], [INT, ERROR_TYPE]) },
  ],
};

interface Format {
  name: string;
  magic: string;
  decode: Value;
  decodeConfig: Value;
}

/** The formats each run has registered, which none has until the program calls RegisterFormat. */
const formatsOfRun = perRun((): Format[] => []);

/** `asReader`: the reader itself when it can Peek, and a new `*bufio.Reader` over it otherwise. */
function asReader(reader: Value): Value {
  if (implementsInterface(reader, PEEKER)) return reader;
  const newReader = BUFIO_PACKAGE.members.get('NewReader') as FuncEntity;
  const result = (newReader.type as FuncType).results[0];
  return new Iface(result, (newReader.direct as (args: Value[]) => Value)([reader]));
}

/** Sniffs the registered formats in order and returns the first whose magic matches the reader's first bytes. */
function sniff(reader: Value): Format | undefined {
  for (const format of formatsOfRun()) {
    const [bytes, error] = callMethod(reader, 'Peek', [BigInt(format.magic.length)]) as [Value, Value];
    if (error !== undefined) continue;
    const peeked = sliceValues(bytes) as bigint[];
    const matches =
      peeked.length === format.magic.length &&
      peeked.every((byte, at) => format.magic[at] === '?' || BigInt(format.magic.charCodeAt(at)) === byte);
    if (matches) return format;
  }
  return undefined;
}

function decodeWith(reader: Value, pick: (format: Format) => Value, empty: Value): Value[] {
  const formats = formatsOfRun();
  const rr = formats.length === 0 ? reader : asReader(reader);
  const format = formats.length === 0 ? undefined : sniff(rr);
  const decode = format && pick(format);
  if (!format || decode === undefined) return [empty, '', ERR_FORMAT];
  const [result, error] = callFunction(decode, [rr]) as Value[];
  return [result, format.name, error];
}

// Package -----------------------------------------------------------------------------------------------------------

const imageMembers: Record<string, Entity> = {
  Image: typeEntity(IMAGE),
  RGBA64Image: typeEntity(RGBA64_IMAGE),
  PalettedImage: typeEntity(PALETTED_IMAGE),
  Point: typeEntity(POINT),
  Rectangle: typeEntity(RECTANGLE),
  Uniform: typeEntity(UNIFORM),
  Paletted: typeEntity(PALETTED),
  YCbCr: typeEntity(YCBCR_IMAGE),
  NYCbCrA: typeEntity(NYCBCRA_IMAGE),
  YCbCrSubsampleRatio: typeEntity(SUBSAMPLE_RATIO),
  Config: typeEntity(CONFIG),
  ...pixelMembers(),
  ...Object.fromEntries(
    RATIO_NAMES.map((name, index) => [
      `YCbCrSubsampleRatio${name}`,
      {
        kind: 'const',
        name: `YCbCrSubsampleRatio${name}`,
        type: SUBSAMPLE_RATIO,
        value: { kind: 'int', value: BigInt(index) },
        span: { row: 0, column: 0 },
        used: true,
      } satisfies Entity,
    ])
  ),
  ZP: libraryVariable('ZP', POINT, () => point(0n, 0n)),
  ZR: libraryVariable('ZR', RECTANGLE, () => ZERO_RECTANGLE()),
  ErrFormat: libraryVariable('ErrFormat', ERROR_TYPE, ERR_FORMAT),
  Black: uniformVariable('Black', () => new Iface(GRAY16, new GoStruct([0n]))),
  White: uniformVariable('White', () => new Iface(GRAY16, new GoStruct([0xff_ffn]))),
  Transparent: uniformVariable('Transparent', () => new Iface(ALPHA16, copyValue(TRANSPARENT))),
  Opaque: uniformVariable('Opaque', () => new Iface(ALPHA16, copyValue(OPAQUE))),
  Rect: nativeFunction('Rect', fn([INT, INT, INT, INT], [RECTANGLE]), (corners) =>
    rectangle(canonical(corners as bigint[]))
  ),
  Pt: nativeFunction('Pt', fn([INT, INT], [POINT]), ([x, y]) => point(x as bigint, y as bigint)),
  NewUniform: nativeFunction('NewUniform', fn([COLOR], [UNIFORM_POINTER]), ([color]) => newUniform(color)),
  NewPaletted: nativeFunction('NewPaletted', fn([RECTANGLE, PALETTE], [pointerTo(PALETTED)]), ([bounds, palette]) => {
    const length = mul3NonNeg(1n, width(edges(bounds)), height(edges(bounds)));
    if (length < 0n) stringPanic('image: NewPaletted Rectangle has huge or negative dimensions');
    return pointerValue([makePixels(length), width(edges(bounds)), copyValue(bounds), palette]);
  }),
  NewYCbCr: nativeFunction('NewYCbCr', fn([RECTANGLE, SUBSAMPLE_RATIO], [pointerTo(YCBCR_IMAGE)]), ([bounds, ratio]) =>
    pointerValue(newYCbCr(bounds, ratio as bigint, false))
  ),
  NewNYCbCrA: nativeFunction(
    'NewNYCbCrA',
    fn([RECTANGLE, SUBSAMPLE_RATIO], [pointerTo(NYCBCRA_IMAGE)]),
    ([bounds, ratio]) => pointerValue(newYCbCr(bounds, ratio as bigint, true))
  ),
  RegisterFormat: nativeFunction(
    'RegisterFormat',
    fn([STRING, STRING, DECODE_FUNC, DECODE_CONFIG_FUNC], []),
    ([name, magic, decode, decodeConfig]) => {
      formatsOfRun().push({ name: name as string, magic: magic as string, decode, decodeConfig });
      return;
    }
  ),
  Decode: nativeFunction('Decode', fn([IO_READER], [IMAGE, STRING, ERROR_TYPE]), ([reader]) =>
    decodeWith(reader, (format) => format.decode, undefined)
  ),
  DecodeConfig: nativeFunction('DecodeConfig', fn([IO_READER], [CONFIG, STRING, ERROR_TYPE]), ([reader]) =>
    decodeWith(reader, (format) => format.decodeConfig, new GoStruct([undefined, 0n, 0n]))
  ),
};

export const IMAGE_PACKAGE = definePackage('image', imageMembers);
