import type { Entity } from '../entities';
import { addMethod, definePackage, fn, namedType, nativeFunc, nativeFunction, typeEntity } from '../native';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, type NamedType, pointerTo, sliceOf, type Type } from '../types';
import { Cell, copyValue, GoStruct, Iface, Pointer, type Value } from '../values';
import { libraryVariable } from './io';
import { callFunction, callMethod, INT, receiverStruct, sliceValues, spendFor } from './support';

const UINT8 = BASIC.uint8;
const UINT16 = BASIC.uint16;
const UINT32 = BASIC.uint32;
export const RGBA_SIGNATURE = fn([], [UINT32, UINT32, UINT32, UINT32]);
const RGBA_FIELDS = ['R', 'G', 'B', 'A'];

export const COLOR = namedType('color', 'Color', {
  kind: 'interface',
  methods: [{ name: 'RGBA', type: RGBA_SIGNATURE }],
});
export const CONVERT_SIGNATURE = fn([COLOR], [COLOR]);
export const MODEL = namedType('color', 'Model', {
  kind: 'interface',
  methods: [{ name: 'Convert', type: CONVERT_SIGNATURE }],
});

export const u8 = (value: bigint): bigint => BigInt.asUintN(8, value);
export const u16 = (value: bigint): bigint => BigInt.asUintN(16, value);
export const u32 = (value: bigint): bigint => BigInt.asUintN(32, value);
const i32 = (value: bigint): bigint => BigInt.asIntN(32, value);

/** Scales an 8-bit channel to 16 bits as `c |= c << 8` does. */
export function widen(channel: bigint): bigint {
  return channel | (channel << 8n);
}

/** The `RGBA` method of each color type, from the type's fields. */
const rgbaFunctions = new Map<NamedType, (fields: bigint[]) => bigint[]>();

/** The premultiplied channels of a color of one of this package's types, from its fields. */
export function colorRGBA(type: NamedType, fields: bigint[]): bigint[] {
  return (rgbaFunctions.get(type) as (fields: bigint[]) => bigint[])(fields);
}

function colorType(name: string, fields: string[], fieldType: Type, rgba: (channels: bigint[]) => bigint[]): NamedType {
  const type = namedType('color', name, {
    kind: 'struct',
    fields: fields.map((field) => ({ name: field, type: fieldType, embedded: false })),
  });
  rgbaFunctions.set(type, rgba);
  addMethod(type, 'RGBA', RGBA_SIGNATURE, (receiver) => rgba(flatFields(receiver as GoStruct)));
  return type;
}

/** The fields of a color as integers, with an embedded YCbCr flattened in front. */
export function flatFields(color: GoStruct): bigint[] {
  return color.fields.flatMap((field) => (field instanceof GoStruct ? flatFields(field) : [field as bigint]));
}

export const RGBA = colorType('RGBA', RGBA_FIELDS, UINT8, (channels) => channels.map(widen));
export const RGBA64 = colorType('RGBA64', RGBA_FIELDS, UINT16, (channels) => channels);
export const NRGBA = colorType('NRGBA', RGBA_FIELDS, UINT8, ([r, g, b, a]) => [
  ...[r, g, b].map((channel) => (widen(channel) * a) / 0xffn),
  widen(a),
]);
export const NRGBA64 = colorType('NRGBA64', RGBA_FIELDS, UINT16, ([r, g, b, a]) => [
  ...[r, g, b].map((channel) => u32(channel * a) / 0xff_ffn),
  a,
]);
export const ALPHA = colorType('Alpha', ['A'], UINT8, ([a]) => Array.from({ length: 4 }, () => widen(a)));
export const ALPHA16 = colorType('Alpha16', ['A'], UINT16, ([a]) => [a, a, a, a]);
export const GRAY = colorType('Gray', ['Y'], UINT8, ([y]) => [widen(y), widen(y), widen(y), 0xff_ffn]);
export const GRAY16 = colorType('Gray16', ['Y'], UINT16, ([y]) => [y, y, y, 0xff_ffn]);
export const CMYK = colorType('CMYK', ['C', 'M', 'Y', 'K'], UINT8, ([c, m, y, k]) => {
  const w = 0xff_ffn - k * 0x1_01n;
  return [...[c, m, y].map((channel) => ((0xff_ffn - channel * 0x1_01n) * w) / 0xff_ffn), 0xff_ffn];
});
export const YCBCR = colorType('YCbCr', ['Y', 'Cb', 'Cr'], UINT8, ([y, cb, cr]) => [
  ...yCbCrChannels(y, cb, cr, 8n),
  0xff_ffn,
]);
export const NYCBCRA = colorType('NYCbCrA', ['YCbCr', 'A'], UINT8, ([y, cb, cr, alpha]) => {
  const a = alpha * 0x1_01n;
  return [...yCbCrChannels(y, cb, cr, 8n).map((channel) => u32(channel * a) / 0xff_ffn), a];
});
// NYCbCrA embeds YCbCr, whose fields and RGBA method it promotes.
const nycbcraFields = (NYCBCRA.underlying as { fields: { type: Type; embedded: boolean }[] }).fields;
nycbcraFields[0].type = YCBCR;
nycbcraFields[0].embedded = true;

