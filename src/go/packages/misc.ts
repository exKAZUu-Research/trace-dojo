import type { Entity } from '../entities';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { divideByZeroPanic } from '../runtimeErrors';
import { BASIC, type NamedType } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import { INT, STRING } from './support';

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

const UINT8 = BASIC.uint8;
const UINT32 = BASIC.uint32;

const COLOR = namedType('color', 'Color', {
  kind: 'interface',
  methods: [{ name: 'RGBA', type: fn([], [UINT32, UINT32, UINT32, UINT32]) }],
});
const MODEL = namedType('color', 'Model', {
  kind: 'interface',
  methods: [{ name: 'Convert', type: fn([COLOR], [COLOR]) }],
});

function colorStruct(name: string, fields: string[]): NamedType {
  return namedType('color', name, {
    kind: 'struct',
    fields: fields.map((field) => ({ name: field, type: UINT8, embedded: false })),
  });
}

const RGBA = colorStruct('RGBA', ['R', 'G', 'B', 'A']);
addMethod(RGBA, 'RGBA', fn([], [UINT32, UINT32, UINT32, UINT32]), (receiver) => {
  const [r, g, b, a] = (receiver as GoStruct).fields as bigint[];
  return [r | (r << 8n), g | (g << 8n), b | (b << 8n), a | (a << 8n)];
});
const GRAY = colorStruct('Gray', ['Y']);
addMethod(GRAY, 'RGBA', fn([], [UINT32, UINT32, UINT32, UINT32]), (receiver) => {
  const [y] = (receiver as GoStruct).fields as bigint[];
  const value = y | (y << 8n);
  return [value, value, value, 0xff_ffn];
});

const GRAY16 = namedType('color', 'Gray16', {
  kind: 'struct',
  fields: [{ name: 'Y', type: BASIC.uint16, embedded: false }],
});
addMethod(GRAY16, 'RGBA', fn([], [UINT32, UINT32, UINT32, UINT32]), (receiver) => {
  const [y] = (receiver as GoStruct).fields as bigint[];
  return [y, y, y, 0xff_ffn];
});
const WHITE = new GoStruct([0xff_ffn]);
const BLACK = new GoStruct([0n]);

/** `color.RGBAModel`, which converts any color to RGBA as Go's rgbaModel does. */
const RGBA_MODEL_TYPE = namedType('color', 'modelFunc', { kind: 'struct', fields: [] });
addMethod(RGBA_MODEL_TYPE, 'Convert', fn([COLOR], [COLOR]), (_receiver, [color]) => toRGBA(color), true);
const RGBA_MODEL = new Iface(
  { kind: 'pointer', element: RGBA_MODEL_TYPE },
  new Pointer(new Cell(new GoStruct([])), 'v')
);

function toRGBA(color: Value): Value {
  if (color instanceof Iface && color.type === RGBA) return color;
  const [r, g, b, a] = callRGBA(color);
  return new Iface(RGBA, new GoStruct([r >> 8n, g >> 8n, b >> 8n, a >> 8n]));
}

function callRGBA(color: Value): bigint[] {
  const iface = color as Iface;
  const method =
    iface.type.kind === 'named' ? iface.type.methods.find((candidate) => candidate.name === 'RGBA') : undefined;
  return method?.code?.call?.(iface.value, []) as bigint[];
}

const colorMembers: Record<string, Entity> = {
  Color: typeEntity(COLOR),
  Model: typeEntity(MODEL),
  RGBA: typeEntity(RGBA),
  Gray: typeEntity(GRAY),
  Gray16: typeEntity(GRAY16),
  White: {
    kind: 'var',
    name: 'White',
    type: GRAY16,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => WHITE,
  },
  Black: {
    kind: 'var',
    name: 'Black',
    type: GRAY16,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => BLACK,
  },
  RGBAModel: {
    kind: 'var',
    name: 'RGBAModel',
    type: MODEL,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => RGBA_MODEL,
  },
};

