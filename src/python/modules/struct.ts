import { bytesLikeData, latin1Text, newBytes, PyBytes, PyMemoryView } from '../bytesValues';
import { addressOf, pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { withState } from '../iteratorStates';
import { isCContiguous, viewOf } from '../memoryview';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { bindValue, callValue, isTruthy, lookupSpecial, nativeIterator } from '../objects';
import { currentRuntime } from '../runtimeContext';
import {
  type CodeInfo,
  NATIVE_CODES,
  readFloat,
  readInteger,
  STANDARD_CODES,
  writeFloat,
  writeInteger,
} from '../structCodes';
import {
  builtinClass,
  exceptionClassNamed,
  iteratorClass,
  nativeFunction,
  newException,
  None,
  propertyClass,
  typeError,
  typeName,
  unbox,
} from '../types';
import { DONE, PyDescriptor, PyError, type PyIterator, PyOpaque, type PyValue } from '../values';
import { builtinClassWithBase } from './moduleClasses';

const structErrorClass = builtinClassWithBase('error', exceptionClassNamed('Exception'), 'struct');

function structError(message: string): PyError {
  return new PyError(newException(structErrorClass, [message]));
}

// Formats -----------------------------------------------------------------------------------------------------------

interface Item {
  code: string;
  info: CodeInfo;
  /** For `s` and `p`, the byte length; otherwise how many values the item repeats. */
  count: number;
  offset: number;
}

interface Layout {
  format: string;
  items: Item[];
  size: number;
  little: boolean;
  /** The number of values that packing takes. */
  arity: number;
}

const BYTE_ORDERS: Record<string, { little: boolean; native: boolean }> = {
  '@': { little: true, native: true },
  '=': { little: true, native: false },
  '<': { little: true, native: false },
  '>': { little: false, native: false },
  '!': { little: false, native: false },
};

/** Parses a struct format as CPython's prepare_s does, laying its items out with their offsets. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows prepare_s, including native alignment.
// code-gauge-allow functionNcss 31 -- Follows prepare_s with each item budgeted before allocation.
function parseFormat(format: string): Layout {
  const order = BYTE_ORDERS[format[0]] ?? BYTE_ORDERS['@'];
  const codes = order.native ? NATIVE_CODES : STANDARD_CODES;
  const items: Item[] = [];
  let index = format[0] in BYTE_ORDERS ? 1 : 0;
  let size = 0;
  let arity = 0;
  while (index < format.length) {
    if (/\s/.test(format[index])) {
      index++;
      continue;
    }
    const digits = /^\d+/.exec(format.slice(index))?.[0] ?? '';
    index += digits.length;
    if (index >= format.length) throw structError('repeat count given without format specifier');
    const code = format[index++];
    const info = Object.hasOwn(codes, code) ? codes[code] : undefined;
    if (!info) throw structError('bad char in struct format');
    const count = digits === '' ? 1 : Number(digits);
    if (order.native) size = Math.ceil(size / info.size) * info.size;
    currentRuntime().allocate(5);
    items.push({ code, info, count, offset: size });
    size += info.kind === 'string' || info.kind === 'pascal' ? count : count * info.size;
    if (info.kind === 'string' || info.kind === 'pascal') arity++;
    else if (info.kind !== 'pad') arity += count;
  }
  return { format, items, size, little: order.little, arity };
}

/**
 * The layouts of the short formats used last, shared by every run, so that runs cannot grow it: CPython also caches
 * 100. A longer format's layout is the run's own, charged as it is built.
 */
const layouts = new Map<string, Layout>();
const MAX_CACHED_LAYOUTS = 100;
const MAX_CACHED_FORMAT_LENGTH = 256;

function layoutOf(formatValue: PyValue): Layout {
  const format = unbox(formatValue);
  let text: string;
  if (typeof format === 'string') text = format;
  else if (format instanceof PyBytes) text = latin1Text(format.data);
  else throw typeError(`Struct() argument 1 must be a str or bytes object, not ${typeName(format)}`);
  const cached = layouts.get(text);
  if (cached) return cached;
  const layout = parseFormat(text);
  if (text.length > MAX_CACHED_FORMAT_LENGTH) return layout;
  if (layouts.size >= MAX_CACHED_LAYOUTS) layouts.delete(layouts.keys().next().value as string);
  layouts.set(text, layout);
  return layout;
}

// Packing -----------------------------------------------------------------------------------------------------------

function pack(layout: Layout, values: readonly PyValue[], out: Uint8Array, offset: number): void {
  if (values.length !== layout.arity) {
    throw structError(`pack expected ${layout.arity} items for packing (got ${values.length})`);
  }
  let next = 0;
  for (const item of layout.items) {
    const { kind, size } = item.info;
    if (kind === 'pad') continue;
    if (kind === 'string' || kind === 'pascal') {
      packString(item, values[next++], out, offset + item.offset);
      continue;
    }
    for (let repeat = 0; repeat < item.count; repeat++) {
      packValue(item, values[next++], layout.little, out, offset + item.offset + repeat * size);
    }
  }
}

function packString(item: Item, value: PyValue, out: Uint8Array, at: number): void {
  if (!(value instanceof PyBytes)) throw structError(`argument for '${item.code}' must be a bytes object`);
  const data = value.data;
  if (item.code === 's') {
    out.set(data.subarray(0, item.count), at);
    return;
  }
  if (item.count === 0) return;
  const length = Math.min(data.length, item.count - 1);
  out[at] = Math.min(length, 255);
  out.set(data.subarray(0, length), at + 1);
}

function packValue(item: Item, value: PyValue, little: boolean, out: Uint8Array, at: number): void {
  const { kind, size } = item.info;
  if (kind === 'bool') {
    out[at] = isTruthy(value) ? 1 : 0;
  } else if (kind === 'char') {
    if (!(value instanceof PyBytes) || value.isMutable || value.length !== 1) {
      throw structError('char format requires a bytes object of length 1');
    }
    out[at] = value.data[0];
  } else if (kind === 'float') {
    writeFloat(floatArgument(value), size, little, out, at);
  } else {
    writeInteger(integerArgument(item, value), size, little, out, at);
  }
}

function floatArgument(value: PyValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'boolean') return Number(value);
  for (const name of ['__float__', '__index__']) {
    const special = lookupSpecial(value, name);
    if (special !== undefined) return Number(callValue(bindValue(special, value), []) as number | bigint);
  }
  throw structError('required argument is not a float');
}

