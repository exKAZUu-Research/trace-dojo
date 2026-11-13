import { type PyBytes, PyMemoryView } from '../bytesValues';
import { orderClassNamespace } from '../classOrders';
import { builtin, method } from '../define';
import { clamp, reduction, stateIndex, stateOf, withState } from '../iteratorStates';
import { toIndex } from '../numbers';
import { callValue } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import { strLength } from '../strings';
import { iteratorClass, newTuple, None, objectClass, pyError, typeError, typeName } from '../types';
import { DONE, type PyClass, PyIterator, type PyValue } from '../values';
import { realArgument } from './math';

// `array.array`, which CPython writes in C, written in Python over a bytearray holding its items in the machine's native
// layout, little-endian with 8-byte longs, which memoryviews of the array share. Its items are converted natively as
// CPython stores them in C types, with the same range errors, and packed and read with `struct`.
const SOURCE = String.raw`
import struct as _struct
from operator import index as _index

typecodes = 'bBuwhHiIlLqQfd'

_ITEMSIZE = {'b': 1, 'B': 1, 'u': 4, 'w': 4, 'h': 2, 'H': 2, 'i': 4, 'I': 4,
             'l': 8, 'L': 8, 'q': 8, 'Q': 8, 'f': 4, 'd': 8}


def _subscript(index):
    if not hasattr(type(index), '__index__'):
        raise TypeError('array indices must be integers')
    return _index(index)


def _code(typecode):
    return 'I' if typecode in 'uw' else typecode


def _encode(typecode, items):
    if typecode in 'uw':
        return _struct.pack(f'{len(items)}I', *[ord(item) for item in items])
    return _struct.pack(f'{len(items)}{typecode}', *items)


def _decode(typecode, data):
    count = len(data) // _ITEMSIZE[typecode]
    items = _struct.unpack(f'{count}{_code(typecode)}', data)
    if typecode in 'uw':
        return [chr(code) for code in items]
    return list(items)


def _new(typecode, items):
    result = array(typecode)
    result._data = bytearray(_encode(typecode, items))
    return result


class array:
    def __init__(self, *args, **kwargs):
        if kwargs:
            raise TypeError('array.array() takes no keyword arguments')
        if not args:
            raise TypeError('array() takes at least 1 argument (0 given)')
        if len(args) > 2:
            raise TypeError(f'array() takes at most 2 arguments ({len(args)} given)')
        typecode = args[0]
        if not isinstance(typecode, str) or len(typecode) != 1:
            _character_error('array() argument 1', typecode)
        if typecode not in typecodes:
            raise ValueError('bad typecode (must be b, B, u, w, h, H, i, I, l, L, q, Q, f or d)')
        self._typecode = typecode
        # The items in the C layout CPython stores them in, which memoryviews of the array share.
        self._data = bytearray()
        if len(args) == 2:
            initializer = args[1]
            if isinstance(initializer, str):
                if typecode not in 'uw':
                    raise TypeError(f"cannot use a str to initialize an array with typecode '{typecode}'")
                self._data = bytearray(_encode(typecode, list(initializer)))
            elif isinstance(initializer, (bytes, bytearray)):
                self.frombytes(initializer)
            elif isinstance(initializer, array) and initializer._typecode in 'uw' and typecode not in 'uw':
                raise TypeError(f"cannot use a unicode array to initialize an array with typecode '{typecode}'")
            else:
                self._data = bytearray(_encode(typecode, [_convert(typecode, item) for item in initializer]))

    def _items(self):
        return _decode(self._typecode, self._data)

    def _store(self, items):
        data = _encode(self._typecode, items)
        if len(data) != len(self._data):
            self._check_resize()
        self._data[:] = data

    def _check_resize(self):
        if _exported(self._data):
            raise BufferError('cannot resize an array that is exporting buffers')

    def _count(self):
        return len(self._data) // _ITEMSIZE[self._typecode]

    def _item(self, offset):
        value = _struct.unpack_from(_code(self._typecode), self._data, offset)[0]
        return chr(value) if self._typecode in 'uw' else value

    def _delete(self, offset):
        self._check_resize()
        del self._data[offset:offset + _ITEMSIZE[self._typecode]]

    def _position(self, index, message):
        count = self._count()
        if index < 0:
            index += count
        if not 0 <= index < count:
            raise IndexError(message)
        return index * _ITEMSIZE[self._typecode]

    @property
    def typecode(self):
        return self._typecode

    @property
    def itemsize(self):
        return _ITEMSIZE[self._typecode]

    def __repr__(self):
        items = self._items()
        if not items:
            return f"{type(self).__name__}('{self._typecode}')"
        if self._typecode in 'uw':
            return f"{type(self).__name__}('{self._typecode}', {''.join(items)!r})"
        return f"{type(self).__name__}('{self._typecode}', {items!r})"

    def __len__(self):
        return len(self._data) // _ITEMSIZE[self._typecode]

    def __iter__(self):
        return _iter_array(self)

    def __contains__(self, value):
        return value in self._items()

    def __getitem__(self, index):
        if isinstance(index, slice):
            return _new(self._typecode, self._items()[index])
        return self._item(self._position(_subscript(index), 'array index out of range'))

    def __setitem__(self, index, value):
        if isinstance(index, slice):
            if not isinstance(value, array):
                raise TypeError(f'can only assign array (not "{type(value).__name__}") to array slice')
            if value._typecode != self._typecode:
                raise TypeError('bad argument type for built-in operation')
            items = self._items()
            items[index] = value._items()
            self._store(items)
            return
        converted = _convert(self._typecode, value)
        offset = self._position(_subscript(index), 'array assignment index out of range')
        if self._typecode in 'uw':
            converted = ord(converted)
        _struct.pack_into(_code(self._typecode), self._data, offset, converted)

    def __delitem__(self, index):
        if isinstance(index, slice):
            items = self._items()
            del items[index]
            self._store(items)
            return
        self._delete(self._position(_subscript(index), 'array assignment index out of range'))

    def _same_kind(self, other, message):
        if not isinstance(other, array):
            raise TypeError(message % type(other).__name__)
        if other._typecode != self._typecode:
            raise TypeError('bad argument type for built-in operation')

    def __add__(self, other):
        self._same_kind(other, 'can only append array (not "%s") to array')
        return _new(self._typecode, self._items() + other._items())

    def __iadd__(self, other):
        self._same_kind(other, 'can only extend array with array (not "%s")')
        self._store(self._items() + other._items())
        return self

    def __mul__(self, count):
        return _new(self._typecode, self._items() * count)

    def __rmul__(self, count):
        return _new(self._typecode, self._items() * count)

    def __imul__(self, count):
        self._store(self._items() * count)
        return self

    def __eq__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items() == other._items()

    def __ne__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items() != other._items()

    def __lt__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items() < other._items()

    def __le__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items() <= other._items()

    def __gt__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items() > other._items()

    def __ge__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items() >= other._items()

    def __copy__(self):
        return _new(self._typecode, self._items())

    def __deepcopy__(self, memo):
        return _new(self._typecode, self._items())

    def append(self, value, /):
        converted = _convert(self._typecode, value)
        self._check_resize()
        self._data += _encode(self._typecode, [converted])

    def extend(self, iterable, /):
        if isinstance(iterable, array):
            if iterable._typecode != self._typecode:
                raise TypeError('can only extend with array of same kind')
            self._store(self._items() + iterable._items())
            return
        for item in iterable:
            self.append(item)

    def insert(self, index, value, /):
        index = _index(index)
        converted = _convert(self._typecode, value)
        count = self._count()
        index = min(max(index + count, 0) if index < 0 else index, count)
        self._check_resize()
        offset = index * _ITEMSIZE[self._typecode]
        self._data[offset:offset] = _encode(self._typecode, [converted])

    def pop(self, index=-1, /):
        index = _index(index)
        if not self._data:
            raise IndexError('pop from empty array')
        offset = self._position(index, 'pop index out of range')
        value = self._item(offset)
        self._delete(offset)
        return value

    def remove(self, value, /):
        try:
            index = self._items().index(value)
        except ValueError:
            raise ValueError('array.remove(x): x not in array') from None
        self._delete(index * _ITEMSIZE[self._typecode])

    def index(self, value, start=0, stop=None, /):
        items = self._items()
        if stop is None:
            stop = len(items)
        try:
            return items.index(value, start, stop)
        except ValueError:
            raise ValueError('array.index(x): x not in array') from None

    def count(self, value, /):
        return self._items().count(value)

    def reverse(self):
        self._store(self._items()[::-1])

    def clear(self):
        self._store([])

    def tolist(self):
        return self._items()

    def fromlist(self, items, /):
        if not isinstance(items, list):
            raise TypeError('arg must be list')
        converted = [_convert(self._typecode, item) for item in items]
        self._store(self._items() + converted)

    def tounicode(self):
        if self._typecode not in 'uw':
            raise ValueError("tounicode() may only be called on unicode type arrays ('u' or 'w')")
        return ''.join(self._items())

    def fromunicode(self, text, /):
        if not isinstance(text, str):
            raise TypeError(f'fromunicode() argument must be str, not {type(text).__name__}')
        if self._typecode not in 'uw':
            raise ValueError("fromunicode() may only be called on unicode type arrays ('u' or 'w')")
        self._store(self._items() + list(text))

    def buffer_info(self):
        _unsupported('配列のメモリ上の位置（array.buffer_info）')

    def byteswap(self):
        size = _ITEMSIZE[self._typecode]
        if size == 1:
            return
        data = bytes(self._data)
        self._data[:] = b''.join(data[start:start + size][::-1] for start in range(0, len(data), size))

    def __buffer__(self, flags, /):
        return _view(self, self._data, self._typecode)

    def tobytes(self):
        return bytes(self._data)

    def frombytes(self, data, /):
        if isinstance(data, (array, memoryview)):
            data = bytes(data)
        elif not isinstance(data, (bytes, bytearray)):
            raise TypeError(f"a bytes-like object is required, not '{type(data).__name__}'")
        size = _ITEMSIZE[self._typecode]
        if len(data) % size:
            raise ValueError('bytes length not a multiple of item size')
        if data:
            self._check_resize()
        if self._typecode in 'uw':
            self._store(self._items() + _decode(self._typecode, data))
        else:
            self._data += data

    def tofile(self, f, /):
        data = self.tobytes()
        for start in range(0, len(data), 64 * 1024):
            f.write(data[start:start + 64 * 1024])

    def fromfile(self, f, n, /):
        n = _index(n)
        if n < 0:
            raise ValueError('negative count')
        size = _ITEMSIZE[self._typecode] * n
        data = f.read(size)
        if not isinstance(data, bytes):
            raise TypeError("read() didn't return bytes")
        self.frombytes(data)
        if len(data) != size:
            raise EOFError("read() didn't return enough bytes")


ArrayType = array
_c_type_name(array, 'array.array')
`;