/**
 * The red, green, and blue of a Y'CbCr color, clamped as Go clamps them: shifted down by 16 for 8-bit results
 * (`YCbCrToRGB`) or by 8 for 16-bit results (`YCbCr.RGBA`).
 */
function yCbCrChannels(y: bigint, cb: bigint, cr: bigint, shift: 8n | 16n): bigint[] {
  const yy1 = y * 0x1_01_01n;
  const cb1 = cb - 128n;
  const cr1 = cr - 128n;
  return [i32(yy1 + 91_881n * cr1), i32(yy1 - 22_554n * cb1 - 46_802n * cr1), i32(yy1 + 116_130n * cb1)].map(
    (channel) => clampShift(channel, shift)
  );
}

/** `if uint32(x)&0xff000000 == 0 { x >>= shift } else { x = ^(x >> 31) }`, masked to the result's width. */
function clampShift(value: bigint, shift: 8n | 16n): bigint {
  if ((u32(value) & 0xff_00_00_00n) === 0n) return value >> shift;
  const clamped = u32(~(value >> 31n));
  return shift === 8n ? clamped & 0xff_ffn : u8(clamped);
}

function rgbToYCbCr(r: bigint, g: bigint, b: bigint): bigint[] {
  const yy = (19_595n * r + 38_470n * g + 7471n * b + (1n << 15n)) >> 16n;
  const chroma = (value: bigint): bigint =>
    (u32(value) & 0xff_00_00_00n) === 0n ? value >> 16n : i32(~(value >> 31n));
  const cb = chroma(i32(-11_056n * r - 21_712n * g + 32_768n * b + (257n << 15n)));
  const cr = chroma(i32(32_768n * r - 27_440n * g - 5328n * b + (257n << 15n)));
  return [u8(yy), u8(cb), u8(cr)];
}

export function rgbToCMYK(r: bigint, g: bigint, b: bigint): bigint[] {
  let w = r;
  if (w < g) w = g;
  if (w < b) w = b;
  if (w === 0n) return [0n, 0n, 0n, 0xffn];
  return [...[r, g, b].map((channel) => ((w - channel) * 0xffn) / w), 0xffn - w];
}

function cmykToRGB(c: bigint, m: bigint, y: bigint, k: bigint): bigint[] {
  const w = 0xff_ffn - k * 0x1_01n;
  return [c, m, y].map((channel) => u8((((0xff_ffn - channel * 0x1_01n) * w) / 0xff_ffn) >> 8n));
}

// Models ------------------------------------------------------------------------------------------------------------

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

export function rgbaOf(color: Value): bigint[] {
  if (!(color instanceof Iface)) nilPointerPanic();
  return callMethod(color, 'RGBA') as bigint[];
}