function integerArgument(item: Item, value: PyValue): bigint {
  if (typeof value !== 'bigint' && typeof value !== 'boolean' && lookupSpecial(value, '__index__') === undefined) {
    throw structError('required argument is not an integer');
  }
  const integer = toIndex(value);
  const bits = BigInt(item.info.size * 8);
  if (item.code === 'P') {
    if (integer < -(1n << (bits - 1n)) || integer >= 1n << bits) throw structError('int too large to convert');
    return integer;
  }
  const [low, high] =
    item.info.kind === 'signed' ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n] : [0n, (1n << bits) - 1n];
  if (integer < low || integer > high) {
    throw structError(`'${item.code}' format requires ${low} <= number <= ${high}`);
  }
  return integer;
}

// Unpacking ---------------------------------------------------------------------------------------------------------

function unpack(layout: Layout, data: Uint8Array, offset: number): PyValue {
  const values: PyValue[] = [];
  for (const item of layout.items) {
    const at = offset + item.offset;
    const { kind, size } = item.info;
    if (kind === 'pad') continue;
    if (kind === 'string') values.push(newBytes(data.slice(at, at + item.count)));
    else if (kind === 'pascal') {
      const length = item.count === 0 ? 0 : Math.min(data[at], item.count - 1);
      values.push(newBytes(data.slice(at + 1, at + 1 + length)));
    } else {
      for (let repeat = 0; repeat < item.count; repeat++) {
        values.push(unpackValue(kind, data.subarray(at + repeat * size, at + (repeat + 1) * size), layout.little));
      }
    }
  }
  return currentRuntime().tuple(values);
}

function unpackValue(kind: CodeInfo['kind'], bytes: Uint8Array, little: boolean): PyValue {
  if (kind === 'bool') return bytes[0] !== 0;
  if (kind === 'char') return newBytes(new Uint8Array(bytes));
  if (kind === 'float') return readFloat(new Uint8Array(bytes), little);
  return readInteger(bytes, little, kind === 'signed');
}

function bufferData(value: PyValue): Uint8Array {
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
  return data;
}

function unpackWhole(layout: Layout, buffer: PyValue): PyValue {
  const data = bufferData(buffer);
  if (data.length !== layout.size) throw structError(`unpack requires a buffer of ${layout.size} bytes`);
  return unpack(layout, data, 0);
}