/** The sizes of the items of each type code. */
const ITEMSIZES: Record<string, number> = {
  b: 1,
  B: 1,
  u: 4,
  w: 4,
  h: 2,
  H: 2,
  i: 4,
  I: 4,
  l: 8,
  L: 8,
  q: 8,
  Q: 8,
  f: 4,
  d: 8,
};

/** The ranges of the integer type codes, and the messages CPython's converters give outside them. */
const INTEGER_RANGES: Record<string, [bigint, bigint, string, string]> = {
  b: [-128n, 127n, 'signed char is less than minimum', 'signed char is greater than maximum'],
  B: [0n, 255n, 'unsigned byte integer is less than minimum', 'unsigned byte integer is greater than maximum'],
  h: [-32_768n, 32_767n, 'signed short integer is less than minimum', 'signed short integer is greater than maximum'],
  H: [0n, 65_535n, 'unsigned short is less than minimum', 'unsigned short is greater than maximum'],
  i: [-(2n ** 31n), 2n ** 31n - 1n, 'signed integer is less than minimum', 'signed integer is greater than maximum'],
};
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const UNSIGNED_LONG_MAX = 2n ** 64n - 1n;

function overflow(message: string): Error {
  return pyError('OverflowError', message);
}

/** An item converted as the array's C type stores it, raising what CPython raises for a value that does not fit. */
function convertItem(typecode: string, value: PyValue): PyValue {
  if (typecode === 'u' || typecode === 'w') return convertCharacter(value);
  if (typecode === 'f' || typecode === 'd') return convertReal(typecode, value);
  return convertInteger(typecode, toIndex(value));
}

