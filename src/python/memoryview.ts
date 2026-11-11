import { hexOf } from './bytesCase';
import { bytesLikeData, memoryviewClass, newBytes, PyBytes, PyMemoryView } from './bytesValues';
import { addressOf } from './conversions';
import { method } from './define';
import { pyHash } from './hashing';
import { sliceIndices } from './items';
import { argument, checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import { NATIVE_CODES, readFloat, readInteger, writeFloat, writeInteger } from './structCodes';
import {
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
import { DONE, PyDescriptor, PyIterator, type PyObject, PySlice, PyTuple, type PyValue } from './values';

memoryviewClass.construct = (_cls, args, kwargs) => {
  checkArgs({ qualified: 'memoryview', min: 1, max: 1, style: 'takes', keywords: ['object'] }, args, kwargs);
  return viewOf(argument(args, kwargs, 0, 'object') as PyValue);
};

/** A memoryview of a bytes-like object, which for a memoryview views the same memory. */
export function viewOf(value: PyValue): PyMemoryView {
  if (value instanceof PyMemoryView) {
    value.checkReleased();
    return new PyMemoryView(
      value.source,
      value.offset,
      value.count,
      value.stride,
      value.format,
      value.itemsize,
      value.readonly
    );
  }
  if (!(value instanceof PyBytes)) {
    throw typeError(`memoryview: a bytes-like object is required, not '${typeName(value)}'`);
  }
  return new PyMemoryView(value, 0, value.length, 1, 'B', 1, !value.isMutable);
}

const asView = (self: PyValue): PyMemoryView => {
  const view = self as PyMemoryView;
  view.checkReleased();
  return view;
};

// Items -------------------------------------------------------------------------------------------------------------

function readItem(view: PyMemoryView, index: number): PyValue {
  const bytes = view.itemBytes(index);
  const info = NATIVE_CODES[view.format];
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
  const info = NATIVE_CODES[view.format];
  const out = view.source.data;
  const offset = view.offset + index * view.stride;
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
  const { start, step, count } = sliceIndices(slice, view.count);
  return new PyMemoryView(
    view.source,
    view.offset + start * view.stride,
    count,
    view.stride * step,
    view.format,
    view.itemsize,
    view.readonly
  );
}

method(memoryviewClass, '__getitem__', 'one', 1, 1, (self, [key]) => {
  const view = asView(self);
  if (key instanceof PySlice) return sliceView(view, key);
  if (key instanceof PyTuple) throw typeError('memoryview: invalid slice key');
  return readItem(view, itemIndex(view, key));
});

method(memoryviewClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  const view = asView(self);
  if (view.readonly) throw typeError('cannot modify read-only memory');
  if (!(key instanceof PySlice)) {
    writeItem(view, itemIndex(view, key), value);
    return None;
  }
  const target = sliceView(view, key);
  const source = value instanceof PyMemoryView || value instanceof PyBytes ? viewOf(value) : undefined;
  if (!source) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
  const bytes = source.toBytes();
  source.release();
  if (source.count !== target.count || source.format !== target.format) {
    target.release();
    throw valueError('memoryview assignment: lvalue and rvalue have different structures');
  }
  for (let index = 0; index < target.count; index++) {
    target.source.data.set(
      bytes.subarray(index * target.itemsize, (index + 1) * target.itemsize),
      target.offset + index * target.stride
    );
  }
  target.release();
  return None;
});

method(memoryviewClass, '__delitem__', 'one', 1, 1, (self) => {
  asView(self);
  throw typeError('cannot delete memory');
});

method(memoryviewClass, '__len__', 'none', 0, 0, (self) => BigInt(asView(self).count));

method(memoryviewClass, '__iter__', 'none', 0, 0, (self) => {
  const view = asView(self);
  let index = 0;
  return new PyIterator(
    iteratorClass('memory_iterator'),
    () => (index < view.count ? readItem(view, index++) : DONE),
    () => [view]
  );
});

method(memoryviewClass, 'tolist', 'none', 0, 0, (self) => {
  const view = asView(self);
  return currentRuntime().listOf(Array.from({ length: view.count }, (_, index) => readItem(view, index)));
});

method(memoryviewClass, 'tobytes', 'takes', 0, 1, (self) => newBytes(asView(self).toBytes()), { keywords: ['order'] });

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
    if (view.stride !== view.itemsize) throw typeError('memoryview: casts are restricted to C-contiguous views');
    if (view.nbytes % info.size !== 0) throw typeError('memoryview: length is not a multiple of itemsize');
    const count = view.nbytes / info.size;
    const shape = argument(args, kwargs, 1, 'shape');
    if (shape !== undefined) checkShape(shape, count, info.size, view.nbytes);
    return new PyMemoryView(view.source, view.offset, count, info.size, char, info.size, view.readonly);
  },
  { keywords: ['format', 'shape'] }
);

function isByteFormat(format: string): boolean {
  return 'Bbc'.includes(format);
}

function checkShape(shape: PyValue, count: number, itemsize: number, nbytes: number): void {
  const items = currentRuntime().toArray(shape);
  if (items.length !== 1) throw currentRuntime().unsupported('多次元の memoryview');
  if (Number(toIndex(items[0])) * itemsize !== nbytes) {
    throw typeError('memoryview: product(shape) * itemsize != buffer size');
  }
  void count;
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
  const view = asView(self);
  return new PyMemoryView(view.source, view.offset, view.count, view.stride, view.format, view.itemsize, true);
});

// Comparison, hashing, and repr -------------------------------------------------------------------------------------

method(memoryviewClass, '__eq__', 'one', 1, 1, (self, [other]) => viewsEqual(self as PyMemoryView, other));
method(memoryviewClass, '__ne__', 'one', 1, 1, (self, [other]) => {
  const equal = viewsEqual(self as PyMemoryView, other);
  return equal === NotImplemented ? equal : !equal;
});

function viewsEqual(view: PyMemoryView, other: PyValue): PyValue {
  if (view === other) return true;
  if (!(other instanceof PyMemoryView) && !(other instanceof PyBytes)) return NotImplemented;
  if (view.released || (other instanceof PyMemoryView && other.released)) return false;
  const otherView = viewOf(other);
  try {
    if (otherView.count !== view.count) return false;
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
  obj: (view) => view.source,
  nbytes: (view) => BigInt(view.nbytes),
  readonly: (view) => view.readonly,
  itemsize: (view) => BigInt(view.itemsize),
  format: (view) => view.format,
  ndim: () => 1n,
  shape: (view) => currentRuntime().tuple([BigInt(view.count)]),
  strides: (view) => currentRuntime().tuple([BigInt(view.stride)]),
  suboffsets: () => currentRuntime().tuple([]),
  c_contiguous: (view) => view.stride === view.itemsize,
  f_contiguous: (view) => view.stride === view.itemsize,
  contiguous: (view) => view.stride === view.itemsize,
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