function unpackFrom(layout: Layout, buffer: PyValue | undefined, offsetValue: PyValue | undefined): PyValue {
  if (buffer === undefined) throw typeError("unpack_from() missing required argument 'buffer' (pos 2)");
  const data = bufferData(buffer);
  let offset = Number(toIndex(offsetValue ?? 0n));
  if (offset < 0) {
    if (offset + data.length < 0) throw structError(`offset ${offset} out of range for ${data.length}-byte buffer`);
    offset += data.length;
  }
  if (data.length - offset < layout.size) {
    throw structError(
      `unpack_from requires a buffer of at least ${layout.size + offset} bytes for unpacking ${layout.size} bytes at offset ${offset} (actual buffer size is ${data.length})`
    );
  }
  return unpack(layout, data, offset);
}

function packInto(
  layout: Layout,
  buffer: PyValue | undefined,
  offsetValue: PyValue | undefined,
  values: PyValue[]
): PyValue {
  if (buffer === undefined) throw structError('pack_into expected buffer argument');
  if (offsetValue === undefined) throw structError('pack_into expected offset argument');
  const target = writableBuffer(buffer);
  const length = target.length;
  let offset = Number(toIndex(offsetValue));
  if (offset < 0) {
    if (offset + layout.size > 0) throw structError(`no space to pack ${layout.size} bytes at offset ${offset}`);
    if (offset + length < 0) throw structError(`offset ${offset} out of range for ${length}-byte buffer`);
    offset += length;
  }
  if (length - offset < layout.size) {
    throw structError(
      `pack_into requires a buffer of at least ${layout.size + offset} bytes for packing ${layout.size} bytes at offset ${offset} (actual buffer size is ${length})`
    );
  }
  const packed = new Uint8Array(layout.size);
  pack(layout, values, packed, 0);
  target.data.set(packed, target.start + offset);
  return None;
}

/** The memory a writable buffer such as a bytearray, a memoryview, or an array exposes, from `start` on. */
function writableBuffer(buffer: PyValue): { data: Uint8Array; start: number; length: number } {
  if (buffer instanceof PyBytes && buffer.isMutable) return { data: buffer.data, start: 0, length: buffer.length };
  const exporter =
    buffer instanceof PyMemoryView ||
    (typeof buffer === 'object' && !buffer.cls.isBuiltin && lookupSpecial(buffer, '__buffer__') !== undefined);
  const view = exporter ? viewOf(buffer) : undefined;
  if (!view || view.readonly || view.stride !== view.itemsize || view.rowStride !== undefined) {
    throw typeError(`argument must be read-write bytes-like object, not ${typeName(buffer)}`);
  }
  view.checkReleased();
  return { data: view.source.data, start: view.offset, length: view.nbytes };
}

function packBytes(layout: Layout, values: PyValue[]): PyValue {
  if (values.length !== layout.arity) {
    throw structError(`pack expected ${layout.arity} items for packing (got ${values.length})`);
  }
  currentRuntime().buildString(layout.size);
  const out = new Uint8Array(layout.size);
  pack(layout, values, out, 0);
  return newBytes(out);
}