function convertCharacter(value: PyValue): PyValue {
  if (typeof value !== 'string') throw typeError(`array item must be a unicode character, not ${typeName(value)}`);
  const length = strLength(value);
  if (length !== 1) throw typeError(`array item must be a unicode character, not a string of length ${length}`);
  return value;
}

function convertReal(typecode: string, value: PyValue): PyValue {
  const number = realArgument(value);
  return typecode === 'f' ? Math.fround(number) : number;
}

// code-gauge-allow functionCognitiveComplexity 26 -- One case per integer type code, with CPython's messages.
function convertInteger(typecode: string, integer: bigint): bigint {
  const range = INTEGER_RANGES[typecode];
  if (range) {
    if (integer < LONG_MIN || integer > LONG_MAX) throw overflow('Python int too large to convert to C long');
    if (integer < range[0]) throw overflow(range[2]);
    if (integer > range[1]) throw overflow(range[3]);
    return integer;
  }
  if (typecode === 'I' || typecode === 'L') {
    if (integer < 0n) throw overflow("can't convert negative value to unsigned int");
    if (integer > UNSIGNED_LONG_MAX) throw overflow('Python int too large to convert to C unsigned long');
    if (typecode === 'I' && integer > 2n ** 32n - 1n) throw overflow('unsigned int is greater than maximum');
    return integer;
  }
  if (typecode === 'l' || typecode === 'q') {
    const message = typecode === 'l' ? 'Python int too large to convert to C long' : 'int too big to convert';
    if (integer < LONG_MIN || integer > LONG_MAX) throw overflow(message);
    return integer;
  }
  if (integer < 0n) throw overflow("can't convert negative int to unsigned");
  if (integer > UNSIGNED_LONG_MAX) throw overflow('int too big to convert');
  return integer;
}