/** A conversion as Go's color models do it: one that keeps colors of its type and converts others from their RGBA. */
function conversion(type: NamedType, convert: (channels: bigint[]) => bigint[]): (color: Value) => Iface {
  return (color) => {
    if (color instanceof Iface && color.type === type) return color;
    return new Iface(type, new GoStruct(convert(rgbaOf(color))));
  };
}

function modelFunc(convert: Value): Iface {
  return new Iface(pointerTo(MODEL_FUNC), new Pointer(new Cell(new GoStruct([convert])), 'v'));
}

function nativeModel(convert: (color: Value) => Iface): Iface {
  return modelFunc(nativeFunc(([color]) => convert(color)));
}

function luminance(r: bigint, g: bigint, b: bigint): bigint {
  return u32(19_595n * r + 38_470n * g + 7471n * b + (1n << 15n));
}

/** `(c * 0xffff) / a` for each color channel, which turns premultiplied channels into straight ones. */
function unpremultiply([r, g, b, a]: bigint[]): bigint[] {
  return [...[r, g, b].map((channel) => (channel * 0xff_ffn) / a), a];
}

export const toRGBA = conversion(RGBA, (channels) => channels.map((channel) => u8(channel >> 8n)));
export const toRGBA64 = conversion(RGBA64, (channels) => channels.map(u16));
export const toNRGBA = conversion(NRGBA, (channels) => {
  const a = channels[3];
  if (a === 0xff_ffn) return [...channels.slice(0, 3).map((channel) => u8(channel >> 8n)), 0xffn];
  if (a === 0n) return [0n, 0n, 0n, 0n];
  return unpremultiply(channels).map((channel) => u8(channel >> 8n));
});
export const toNRGBA64 = conversion(NRGBA64, (channels) => {
  const a = channels[3];
  if (a === 0xff_ffn) return [...channels.slice(0, 3).map(u16), 0xff_ffn];
  if (a === 0n) return [0n, 0n, 0n, 0n];
  return unpremultiply(channels).map(u16);
});
export const toAlpha = conversion(ALPHA, (channels) => [u8(channels[3] >> 8n)]);
export const toAlpha16 = conversion(ALPHA16, (channels) => [u16(channels[3])]);
export const toGray = conversion(GRAY, ([r, g, b]) => [u8(luminance(r, g, b) >> 24n)]);
export const toGray16 = conversion(GRAY16, ([r, g, b]) => [u16(luminance(r, g, b) >> 16n)]);
export const toCMYK = conversion(CMYK, ([r, g, b]) => rgbToCMYK(u8(r >> 8n), u8(g >> 8n), u8(b >> 8n)));
const toYCbCr = conversion(YCBCR, ([r, g, b]) => rgbToYCbCr(u8(r >> 8n), u8(g >> 8n), u8(b >> 8n)));

function toNYCbCrA(color: Value): Iface {
  if (color instanceof Iface && color.type === NYCBCRA) return color;
  if (color instanceof Iface && color.type === YCBCR) {
    return new Iface(NYCBCRA, new GoStruct([copyValue(color.value), 0xffn]));
  }
  const channels = rgbaOf(color);
  const a = channels[3];
  const [r, g, b] = a === 0n ? channels : unpremultiply(channels);
  return new Iface(
    NYCBCRA,
    new GoStruct([new GoStruct(rgbToYCbCr(u8(r >> 8n), u8(g >> 8n), u8(b >> 8n))), u8(a >> 8n)])
  );
}

export const RGBA_MODEL = nativeModel(toRGBA);
export const RGBA64_MODEL = nativeModel(toRGBA64);
export const NRGBA_MODEL = nativeModel(toNRGBA);
export const NRGBA64_MODEL = nativeModel(toNRGBA64);
export const ALPHA_MODEL = nativeModel(toAlpha);
export const ALPHA16_MODEL = nativeModel(toAlpha16);
export const GRAY_MODEL = nativeModel(toGray);
export const GRAY16_MODEL = nativeModel(toGray16);
export const CMYK_MODEL = nativeModel(toCMYK);
export const YCBCR_MODEL = nativeModel(toYCbCr);
export const NYCBCRA_MODEL = nativeModel(toNYCbCrA);