const unpackIteratorClass = iteratorClass('_struct.unpack_iterator');
method(
  unpackIteratorClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<_struct.unpack_iterator object at ${addressOf(self as PyIterator)}>`
);

function iterUnpack(layout: Layout, buffer: PyValue): PyValue {
  const view = unpackView(layout, buffer);
  let offset = 0;
  let exhausted = false;
  const next = withState(
    () => {
      if (exhausted) return DONE;
      if (offset >= view.nbytes) {
        exhausted = true;
        view.exports.delete(iterator);
        if (view !== buffer) view.release();
        return DONE;
      }
      const data = view.source.data.subarray(view.offset, view.offset + view.nbytes);
      offset += layout.size;
      return unpack(layout, data, offset - layout.size);
    },
    { holds: () => (exhausted ? [] : [view]) }
  );
  const iterator = nativeIterator(unpackIteratorClass, next, () => [view]);
  view.exports.add(iterator);
  remaining.set(iterator, () => (view.nbytes - offset) / layout.size);
  return iterator;
}

function unpackView(layout: Layout, buffer: PyValue): PyMemoryView {
  const view = buffer instanceof PyMemoryView ? buffer : viewOf(buffer, '');
  view.checkReleased();
  if (!isCContiguous(view)) {
    if (view !== buffer) view.release();
    throw new PyError(
      newException(exceptionClassNamed('BufferError'), ['memoryview: underlying buffer is not C-contiguous'])
    );
  }
  if (layout.size === 0 || view.nbytes % layout.size !== 0) {
    if (view !== buffer) view.release();
    throw structError(
      layout.size === 0
        ? 'cannot iteratively unpack with a struct of length 0'
        : `iterative unpacking requires a buffer of a multiple of ${layout.size} bytes`
    );
  }
  return view;
}

const remaining = new WeakMap<PyIterator, () => number>();
method(unpackIteratorClass, '__length_hint__', 'none', 0, 0, (self) =>
  BigInt(remaining.get(self as PyIterator)?.() ?? 0)
);

// The Struct class --------------------------------------------------------------------------------------------------

const structClass = builtinClass('Struct');
structClass.typeName = '_struct.Struct';
structClass.module = '_struct';
const layoutOfStruct = (self: PyValue): Layout => (self as PyOpaque).data as Layout;

structClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'Struct', min: 0, max: 1, style: 'takes', keywords: ['format'] }, args, kwargs);
  const format = argument(args, kwargs, 0, 'format');
  if (format === undefined) throw typeError("Struct() missing required argument 'format' (pos 1)");
  const layout = layoutOf(format);
  return new PyOpaque(cls, layout.format, layout);
};
method(structClass, 'pack', 'expected', 0, Number.POSITIVE_INFINITY, (self, args) =>
  packBytes(layoutOfStruct(self), args)
);
method(structClass, 'unpack', 'one', 1, 1, (self, [buffer]) => unpackWhole(layoutOfStruct(self), buffer));
method(
  structClass,
  'unpack_from',
  'takes',
  1,
  2,
  (self, args, kwargs) =>
    unpackFrom(layoutOfStruct(self), argument(args, kwargs, 0, 'buffer'), argument(args, kwargs, 1, 'offset')),
  { keywords: ['buffer', 'offset'] }
);
method(structClass, 'pack_into', 'expected', 0, Number.POSITIVE_INFINITY, (self, [buffer, offset, ...values]) =>
  packInto(layoutOfStruct(self), buffer, offset, values)
);
method(structClass, 'iter_unpack', 'one', 1, 1, (self, [buffer]) => iterUnpack(layoutOfStruct(self), buffer));
method(structClass, '__repr__', 'none', 0, 0, (self) => `Struct(${pyRepr(layoutOfStruct(self).format)})`);
for (const [name, read] of [
  ['format', (layout: Layout): PyValue => layout.format],
  ['size', (layout: Layout): PyValue => BigInt(layout.size)],
] as const) {
  structClass.dict.set(
    name,
    new PyDescriptor(
      propertyClass,
      nativeFunction(name, ([self]) => read(layoutOfStruct(self)))
    )
  );
}

// The module --------------------------------------------------------------------------------------------------------

/** A function whose first argument is a format, followed by the values to pack. */
function withFormat(name: string, run: (layout: Layout, rest: PyValue[]) => PyValue): PyValue {
  return builtin(name, 'expected', 0, Number.POSITIVE_INFINITY, (args) => {
    if (args.length === 0) throw typeError('missing format argument');
    return run(layoutOf(args[0]), args.slice(1));
  });
}

registerModule(
  'struct',
  () =>
    new Map<string, PyValue>([
      ['error', structErrorClass],
      ['Struct', structClass],
      [
        'calcsize',
        builtin('calcsize', 'one', 0, Number.POSITIVE_INFINITY, (args) => {
          if (args.length !== 1)
            throw typeError(`_struct.calcsize() takes exactly one argument (${args.length} given)`);
          return BigInt(layoutOf(args[0]).size);
        }),
      ],
      ['pack', withFormat('pack', (layout, values) => packBytes(layout, values))],
      ['unpack', builtin('unpack', 'expected', 2, 2, ([format, buffer]) => unpackWhole(layoutOf(format), buffer))],
      [
        'unpack_from',
        builtin(
          'unpack_from',
          'takes',
          1,
          3,
          (args, kwargs) =>
            unpackFrom(layoutOf(args[0]), argument(args, kwargs, 1, 'buffer'), argument(args, kwargs, 2, 'offset')),
          { keywords: ['buffer', 'offset'] }
        ),
      ],
      [
        'pack_into',
        withFormat('pack_into', (layout, [buffer, offset, ...values]) => packInto(layout, buffer, offset, values)),
      ],
      [
        'iter_unpack',
        builtin('iter_unpack', 'expected', 2, 2, ([format, buffer]) => iterUnpack(layoutOf(format), buffer)),
      ],
    ])
);
