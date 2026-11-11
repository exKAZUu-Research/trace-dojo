import { builtin } from '../define';
import { toIndex } from '../numbers';
import { registerSourceModule } from '../sourceModules';
import { strLength } from '../strings';
import { intClass, isInstanceOf, pyError, typeError, typeName } from '../types';
import type { PyValue } from '../values';

// `array.array`, which CPython writes in C, written in Python over a list of converted items. Its items are converted
// natively as CPython stores them in C types, with the same range errors, and packed with `struct` in the machine's
// native layout, little-endian with 8-byte longs, for the methods that read or write bytes.
const SOURCE = String.raw`
import struct as _struct
from operator import index as _index

typecodes = 'bBuwhHiIlLqQfd'

_ITEMSIZE = {'b': 1, 'B': 1, 'u': 4, 'w': 4, 'h': 2, 'H': 2, 'i': 4, 'I': 4,
             'l': 8, 'L': 8, 'q': 8, 'Q': 8, 'f': 4, 'd': 8}


def _new(typecode, items):
    result = array(typecode)
    result._items = items
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
        self._items = []
        if len(args) == 2:
            initializer = args[1]
            if isinstance(initializer, str):
                if typecode not in 'uw':
                    raise TypeError(f"cannot use a str to initialize an array with typecode '{typecode}'")
                self._items = list(initializer)
            elif isinstance(initializer, (bytes, bytearray)):
                self.frombytes(initializer)
            elif isinstance(initializer, array) and initializer._typecode in 'uw' and typecode not in 'uw':
                raise TypeError(f"cannot use a unicode array to initialize an array with typecode '{typecode}'")
            else:
                self._items = [_convert(typecode, item) for item in initializer]

    @property
    def typecode(self):
        return self._typecode

    @property
    def itemsize(self):
        return _ITEMSIZE[self._typecode]

    def __repr__(self):
        if not self._items:
            return f"array('{self._typecode}')"
        if self._typecode in 'uw':
            return f"array('{self._typecode}', {''.join(self._items)!r})"
        return f"array('{self._typecode}', {self._items!r})"

    def __len__(self):
        return len(self._items)

    def __iter__(self):
        return iter(self._items)

    def __contains__(self, value):
        return value in self._items

    def __getitem__(self, index):
        if isinstance(index, slice):
            return _new(self._typecode, self._items[index])
        try:
            return self._items[index]
        except IndexError:
            raise IndexError('array index out of range') from None

    def __setitem__(self, index, value):
        if isinstance(index, slice):
            if not isinstance(value, array):
                raise TypeError(f'can only assign array (not "{type(value).__name__}") to array slice')
            if value._typecode != self._typecode:
                raise TypeError('bad argument type for built-in operation')
            self._items[index] = value._items
            return
        converted = _convert(self._typecode, value)
        try:
            self._items[index] = converted
        except IndexError:
            raise IndexError('array assignment index out of range') from None

    def __delitem__(self, index):
        try:
            del self._items[index]
        except IndexError:
            raise IndexError('array assignment index out of range') from None

    def _same_kind(self, other, message):
        if not isinstance(other, array):
            raise TypeError(message % type(other).__name__)
        if other._typecode != self._typecode:
            raise TypeError('bad argument type for built-in operation')

    def __add__(self, other):
        self._same_kind(other, 'can only append array (not "%s") to array')
        return _new(self._typecode, self._items + other._items)

    def __iadd__(self, other):
        self._same_kind(other, 'can only extend array with array (not "%s")')
        self._items += other._items
        return self

    def __mul__(self, count):
        return _new(self._typecode, self._items * count)

    def __rmul__(self, count):
        return _new(self._typecode, self._items * count)

    def __imul__(self, count):
        self._items *= count
        return self

    def __eq__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items == other._items

    def __ne__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items != other._items

    def __lt__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items < other._items

    def __le__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items <= other._items

    def __gt__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items > other._items

    def __ge__(self, other):
        if not isinstance(other, array):
            return NotImplemented
        return self._items >= other._items

    def __copy__(self):
        return _new(self._typecode, list(self._items))

    def __deepcopy__(self, memo):
        return _new(self._typecode, list(self._items))

    def append(self, value, /):
        self._items.append(_convert(self._typecode, value))

    def extend(self, iterable, /):
        if isinstance(iterable, array):
            if iterable._typecode != self._typecode:
                raise TypeError('can only extend with array of same kind')
            self._items.extend(iterable._items)
            return
        for item in iterable:
            self._items.append(_convert(self._typecode, item))

    def insert(self, index, value, /):
        self._items.insert(index, _convert(self._typecode, value))

    def pop(self, index=-1, /):
        if not self._items:
            raise IndexError('pop from empty array')
        try:
            return self._items.pop(index)
        except IndexError:
            raise IndexError('pop index out of range') from None

    def remove(self, value, /):
        try:
            self._items.remove(value)
        except ValueError:
            raise ValueError('array.remove(x): x not in array') from None

    def index(self, value, start=0, stop=None, /):
        if stop is None:
            stop = len(self._items)
        try:
            return self._items.index(value, start, stop)
        except ValueError:
            raise ValueError('array.index(x): x not in array') from None

    def count(self, value, /):
        return self._items.count(value)

    def reverse(self):
        self._items.reverse()

    def tolist(self):
        return list(self._items)

    def fromlist(self, items, /):
        if not isinstance(items, list):
            raise TypeError('arg must be list')
        self._items.extend([_convert(self._typecode, item) for item in items])

    def tounicode(self):
        if self._typecode not in 'uw':
            raise ValueError("tounicode() may only be called on unicode type arrays ('u' or 'w')")
        return ''.join(self._items)

    def fromunicode(self, text, /):
        if not isinstance(text, str):
            raise TypeError(f'fromunicode() argument must be str, not {type(text).__name__}')
        if self._typecode not in 'uw':
            raise ValueError("fromunicode() may only be called on unicode type arrays ('u' or 'w')")
        self._items.extend(text)

    def buffer_info(self):
        _unsupported('配列のメモリ上の位置（array.buffer_info）')

    def byteswap(self):
        size = _ITEMSIZE[self._typecode]
        if size == 1:
            return
        data = self.tobytes()
        swapped = b''.join(data[start:start + size][::-1] for start in range(0, len(data), size))
        self._items = []
        self.frombytes(swapped)

    def __buffer__(self, flags, /):
        return memoryview(self.tobytes())

    def tobytes(self):
        if self._typecode in 'uw':
            return _struct.pack(f'{len(self._items)}I', *[ord(item) for item in self._items])
        return _struct.pack(f'{len(self._items)}{self._typecode}', *self._items)

    def frombytes(self, data, /):
        if isinstance(data, array):
            data = data.tobytes()
        elif isinstance(data, memoryview):
            data = data.tobytes()
        elif not isinstance(data, (bytes, bytearray)):
            raise TypeError(f"a bytes-like object is required, not '{type(data).__name__}'")
        size = _ITEMSIZE[self._typecode]
        if len(data) % size:
            raise ValueError('bytes length not a multiple of item size')
        count = len(data) // size
        if self._typecode in 'uw':
            self._items.extend(chr(code) for code in _struct.unpack(f'{count}I', data))
        else:
            self._items.extend(_struct.unpack(f'{count}{self._typecode}', data))

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
  let number: number;
  if (typeof value === 'number') number = value;
  else if (isInstanceOf(value, intClass)) number = Number(toIndex(value));
  else throw typeError(`must be real number, not ${typeName(value)}`);
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

registerSourceModule(
  'array',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      [
        '_convert',
        builtin('_convert', 'expected', 2, 2, ([typecode, value]) => convertItem(typecode as string, value)),
      ],
      [
        '_character_error',
        builtin('_character_error', 'expected', 2, 2, ([what, value]) => {
          const shown = typeof value === 'string' ? `a string of length ${strLength(value)}` : typeName(value);
          throw typeError(`${what as string} must be a unicode character, not ${shown}`);
        }),
      ],
    ])
);