const arrayIteratorClass = iteratorClass('array.arrayiterator');
arrayIteratorClass.dict.set('__module__', 'array');
method(arrayIteratorClass, '__getattribute__', 'one', 1, 1, (self, args) =>
  callValue(objectClass.dict.get('__getattribute__') as PyValue, [self, ...args])
);
method(arrayIteratorClass, '__setstate__', 'one', 1, 1, (self, [value]) => {
  const index = stateIndex(value);
  if (index < LONG_MIN || index > LONG_MAX) throw overflow('Python int too large to convert to C ssize_t');
  stateOf((self as PyIterator).next)?.setState?.(index);
  return None;
});
orderClassNamespace(arrayIteratorClass);

function arrayIterator(owner: PyValue): PyIterator {
  const cls = currentRuntime().importModule('array').dict.get('array') as PyClass;
  const length = cls.dict.get('__len__') as PyValue;
  const item = cls.dict.get('__getitem__') as PyValue;
  let source: PyValue | undefined = owner;
  let index = 0;
  const count = (): number => (source === undefined ? 0 : Number(callValue(length, [source])));
  const next = withState(
    () => {
      if (source === undefined) return DONE;
      if (index < count()) return callValue(item, [source, BigInt(index++)]);
      const released = source;
      source = undefined;
      currentRuntime().finalizer.release([released]);
      return DONE;
    },
    {
      reduce: () =>
        source === undefined ? reduction('iter', [newTuple([])]) : reduction('iter', [source], BigInt(index)),
      setState: (position) => {
        if (source !== undefined) index = clamp(position, 0, count());
      },
    }
  );
  return new PyIterator(arrayIteratorClass, next, () => (source === undefined ? [] : [source]));
}

registerSourceModule(
  'array',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      ['_iter_array', builtin('_iter_array', 'one', 1, 1, ([owner]) => arrayIterator(owner))],
      [
        '_convert',
        builtin('_convert', 'expected', 2, 2, ([typecode, value]) => convertItem(typecode as string, value)),
      ],
      // A memoryview of the array's memory, typed as CPython's buffer of the array is, with the array as its `obj`.
      [
        '_view',
        builtin('_view', 'expected', 3, 3, ([owner, data, typecode]) => {
          const bytes = data as PyBytes;
          const size = ITEMSIZES[typecode as string];
          const format = typecode === 'u' ? 'w' : (typecode as string);
          const view = new PyMemoryView(bytes, 0, bytes.length / size, size, format, size, false);
          view.exporter = owner;
          return view;
        }),
      ],
      ['_exported', builtin('_exported', 'one', 1, 1, ([data]) => (data as PyBytes).hasExports())],
      [
        '_character_error',
        builtin('_character_error', 'expected', 2, 2, ([what, value]) => {
          const shown = typeof value === 'string' ? `a string of length ${strLength(value)}` : typeName(value);
          throw typeError(`${what as string} must be a unicode character, not ${shown}`);
        }),
      ],
    ])
);