// Palette -----------------------------------------------------------------------------------------------------------

export const PALETTE = namedType('color', 'Palette', sliceOf(COLOR));
addMethod(PALETTE, 'Convert', CONVERT_SIGNATURE, (receiver, [color]) => {
  const colors = sliceValues(receiver);
  return colors.length === 0 ? undefined : colors[paletteIndex(colors, color)];
});
addMethod(PALETTE, 'Index', fn([COLOR], [INT]), (receiver, [color]) =>
  BigInt(paletteIndex(sliceValues(receiver), color))
);

/** The index of the palette color closest to `color` in Euclidean RGBA space, as `Palette.Index` finds it. */
export function paletteIndex(colors: Value[], color: Value): number {
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

// Package -----------------------------------------------------------------------------------------------------------

export const TRANSPARENT = new GoStruct([0n]);
export const OPAQUE = new GoStruct([0xff_ffn]);

const modelVariable = (name: string, model: Iface): Entity => libraryVariable(name, MODEL, () => model);
const uint8s = (count: number): Type[] => Array.from({ length: count }, () => UINT8);

const colorMembers: Record<string, Entity> = {
  Color: typeEntity(COLOR),
  Model: typeEntity(MODEL),
  Palette: typeEntity(PALETTE),
  ...Object.fromEntries(
    [RGBA, RGBA64, NRGBA, NRGBA64, ALPHA, ALPHA16, GRAY, GRAY16, CMYK, YCBCR, NYCBCRA].map((type) => [
      type.name,
      typeEntity(type),
    ])
  ),
  ModelFunc: nativeFunction('ModelFunc', fn([CONVERT_SIGNATURE], [MODEL]), ([convert]) => modelFunc(convert)),
  White: libraryVariable('White', GRAY16, () => new GoStruct([0xff_ffn])),
  Black: libraryVariable('Black', GRAY16, () => new GoStruct([0n])),
  Transparent: libraryVariable('Transparent', ALPHA16, () => copyValue(TRANSPARENT)),
  Opaque: libraryVariable('Opaque', ALPHA16, () => copyValue(OPAQUE)),
  RGBAModel: modelVariable('RGBAModel', RGBA_MODEL),
  RGBA64Model: modelVariable('RGBA64Model', RGBA64_MODEL),
  NRGBAModel: modelVariable('NRGBAModel', NRGBA_MODEL),
  NRGBA64Model: modelVariable('NRGBA64Model', NRGBA64_MODEL),
  AlphaModel: modelVariable('AlphaModel', ALPHA_MODEL),
  Alpha16Model: modelVariable('Alpha16Model', ALPHA16_MODEL),
  GrayModel: modelVariable('GrayModel', GRAY_MODEL),
  Gray16Model: modelVariable('Gray16Model', GRAY16_MODEL),
  CMYKModel: modelVariable('CMYKModel', CMYK_MODEL),
  YCbCrModel: modelVariable('YCbCrModel', YCBCR_MODEL),
  NYCbCrAModel: modelVariable('NYCbCrAModel', NYCBCRA_MODEL),
  RGBToYCbCr: nativeFunction('RGBToYCbCr', fn(uint8s(3), uint8s(3)), (rgb) =>
    rgbToYCbCr(...(rgb as [bigint, bigint, bigint]))
  ),
  YCbCrToRGB: nativeFunction('YCbCrToRGB', fn(uint8s(3), uint8s(3)), ([y, cb, cr]) =>
    yCbCrChannels(y as bigint, cb as bigint, cr as bigint, 16n).map(u8)
  ),
  RGBToCMYK: nativeFunction('RGBToCMYK', fn(uint8s(3), uint8s(4)), (rgb) =>
    rgbToCMYK(...(rgb as [bigint, bigint, bigint]))
  ),
  CMYKToRGB: nativeFunction('CMYKToRGB', fn(uint8s(4), uint8s(3)), (cmyk) =>
    cmykToRGB(...(cmyk as [bigint, bigint, bigint, bigint]))
  ),
};

export const COLOR_PACKAGE = definePackage('image/color', colorMembers);
