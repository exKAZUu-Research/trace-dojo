import { formatBytesPercent } from './bytesFormat';
import {
  bytearrayClass,
  bytesClass,
  bytesLikeData,
  bytesRepr,
  latin1Text,
  newBytes,
  PyBytes,
  sameKind,
} from './bytesValues';
import { decodeBytes, encodeString } from './codecs';
import { method } from './define';
import { pyHash } from './hashing';
import { defineNew } from './instances';
import { sliceIndices } from './items';
import { argument, checkArgs } from './nativeArgs';
import { toIndex } from './numbers';
import { bindValue, callValue, isTruthy, iterate, iterateByIndex, iterateOr, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { readInteger, writeInteger } from './structCodes';
import {
  boolClass,
  defineMethod,
  intClass,
  iteratorClass,
  newTuple,
  None,
  NotImplemented,
  pyError,
  strClass,
  typeError,
  typeName,
  unbox,
  valueError,
} from './types';
import { DONE, type Kwargs, PyIterator, PyList, PySlice, PyTuple, type PyValue } from './values';

// Construction ------------------------------------------------------------------------------------------------------

bytesClass.construct = (_cls, args, kwargs) => newBytes(constructBytes('bytes', args, kwargs));
bytearrayClass.construct = (cls, args, kwargs) => new PyBytes(cls, constructBytes('bytearray', args, kwargs));

// A program's subclasses get bytes' value from `__new__`, and a bytearray's from `__init__`, as in CPython.
bytesClass.isBaseType = true;
bytearrayClass.isBaseType = true;
defineNew(bytesClass, (subtype, args, kwargs) => new PyBytes(subtype, constructBytes('bytes', args, kwargs)));
defineNew(bytearrayClass, (subtype) => new PyBytes(subtype, new Uint8Array(0)));
defineMethod(bytearrayClass, '__init__', (self, args, kwargs) => {
  const array = self as PyBytes;
  array.splice(0, array.length, constructBytes('bytearray', args, kwargs));
  return None;
});

/** The bytes `bytes(source, encoding, errors)` or `bytearray(...)` creates. */
function constructBytes(name: 'bytes' | 'bytearray', args: PyValue[], kwargs: Kwargs): Uint8Array {
  checkArgs(
    { qualified: name, min: 0, max: 3, style: 'takes', keywords: ['source', 'encoding', 'errors'] },
    args,
    kwargs
  );
  const source = argument(args, kwargs, 0, 'source');
  const [encoding, errors] = (['encoding', 'errors'] as const).map((key, index) => {
    const value = argument(args, kwargs, index + 1, key);
    if (value !== undefined && typeof unbox(value) !== 'string') {
      throw typeError(`${name}() argument '${key}' must be str, not ${typeName(value)}`);
    }
    return value === undefined ? undefined : (unbox(value) as string);
  });
  if (source === undefined) {
    if (encoding !== undefined || errors !== undefined) throw typeError('encoding or errors without sequence argument');
    return new Uint8Array(0);
  }
  if (encoding === undefined && errors === undefined) return bytesFromObject(name, source);
  const text = unbox(source);
  if (typeof text === 'string') {
    if (encoding === undefined) throw typeError(STRING_WITHOUT_ENCODING);
    return encodeString(text, encoding, errors ?? 'strict');
  }
  throw typeError(`${encoding === undefined ? 'errors' : 'encoding'} without a string argument`);
}

const STRING_WITHOUT_ENCODING = 'string argument without an encoding';

/**
 * The bytes `bytes(source)` or `bytearray(source)` creates, or with `from_bytes` the bytes that CPython's
 * `PyObject_Bytes` converts an argument of `int.from_bytes` into, which has no `bytes(n)` count form.
 */
function bytesFromObject(name: 'bytes' | 'bytearray' | 'from_bytes', source: PyValue): Uint8Array {
  const data = bytesLikeData(source);
  // `bytes()` asks `__bytes__` first, which even a subclass of str may define.
  const special = name === 'bytearray' ? undefined : bytesFromSpecial(source, data);
  if (special !== undefined) return special;
  const notConvertible = `cannot convert '${typeName(source)}' object to ${name === 'bytearray' ? name : 'bytes'}`;
  if (typeof unbox(source) === 'string') {
    throw typeError(name === 'from_bytes' ? notConvertible : STRING_WITHOUT_ENCODING);
  }
  if (data !== undefined) return new Uint8Array(data);
  if (
    name !== 'from_bytes' &&
    (typeof source === 'bigint' || typeof source === 'boolean' || lookupSpecial(source, '__index__') !== undefined)
  ) {
    const count = toIndex(source);
    if (count < 0n) throw valueError('negative count');
    currentRuntime().buildString(Number(count));
    return new Uint8Array(Number(count));
  }
  if (typeof source === 'number') throw typeError(notConvertible);
  return bytesFromIterable(
    source,
    name === 'bytearray' ? 'byte must be in range(0, 256)' : 'bytes must be in range(0, 256)',
    notConvertible
  );
}

/** The bytes an object's `__bytes__` gives, or undefined for an object without one. */
function bytesFromSpecial(source: PyValue, data: Uint8Array | undefined): Uint8Array | undefined {
  const special = lookupSpecial(source, '__bytes__');
  if (special === undefined) return undefined;
  if (data !== undefined && special === bytesClass.dict.get('__bytes__')) return new Uint8Array(data);
  const result = callValue(bindValue(special, source), []);
  if (!(result instanceof PyBytes) || result.isMutable) {
    throw typeError(`__bytes__ returned non-bytes (type ${typeName(result)})`);
  }
  return new Uint8Array(result.data);
}

/** The bytes of an iterable of ints, as `bytes(iterable)` collects them. */
export function bytesFromIterable(
  iterable: PyValue,
  rangeMessage = 'bytes must be in range(0, 256)',
  notIterable?: string
): Uint8Array {
  const next = notIterable === undefined ? iterate(iterable) : iterateOr(iterable, notIterable);
  const result: number[] = [];
  const runtime = currentRuntime();
  for (let item = next(); item !== DONE; item = next()) {
    runtime.spend();
    result.push(byteValue(item, rangeMessage));
  }
  runtime.buildString(result.length);
  return Uint8Array.from(result);
}

/** An int argument that must be a byte value. */
export function byteValue(value: PyValue, rangeMessage = 'byte must be in range(0, 256)'): number {
  const integer = toIndex(value);
  if (integer < 0n || integer > 255n) throw valueError(rangeMessage);
  return Number(integer);
}

// Protocol ----------------------------------------------------------------------------------------------------------

const asBytes = (self: PyValue): PyBytes => self as PyBytes;

const COMPARISONS: [string, (order: number) => boolean][] = [
  ['__eq__', (order) => order === 0],
  ['__ne__', (order) => order !== 0],
  ['__lt__', (order) => order < 0],
  ['__le__', (order) => order <= 0],
  ['__gt__', (order) => order > 0],
  ['__ge__', (order) => order >= 0],
];

for (const cls of [bytesClass, bytearrayClass]) {
  const name = cls.name;
  method(cls, '__repr__', 'none', 0, 0, (self) => bytesRepr(asBytes(self)));
  method(cls, '__str__', 'none', 0, 0, (self) => bytesRepr(asBytes(self)));
  method(cls, '__len__', 'none', 0, 0, (self) => BigInt(asBytes(self).length));
  method(cls, '__getitem__', 'one', 1, 1, (self, [key]) => bytesItem(asBytes(self), key));
  method(cls, '__iter__', 'none', 0, 0, (self) => bytesIterator(asBytes(self)));
  method(cls, '__contains__', 'one', 1, 1, (self, [item]) => bytesContains(asBytes(self).data, item));
  method(cls, '__add__', 'one', 1, 1, (self, [other]) => concatBytes(asBytes(self), other));
  method(cls, '__mul__', 'one', 1, 1, (self, [count]) => repeatBytes(asBytes(self), count));
  method(cls, '__rmul__', 'one', 1, 1, (self, [count]) =>
    // A sequence on the left names the bytes in its own error, as CPython tries its repeat first.
    typeof count === 'string' || count instanceof PyList || count instanceof PyTuple
      ? NotImplemented
      : repeatBytes(asBytes(self), count)
  );
  method(cls, '__mod__', 'one', 1, 1, (self, [value]) =>
    sameKind(asBytes(self), formatBytesPercent(asBytes(self).data, value))
  );
  method(cls, '__rmod__', 'one', 1, 1, () => NotImplemented);
  for (const [operator, test] of COMPARISONS) {
    method(cls, operator, 'one', 1, 1, (self, [other]) => {
      const otherData =
        name === 'bytes'
          ? other instanceof PyBytes && !other.isMutable
            ? other.data
            : undefined
          : bytesLikeData(other);
      if (otherData === undefined) return NotImplemented;
      return test(compareBytes(asBytes(self).data, otherData));
    });
  }
}
method(bytesClass, '__hash__', 'none', 0, 0, (self) => pyHash(latin1Text(asBytes(self).data)));
bytearrayClass.dict.set('__hash__', None);
method(bytesClass, '__bytes__', 'none', 0, 0, (self) =>
  asBytes(self).cls === bytesClass ? self : newBytes(new Uint8Array(asBytes(self).data))
);
method(bytesClass, '__getnewargs__', 'none', 0, 0, (self) => currentRuntime().tuple([self]));

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  currentRuntime().scan(length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function bytesItem(self: PyBytes, key: PyValue): PyValue {
  const data = self.data;
  if (key instanceof PySlice) {
    const { start, step, count } = sliceIndices(key, data.length);
    const result = new Uint8Array(count);
    for (let index = 0, position = start; index < count; index++, position += step) result[index] = data[position];
    currentRuntime().buildString(count);
    return sameKind(self, result);
  }
  const kind = self.isMutable ? 'bytearray' : 'byte';
  const index = toIndex(key, (value) => `${kind} indices must be integers or slices, not ${typeName(value)}`);
  const resolved = index < 0n ? index + BigInt(data.length) : index;
  if (resolved < 0n || resolved >= BigInt(data.length)) {
    throw pyError('IndexError', self.isMutable ? 'bytearray index out of range' : 'index out of range');
  }
  return BigInt(data[Number(resolved)]);
}

function bytesIterator(self: PyBytes): PyIterator {
  const next = iterateByIndex(
    self,
    () => self.length,
    (index) => BigInt(self.data[index] as number),
    newTuple([])
  );
  return new PyIterator(iteratorClass(self.isMutable ? 'bytearray_iterator' : 'bytes_iterator'), next, () => [self]);
}

/** `item in data`, for an int byte value or a bytes-like subsequence. */
export function bytesContains(data: Uint8Array, item: PyValue): boolean {
  currentRuntime().scan(data.length);
  const sub = bytesLikeData(item);
  if (sub !== undefined) return latin1Text(data).includes(latin1Text(sub));
  if (typeof item !== 'bigint' && typeof item !== 'boolean' && lookupSpecial(item, '__index__') === undefined) {
    throw typeError(`a bytes-like object is required, not '${typeName(item)}'`);
  }
  return data.includes(byteValue(item));
}

function concatBytes(self: PyBytes, other: PyValue): PyValue {
  const otherData = bytesLikeData(other);
  if (otherData === undefined) {
    if (isProgramObject(other)) return NotImplemented;
    throw typeError(`can't concat ${typeName(other)} to ${self.cls.name}`);
  }
  const result = new Uint8Array(self.length + otherData.length);
  currentRuntime().buildString(result.length);
  result.set(self.data);
  result.set(otherData, self.length);
  return sameKind(self, result);
}

function repeatBytes(self: PyBytes, count: PyValue): PyValue {
  if (typeof count !== 'bigint' && typeof count !== 'boolean' && lookupSpecial(count, '__index__') === undefined) {
    if (isProgramObject(count)) return NotImplemented;
    throw typeError(`can't multiply sequence by non-int of type '${typeName(count)}'`);
  }
  const times = toIndex(count);
  return sameKind(self, repeatData(self.data, times));
}

export function repeatData(data: Uint8Array, times: bigint): Uint8Array {
  if (times <= 0n || data.length === 0) return new Uint8Array(0);
  if (times > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw pyError('OverflowError', "cannot fit 'int' into an index-sized integer");
  }
  const total = data.length * Number(times);
  currentRuntime().buildString(total);
  const result = new Uint8Array(total);
  for (let offset = 0; offset < total; offset += data.length) result.set(data, offset);
  return result;
}

/** Whether a value is an instance of a class the program defined, whose reflected operators get their turn. */
function isProgramObject(value: PyValue): boolean {
  return typeof value === 'object' && !value.cls.isBuiltin;
}

// Conversions to and from str ---------------------------------------------------------------------------------------

for (const cls of [bytesClass, bytearrayClass]) {
  method(
    cls,
    'decode',
    'takes',
    0,
    2,
    (self, args, kwargs) => {
      const encoding = stringArgument(argument(args, kwargs, 0, 'encoding'), 'decode', 'encoding') ?? 'utf8';
      const errors = stringArgument(argument(args, kwargs, 1, 'errors'), 'decode', 'errors') ?? 'strict';
      return decodeBytes(asBytes(self).data, encoding, errors);
    },
    { keywords: ['encoding', 'errors'] }
  );
}

method(
  strClass,
  'encode',
  'takes',
  0,
  2,
  (self, args, kwargs) => {
    const encoding = stringArgument(argument(args, kwargs, 0, 'encoding'), 'encode', 'encoding') ?? 'utf8';
    const errors = stringArgument(argument(args, kwargs, 1, 'errors'), 'encode', 'errors') ?? 'strict';
    return newBytes(encodeString(self as string, encoding, errors));
  },
  { keywords: ['encoding', 'errors'] }
);

export function stringArgument(
  argumentValue: PyValue | undefined,
  functionName: string,
  name: string
): string | undefined {
  if (argumentValue === undefined) return undefined;
  const value = unbox(argumentValue);
  if (typeof value !== 'string')
    throw typeError(`${functionName}() argument '${name}' must be str, not ${typeName(value)}`);
  return value;
}

// int.to_bytes and int.from_bytes -----------------------------------------------------------------------------------

/** Rejects the keyword-only `signed` passed positionally, as CPython's argument parser words it. */
function checkPositional(name: string, args: PyValue[]): void {
  if (args.length > 2) throw typeError(`${name}() takes at most 2 positional arguments (${args.length} given)`);
}

function byteOrderArgument(value: PyValue | undefined, functionName: string): boolean {
  const order = stringArgument(value, functionName, 'byteorder') ?? 'big';
  if (order !== 'little' && order !== 'big') throw valueError("byteorder must be either 'little' or 'big'");
  return order === 'little';
}

const MAX_SSIZE = (1n << 63n) - 1n;

function fitsInBytes(value: bigint, length: bigint, signed: boolean): boolean {
  const bits = length * 8n;
  if (!signed) return value === 0n || BigInt(value.toString(2).length) <= bits;
  if (length === 0n) return value === 0n;
  if (value >= 0n) return value === 0n || BigInt(value.toString(2).length) <= bits - 1n;
  const complement = -value - 1n;
  return complement === 0n || BigInt(complement.toString(2).length) <= bits - 1n;
}

method(
  intClass,
  'to_bytes',
  'takes',
  0,
  3,
  (self, args, kwargs) => {
    checkPositional('to_bytes', args);
    const value = BigInt(self as bigint | boolean);
    const length = toIndex(argument(args, kwargs, 0, 'length') ?? 1n);
    if (length < 0n) throw valueError('length argument must be non-negative');
    if (length > MAX_SSIZE) throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
    const little = byteOrderArgument(argument(args, kwargs, 1, 'byteorder'), 'to_bytes');
    const signed = isTruthy(kwargs?.get('signed') ?? false);
    if (!signed && value < 0n) throw pyError('OverflowError', "can't convert negative int to unsigned");
    if (!fitsInBytes(value, length, signed)) throw pyError('OverflowError', 'int too big to convert');
    currentRuntime().buildString(Number(length));
    const data = new Uint8Array(Number(length));
    writeInteger(value, data.length, little, data, 0);
    return newBytes(data);
  },
  { keywords: ['length', 'byteorder', 'signed'] }
);

method(
  intClass,
  'from_bytes',
  'takes',
  1,
  3,
  (owner, args, kwargs) => {
    checkPositional('from_bytes', args);
    const source = argument(args, kwargs, 0, 'bytes') as PyValue;
    const data = bytesFromObject('from_bytes', source);
    const little = byteOrderArgument(argument(args, kwargs, 1, 'byteorder'), 'from_bytes');
    currentRuntime().scan(data.length);
    currentRuntime().chargeBits(BigInt(data.length * 8));
    const value = readInteger(data, little, isTruthy(kwargs?.get('signed') ?? false));
    if (owner === intClass) return value;
    if (owner === boolClass) return value !== 0n;
    return callValue(owner, [value]);
  },
  { keywords: ['bytes', 'byteorder', 'signed'], binding: 'class' }
);