export const COLOR_PACKAGE = definePackage('image/color', colorMembers, [
  'NRGBA',
  'NRGBA64',
  'RGBA64',
  'Alpha',
  'Alpha16',
  'CMYK',
  'YCbCr',
  'NYCbCrA',
  'Palette',
  'ModelFunc',
  'Transparent',
  'Opaque',
  'GrayModel',
  'NRGBAModel',
  'RGBA64Model',
]);

const POINT = namedType('image', 'Point', {
  kind: 'struct',
  fields: [
    { name: 'X', type: INT, embedded: false },
    { name: 'Y', type: INT, embedded: false },
  ],
});
addMethod(POINT, 'String', fn([], [STRING]), (receiver) => {
  const [x, y] = (receiver as GoStruct).fields;
  return `(${String(x)},${String(y)})`;
});
const RECTANGLE = namedType('image', 'Rectangle', {
  kind: 'struct',
  fields: [
    { name: 'Min', type: POINT, embedded: false },
    { name: 'Max', type: POINT, embedded: false },
  ],
});
const corner = (rectangle: Value, index: number): bigint[] =>
  ((rectangle as GoStruct).fields[index] as GoStruct).fields as bigint[];
addMethod(RECTANGLE, 'String', fn([], [STRING]), (receiver) => {
  const [x0, y0] = corner(receiver, 0);
  const [x1, y1] = corner(receiver, 1);
  return `(${x0},${y0})-(${x1},${y1})`;
});
addMethod(POINT, 'Add', fn([POINT], [POINT]), (receiver, [other]) => {
  const [x, y] = (receiver as GoStruct).fields as bigint[];
  const [dx, dy] = (other as GoStruct).fields as bigint[];
  return new GoStruct([x + dx, y + dy]);
});
addMethod(POINT, 'Sub', fn([POINT], [POINT]), (receiver, [other]) => {
  const [x, y] = (receiver as GoStruct).fields as bigint[];
  const [dx, dy] = (other as GoStruct).fields as bigint[];
  return new GoStruct([x - dx, y - dy]);
});
addMethod(POINT, 'Mul', fn([INT], [POINT]), (receiver, [k]) => {
  const [x, y] = (receiver as GoStruct).fields as bigint[];
  return new GoStruct([x * (k as bigint), y * (k as bigint)]);
});
addMethod(POINT, 'Div', fn([INT], [POINT]), (receiver, [k]) => {
  const [x, y] = (receiver as GoStruct).fields as bigint[];
  const divisor = k as bigint;
  if (divisor === 0n) divideByZeroPanic();
  return new GoStruct([x / divisor, y / divisor]);
});
addMethod(POINT, 'Eq', fn([POINT], [BASIC.bool]), (receiver, [other]) => {
  const [x, y] = (receiver as GoStruct).fields as bigint[];
  const [ox, oy] = (other as GoStruct).fields as bigint[];
  return x === ox && y === oy;
});
addMethod(RECTANGLE, 'Dx', fn([], [INT]), (receiver) => corner(receiver, 1)[0] - corner(receiver, 0)[0]);
addMethod(RECTANGLE, 'Size', fn([], [POINT]), (receiver) => {
  const [x0, y0] = corner(receiver, 0);
  const [x1, y1] = corner(receiver, 1);
  return new GoStruct([x1 - x0, y1 - y0]);
});
addMethod(RECTANGLE, 'Empty', fn([], [BASIC.bool]), (receiver) => {
  const [x0, y0] = corner(receiver, 0);
  const [x1, y1] = corner(receiver, 1);
  return x0 >= x1 || y0 >= y1;
});
addMethod(RECTANGLE, 'Dy', fn([], [INT]), (receiver) => corner(receiver, 1)[1] - corner(receiver, 0)[1]);

addMethod(POINT, 'In', fn([RECTANGLE], [BASIC.bool]), (receiver, [bounds]) => {
  const [x, y] = (receiver as GoStruct).fields as bigint[];
  const [x0, y0] = corner(bounds, 0);
  const [x1, y1] = corner(bounds, 1);
  return x0 <= x && x < x1 && y0 <= y && y < y1;
});

