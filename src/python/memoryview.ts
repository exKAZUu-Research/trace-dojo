import { hexOf } from './bytesCase';
import { bytesLikeData, memoryviewClass, newBytes, PyBytes, PyMemoryView } from './bytesValues';
import { addressOf } from './conversions';
import { method } from './define';
import { pyHash } from './hashing';
import { sliceIndices } from './items';
import { withState } from './iteratorStates';
import { argument, checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import { bindValue, callValue, lookupSpecial, nativeIterator } from './objects';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import { NATIVE_CODES, readFloat, readInteger, writeFloat, writeInteger } from './structCodes';
import {
  bytearrayClass,
  bytesClass,
  iteratorClass,
  nativeFunction,
  None,
  NotImplemented,
  propertyClass,
  pyError,
  sliceClass,
  typeError,
  typeName,
  unbox,
  valueError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import { DONE, PyDescriptor, PyList, type PyObject, PySlice, PyTuple, type PyValue } from './values';

memoryviewClass.construct = (_cls, args, kwargs) => {
  checkArgs({ qualified: 'memoryview', min: 1, max: 1, style: 'takes', keywords: ['object'] }, args, kwargs);
  return viewOf(argument(args, kwargs, 0, 'object') as PyValue);
};

/** A memoryview of a bytes-like object, which for a memoryview views the same memory. */
export function viewOf(value: PyValue, prefix = 'memoryview: '): PyMemoryView {
  if (value instanceof PyMemoryView) {
    value.checkReleased();
    return copyView(value, value.readonly);
  }
  const payload = unbox(value);
  if (!(payload instanceof PyBytes)) {
    // A Python class implements the buffer protocol with `__buffer__` (PEP 688).
    const buffer = typeof value === 'object' && !value.cls.isBuiltin ? lookupSpecial(value, '__buffer__') : undefined;
    if (buffer === undefined) throw typeError(`${prefix}a bytes-like object is required, not '${typeName(value)}'`);
    const view = callValue(bindValue(buffer, value), [0n]);
    if (!(view instanceof PyMemoryView)) {
      throw typeError(`__buffer__ returned non-memoryview object '${typeName(view)}'`);
    }
    view.checkReleased();
    return copyView(view, view.readonly);
  }
  const view = new PyMemoryView(payload, 0, payload.length, 1, 'B', 1, !payload.isMutable);
  if (payload !== value) view.exporter = value;
  return view;
}

const asView = (self: PyValue): PyMemoryView => {
  const view = self as PyMemoryView;
  view.checkReleased();
  return view;
};

/** The struct code of a view's format; an array of 'u' or 'w' exports format 'w', which struct does not know. */
function nativeCode(view: PyMemoryView): (typeof NATIVE_CODES)[string] {
  const info = NATIVE_CODES[view.format] as (typeof NATIVE_CODES)[string] | undefined;
  if (!info) throw pyError('NotImplementedError', `memoryview: format ${view.format} not supported`);
  return info;
}

// Items -------------------------------------------------------------------------------------------------------------

function readItem(view: PyMemoryView, index: number): PyValue {
  const bytes = view.itemBytes(index);
  const info = nativeCode(view);
  switch (info.kind) {
    case 'char': {
      return newBytes(new Uint8Array(bytes));
    }
    case 'bool': {
      return bytes[0] !== 0;
    }
    case 'float': {
      return readFloat(new Uint8Array(bytes), true);
    }
    default: {
      return readInteger(bytes, true, info.kind === 'signed');
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 25 -- Checks each kind of item as memoryview's pack_single does.
function writeItem(view: PyMemoryView, index: number, value: PyValue): void {
  const info = nativeCode(view);
  const out = view.source.data;
  const offset = view.itemOffset(index);
  const invalid = (kind: 'type' | 'value'): Error =>
    (kind === 'type' ? typeError : valueError)(`memoryview: invalid ${kind} for format '${view.format}'`);
  if (info.kind === 'char') {
    const data = bytesLikeData(value);
    if (!(value instanceof PyBytes) || data?.length !== 1) throw invalid(value instanceof PyBytes ? 'value' : 'type');
    out[offset] = data[0];
  } else if (info.kind === 'bool') {
    out[offset] = currentRuntime().truthy(value) ? 1 : 0;
  } else if (info.kind === 'float') {
    if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'boolean') throw invalid('type');
    writeFloat(Number(value), info.size, true, out, offset);
  } else {
    if (typeof value !== 'bigint' && typeof value !== 'boolean') throw invalid('type');
    const integer = BigInt(value);
    const bits = BigInt(info.size * 8);
    const [low, high] =
      info.kind === 'signed' ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n] : [0n, (1n << bits) - 1n];
    if (integer < low || integer > high) throw invalid('value');
    writeInteger(integer, info.size, true, out, offset);
  }
}

function itemIndex(view: PyMemoryView, key: PyValue): number {
  const index = toIndex(key, () => 'memoryview: invalid slice key');
  const resolved = index < 0n ? index + BigInt(view.count) : index;
  if (resolved < 0n || resolved >= BigInt(view.count))
    throw pyError('IndexError', 'index out of bounds on dimension 1');
  return Number(resolved);
}

function sliceView(view: PyMemoryView, slice: PySlice): PyMemoryView {
  if (view.shape) return sliceRows(view, slice);
  const { start, step, count } = sliceIndices(slice, view.count);
  const sliced = new PyMemoryView(
    view.source,
    view.offset + start * view.stride,
    count,
    view.stride * step,
    view.format,
    view.itemsize,
    view.readonly
  );
  sliced.exporter = view.exporter;
  return sliced;
}

/** A slice of the rows of a multi-dimensional view, whose rows a step other than 1 sets apart. */
function sliceRows(view: PyMemoryView, slice: PySlice): PyMemoryView {
  const [rows, ...rest] = view.shape as number[];
  const { start, step, count } = sliceIndices(slice, rows);
  const rowStride = rowStrideOf(view);
  const sliced = new PyMemoryView(
    view.source,
    view.offset + start * rowStride,
    count * rest.reduce((product, each) => product * each, 1),
    view.itemsize,
    view.format,
    view.itemsize,
    view.readonly
  );
  sliced.shape = [count, ...rest];
  sliced.exporter = view.exporter;
  if (rowStride * step !== naturalRowStride(sliced)) sliced.rowStride = rowStride * step;
  return sliced;
}

/** The distance in bytes between the rows of a multi-dimensional view. */
function rowStrideOf(view: PyMemoryView): number {
  return view.rowStride ?? naturalRowStride(view);
}

/** The distance between the rows of a multi-dimensional view whose rows follow one another. */
function naturalRowStride(view: PyMemoryView): number {
  return (view.shape as number[]).slice(1).reduce((product, size) => product * size, view.itemsize);
}

/** Whether a view's items follow one another in C order, as cast() and the contiguity attributes require. */
export function isCContiguous(view: PyMemoryView): boolean {
  if (view.count === 1) return true;
  if (view.stride !== view.itemsize) return false;
  return view.rowStride === undefined || (view.shape as number[])[0] <= 1;
}

/** Another view of the same items, with the same shape and layout. */
function copyView(view: PyMemoryView, readonly: boolean): PyMemoryView {
  const copy = new PyMemoryView(
    view.source,
    view.offset,
    view.count,
    view.stride,
    view.format,
    view.itemsize,
    readonly
  );
  copy.shape = view.shape;
  copy.rowStride = view.rowStride;
  copy.exporter = view.exporter;
  return copy;
}

method(memoryviewClass, '__getitem__', 'one', 1, 1, (self, [key]) => {
  const view = asView(self);
  if (key instanceof PySlice) return sliceView(view, key);
  if (key instanceof PyTuple) {
    if (!view.shape) throw typeError('memoryview: invalid slice key');
    return readItem(view, tupleIndex(view, key));
  }
  if (view.shape) throw subViewsNotImplemented();
  return readItem(view, itemIndex(view, key));
});

method(memoryviewClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  const view = asView(self);
  if (view.readonly) throw typeError('cannot modify read-only memory');
  if (key instanceof PyTuple && view.shape) {
    writeItem(view, tupleIndex(view, key), value);
    return None;
  }
  if (view.shape) {
    if (key instanceof PySlice) {
      throw pyError('NotImplementedError', 'memoryview slice assignments are currently restricted to ndim = 1');
    }
    throw subViewsNotImplemented();
  }
  if (!(key instanceof PySlice)) {
    writeItem(view, itemIndex(view, key), value);
    return None;
  }
  const target = sliceView(view, key);
  try {
    const source = viewOf(value, '');
    let bytes: Uint8Array;
    try {
      bytes = source.toBytes();
      if (source.count !== target.count || source.format !== target.format) {
        throw valueError('memoryview assignment: lvalue and rvalue have different structures');
      }
    } finally {
      source.release();
    }
    for (let index = 0; index < target.count; index++) {
      target.source.data.set(
        bytes.subarray(index * target.itemsize, (index + 1) * target.itemsize),
        target.offset + index * target.stride
      );
    }
    return None;
  } finally {
    target.release();
  }
});

method(memoryviewClass, '__delitem__', 'one', 1, 1, (self) => {
  asView(self);
  throw typeError('cannot delete memory');
});

method(memoryviewClass, '__len__', 'none', 0, 0, (self) => BigInt(dimensionsOf(asView(self))[0]));

method(memoryviewClass, '__iter__', 'none', 0, 0, (self) => {
  const view = asView(self);
  if (view.shape) throw subViewsNotImplemented();
  let index = 0;
  let exhausted = false;
  const next = withState(
    () => {
      if (!exhausted && index < view.count) return readItem(view, index++);
      exhausted = true;
      return DONE;
    },
    { holds: () => (exhausted ? [] : [view]) }
  );
  return nativeIterator(iteratorClass('memory_iterator'), next, () => [view]);
});

method(memoryviewClass, 'tolist', 'none', 0, 0, (self) => {
  const view = asView(self);
  return nestedItems(view, dimensionsOf(view), 0);
});

method(
  memoryviewClass,
  'tobytes',
  'takes',
  0,
  1,
  (self, args, kwargs) => {
    const view = asView(self);
    const order = argument(args, kwargs, 0, 'order') ?? None;
    if (order !== None && order !== 'C' && order !== 'F' && order !== 'A') {
      throw valueError("order must be 'C', 'F' or 'A'");
    }
    return newBytes(order === 'F' && view.shape ? fortranBytes(view, view.shape) : view.toBytes());
  },
  { keywords: ['order'] }
);

/** The bytes of a multi-dimensional view in Fortran order, where the first index varies fastest. */
function fortranBytes(view: PyMemoryView, shape: number[]): Uint8Array {
  const bytes = view.toBytes();
  const result = new Uint8Array(bytes.length);
  const { itemsize } = view;
  for (let flat = 0; flat < view.count; flat++) {
    let rest = flat;
    let target = 0;
    let scale = 1;
    // The C-order indices of the item, from the last dimension, give its position in Fortran order.
    const indices = shape.toReversed().map((size) => {
      const index = rest % size;
      rest = Math.floor(rest / size);
      return index;
    });
    for (const [axis, index] of indices.toReversed().entries()) {
      target += index * scale;
      scale *= shape[axis];
    }
    result.set(bytes.subarray(flat * itemsize, (flat + 1) * itemsize), target * itemsize);
  }
  return result;
}

method(
  memoryviewClass,
  'hex',
  'takes',
  0,
  2,
  (self, args, kwargs) =>
    hexOf(asView(self).toBytes(), argument(args, kwargs, 0, 'sep'), argument(args, kwargs, 1, 'bytes_per_sep')),
  { keywords: ['sep', 'bytes_per_sep'] }
);

method(memoryviewClass, 'count', 'one', 1, 1, (self, [value]) => {
  const view = asView(self);
  let count = 0n;
  for (let index = 0; index < view.count; index++) if (equals(readItem(view, index), value)) count++;
  return count;
});

method(memoryviewClass, 'index', 'expected', 1, 3, (self, [value, start, stop]) => {
  const view = asView(self);
  const { start: from, stop: to } = sliceIndices(
    new PySlice(sliceClass, start ?? None, stop ?? None, None),
    view.count
  );
  for (let index = from; index < to; index++) if (equals(readItem(view, index), value)) return BigInt(index);
  throw valueError('memoryview.index(x): x not found');
});

// Casting and lifetime ----------------------------------------------------------------------------------------------

method(
  memoryviewClass,
  'cast',
  'takes',
  1,
  2,
  // code-gauge-allow functionCognitiveComplexity 17 -- One check per argument of memoryview.cast, in CPython's order.
  (self, args, kwargs) => {
    const view = asView(self);
    const formatValue = argument(args, kwargs, 0, 'format');
    const format = formatValue === undefined ? undefined : unbox(formatValue);
    if (typeof format !== 'string')
      throw typeError(`cast() argument 'format' must be str, not ${typeName(format as PyValue)}`);
    const char = format.startsWith('@') ? format.slice(1) : format;
    const info = NATIVE_CODES[char];
    if (char.length !== 1 || !info || 'xsp'.includes(char)) {
      throw valueError(
        "memoryview: destination format must be a native single character format prefixed with an optional '@'"
      );
    }
    if (!isByteFormat(view.format) && !isByteFormat(char)) {
      throw typeError('memoryview: cannot cast between two non-byte formats');
    }
    if (!isCContiguous(view)) throw typeError('memoryview: casts are restricted to C-contiguous views');
    if (view.nbytes % info.size !== 0) throw typeError('memoryview: length is not a multiple of itemsize');
    const count = view.nbytes / info.size;
    const shape = argument(args, kwargs, 1, 'shape');
    if (view.count === 0) throw typeError('memoryview: cannot cast view with zeros in shape or strides');
    const dimensions = shape === undefined ? undefined : shapeOf(shape);
    if (view.shape && dimensions !== undefined && dimensions.length !== 1) {
      throw typeError('memoryview: cast must be 1D -> ND or ND -> 1D');
    }
    if (dimensions && dimensions.reduce((product, size) => product * size, 1) * info.size !== view.nbytes) {
      throw typeError('memoryview: product(shape) * itemsize != buffer size');
    }
    const cast = new PyMemoryView(view.source, view.offset, count, info.size, char, info.size, view.readonly);
    cast.exporter = view.exporter;
    if (dimensions && dimensions.length > 1) cast.shape = dimensions;
    return cast;
  },
  { keywords: ['format', 'shape'] }
);

function isByteFormat(format: string): boolean {
  return 'Bbc'.includes(format);
}

/** The dimensions cast() is given, which must be positive integers. */
function shapeOf(shape: PyValue): number[] {
  if (!(shape instanceof PyTuple) && !(shape instanceof PyList)) throw typeError('shape must be a list or a tuple');
  if (shape.items.length > 64) throw valueError('memoryview: number of dimensions must not exceed 64');
  return shape.items.map((item) => {
    if (typeof item !== 'bigint' || item <= 0n) {
      throw valueError('memoryview.cast(): elements of shape must be integers > 0');
    }
    return Number(item);
  });
}

/** The dimensions of a view: its shape, or its length for a one-dimensional one. */
function dimensionsOf(view: PyMemoryView): number[] {
  return view.shape ?? [view.count];
}

/** The strides of a view in bytes, row-major for one cast() gave several dimensions. */
function stridesOf(view: PyMemoryView): number[] {
  if (!view.shape) return [view.stride];
  const strides: number[] = [];
  let stride = view.itemsize;
  for (const size of view.shape.toReversed()) {
    strides.unshift(stride);
    stride *= size;
  }
  strides[0] = rowStrideOf(view);
  return strides;
}

/** The flat index of the item a tuple of indices names in a multi-dimensional view. */
function tupleIndex(view: PyMemoryView, key: PyTuple): number {
  const dimensions = dimensionsOf(view);
  if (key.items.length !== dimensions.length) {
    if (key.items.some((item) => item instanceof PySlice))
      throw new UnsupportedFeatureError('多次元の memoryview のスライス');
    throw typeError(`cannot index ${dimensions.length}-dimension view with ${key.items.length}-element tuple`);
  }
  let flat = 0;
  for (const [axis, item] of key.items.entries()) {
    const index = toIndex(item, () => 'memoryview: invalid slice key');
    const size = BigInt(dimensions[axis]);
    const resolved = index < 0n ? index + size : index;
    if (resolved < 0n || resolved >= size) throw pyError('IndexError', `index out of bounds on dimension ${axis + 1}`);
    flat = flat * dimensions[axis] + Number(resolved);
  }
  return flat;
}

function subViewsNotImplemented(): Error {
  return pyError('NotImplementedError', 'multi-dimensional sub-views are not implemented');
}

/** The items of a view as nested lists, one level per dimension. */
function nestedItems(view: PyMemoryView, dimensions: number[], start: number): PyValue {
  const [size, ...rest] = dimensions;
  const runtime = currentRuntime();
  if (rest.length === 0)
    return runtime.listOf(Array.from({ length: size }, (_, index) => readItem(view, start + index)));
  const step = rest.reduce((product, each) => product * each, 1);
  return runtime.listOf(Array.from({ length: size }, (_, index) => nestedItems(view, rest, start + index * step)));
}

method(memoryviewClass, 'release', 'none', 0, 0, (self) => {
  (self as PyMemoryView).release();
  return None;
});
method(memoryviewClass, '__enter__', 'none', 0, 0, (self) => asView(self));
method(memoryviewClass, '__exit__', 'expected', 0, Number.POSITIVE_INFINITY, (self) => {
  (self as PyMemoryView).release();
  return None;
});
method(memoryviewClass, 'toreadonly', 'none', 0, 0, (self) => {
  return copyView(asView(self), true);
});

// Comparison, hashing, and repr -------------------------------------------------------------------------------------

method(memoryviewClass, '__eq__', 'one', 1, 1, (self, [other]) => viewsEqual(self as PyMemoryView, other));
method(memoryviewClass, '__ne__', 'one', 1, 1, (self, [other]) => {
  const equal = viewsEqual(self as PyMemoryView, other);
  return equal === NotImplemented ? equal : !equal;
});

function viewsEqual(view: PyMemoryView, other: PyValue): PyValue {
  if (view === other) return true;
  const exporter =
    typeof other === 'object' && !other.cls.isBuiltin && lookupSpecial(other, '__buffer__') !== undefined;
  if (!(other instanceof PyMemoryView) && !(other instanceof PyBytes) && !exporter) return NotImplemented;
  if (view.released || (other instanceof PyMemoryView && other.released)) return false;
  const otherView = viewOf(other);
  if (!(view.format in NATIVE_CODES) || !(otherView.format in NATIVE_CODES)) {
    otherView.release();
    return NotImplemented;
  }
  try {
    if (dimensionsOf(otherView).join(',') !== dimensionsOf(view).join(',')) return false;
    for (let index = 0; index < view.count; index++) {
      if (!equals(readItem(view, index), readItem(otherView, index))) return false;
    }
    return true;
  } finally {
    otherView.release();
  }
}

method(memoryviewClass, '__hash__', 'none', 0, 0, (self) => {
  const view = asView(self);
  if (!view.readonly) throw valueError('cannot hash writable memoryview object');
  if (!isByteFormat(view.format)) throw valueError("memoryview: hashing is restricted to formats 'B', 'b' or 'c'");
  return pyHash(newBytes(view.toBytes()));
});

method(memoryviewClass, '__repr__', 'none', 0, 0, (self) => {
  const view = self as PyMemoryView;
  return `<${view.released ? 'released ' : ''}memory at ${addressOf(view as PyObject)}>`;
});

// Attributes --------------------------------------------------------------------------------------------------------

/** The data attributes of a memoryview, as read-only properties. */
const ATTRIBUTES: Record<string, (view: PyMemoryView) => PyValue> = {
  obj: (view) => view.exporter ?? view.source,
  nbytes: (view) => BigInt(view.nbytes),
  readonly: (view) => view.readonly,
  itemsize: (view) => BigInt(view.itemsize),
  format: (view) => view.format,
  ndim: (view) => BigInt(dimensionsOf(view).length),
  shape: (view) => currentRuntime().tuple(dimensionsOf(view).map(BigInt)),
  strides: (view) => currentRuntime().tuple(stridesOf(view).map(BigInt)),
  suboffsets: () => currentRuntime().tuple([]),
  c_contiguous: (view) => isCContiguous(view),
  f_contiguous: (view) => view.stride === view.itemsize && !view.shape,
  contiguous: (view) => isCContiguous(view),
};

for (const [name, read] of Object.entries(ATTRIBUTES)) {
  memoryviewClass.dict.set(
    name,
    new PyDescriptor(
      propertyClass,
      nativeFunction(name, ([self]) => read(asView(self)))
    )
  );
}

// The buffer protocol (PEP 688), which `collections.abc.Buffer` checks for.
for (const cls of [bytesClass, bytearrayClass, memoryviewClass]) {
  method(cls, '__buffer__', 'one', 1, 1, (self, [flags]) => {
    toIndex(flags);
    return viewOf(self);
  });
}