function rectangle(x0: bigint, y0: bigint, x1: bigint, y1: bigint): GoStruct {
  const [minX, maxX] = x0 > x1 ? [x1, x0] : [x0, x1];
  const [minY, maxY] = y0 > y1 ? [y1, y0] : [y0, y1];
  return new GoStruct([new GoStruct([minX, minY]), new GoStruct([maxX, maxY])]);
}

const IMAGE = namedType('image', 'Image', {
  kind: 'interface',
  methods: [
    { name: 'At', type: fn([INT, INT], [COLOR]) },
    { name: 'Bounds', type: fn([], [RECTANGLE]) },
    { name: 'ColorModel', type: fn([], [MODEL]) },
  ],
});

/** `*image.RGBA`, whose pixels this keeps as RGBA values by position. */
const IMAGE_RGBA = namedType('image', 'RGBA', { kind: 'struct', fields: [] });
interface PixelState {
  bounds: GoStruct;
  pixels: Map<string, Value>;
}
const pixelsOf = (receiver: Value): PixelState =>
  ((receiver as Pointer).load() as GoStruct).native?.image as PixelState;
function inside(state: PixelState, x: bigint, y: bigint): boolean {
  const [x0, y0] = corner(state.bounds, 0);
  const [x1, y1] = corner(state.bounds, 1);
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}
addMethod(IMAGE_RGBA, 'Bounds', fn([], [RECTANGLE]), (receiver) => pixelsOf(receiver).bounds, true);
addMethod(IMAGE_RGBA, 'ColorModel', fn([], [MODEL]), () => RGBA_MODEL, true);
addMethod(
  IMAGE_RGBA,
  'At',
  fn([INT, INT], [COLOR]),
  (receiver, [x, y]) => {
    const state = pixelsOf(receiver);
    if (!inside(state, x as bigint, y as bigint)) return new Iface(RGBA, new GoStruct([0n, 0n, 0n, 0n]));
    return state.pixels.get(`${x},${y}`) ?? new Iface(RGBA, new GoStruct([0n, 0n, 0n, 0n]));
  },
  true
);
addMethod(
  IMAGE_RGBA,
  'Set',
  fn([INT, INT, COLOR], []),
  (receiver, [x, y, color]) => {
    const state = pixelsOf(receiver);
    if (inside(state, x as bigint, y as bigint)) state.pixels.set(`${x},${y}`, toRGBA(color));
    return;
  },
  true
);

const imageMembers: Record<string, Entity> = {
  Image: typeEntity(IMAGE),
  Point: typeEntity(POINT),
  Rectangle: typeEntity(RECTANGLE),
  RGBA: typeEntity(IMAGE_RGBA),
  Rect: nativeFunction('Rect', fn([INT, INT, INT, INT], [RECTANGLE]), ([x0, y0, x1, y1]) =>
    rectangle(x0 as bigint, y0 as bigint, x1 as bigint, y1 as bigint)
  ),
  Pt: nativeFunction('Pt', fn([INT, INT], [POINT]), ([x, y]) => new GoStruct([x, y])),
  NewRGBA: nativeFunction('NewRGBA', fn([RECTANGLE], [{ kind: 'pointer', element: IMAGE_RGBA }]), ([bounds]) => {
    currentRuntime().spend();
    return new Pointer(
      new Cell(new GoStruct([], { image: { bounds: bounds as GoStruct, pixels: new Map() } satisfies PixelState })),
      'v'
    );
  }),
};

export const IMAGE_PACKAGE = definePackage('image', imageMembers, [
  'NewGray',
  'NewNRGBA',
  'NewPaletted',
  'NewUniform',
  'Uniform',
  'Decode',
  'DecodeConfig',
  'RegisterFormat',
  'ZP',
  'ZR',
  'Transparent',
  'Opaque',
]);
