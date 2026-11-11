// The methods by which a bytearray changes in place.
import { bytearrayClass, bytesLikeData, newByteArray, type PyBytes } from './bytesValues';
import { method } from './define';
import { sliceIndices } from './items';
import { toIndex } from './numbers';
import { iterate, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { byteValue, repeatData } from './typeBytes';
import { None, pyError, typeError, typeName, unbox, valueError } from './types';
import { DONE, PySlice, type PyValue } from './values';

const asArray = (self: PyValue): PyBytes => self as PyBytes;

function indexIn(self: PyBytes, key: PyValue): number {
  const index = toIndex(key, (value) => `bytearray indices must be integers or slices, not ${typeName(value)}`);
  const resolved = index < 0n ? index + BigInt(self.length) : index;
  if (resolved < 0n || resolved >= BigInt(self.length)) throw pyError('IndexError', 'bytearray index out of range');
  return Number(resolved);
}

method(bytearrayClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  const array = asArray(self);
  if (key instanceof PySlice) assignSlice(array, key, value);
  else {
    const index = indexIn(array, key);
    array.data[index] = byteValue(value);
  }
  return None;
});

function assignSlice(array: PyBytes, slice: PySlice, value: PyValue): void {
  const items = assignedBytes(value);
  const { start, stop, step, count } = sliceIndices(slice, array.length);
  if (step === 1) {
    array.splice(start, Math.max(start, stop), items);
    return;
  }
  if (items.length !== count) {
    throw valueError(`attempt to assign bytes of size ${items.length} to extended slice of size ${count}`);
  }
  for (let index = 0, position = start; index < count; index++, position += step) array.data[position] = items[index];
}

function assignedBytes(value: PyValue): Uint8Array {
  const data = bytesLikeData(value);
  if (data !== undefined) return new Uint8Array(data);
  if (
    typeof unbox(value) === 'string' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    lookupSpecial(value, '__iter__') === undefined
  ) {
    throw typeError('can assign only bytes, buffers, or iterables of ints in range(0, 256)');
  }
  return collectInts(value);
}

function collectInts(iterable: PyValue): Uint8Array {
  const next = iterate(iterable);
  const result: number[] = [];
  for (let item = next(); item !== DONE; item = next()) {
    currentRuntime().spend();
    result.push(byteValue(item));
  }
  return Uint8Array.from(result);
}

method(bytearrayClass, '__delitem__', 'one', 1, 1, (self, [key]) => {
  const array = asArray(self);
  if (!(key instanceof PySlice)) {
    const index = indexIn(array, key);
    array.splice(index, index + 1, new Uint8Array(0));
    return None;
  }
  const { start, stop, step, count } = sliceIndices(key, array.length);
  if (step === 1) {
    array.splice(start, Math.max(start, stop), new Uint8Array(0));
    return None;
  }
  const removed = new Set<number>();
  for (let index = 0, position = start; index < count; index++, position += step) removed.add(position);
  const kept = array.data.filter((_, index) => !removed.has(index));
  array.splice(0, array.length, kept);
  return None;
});

method(bytearrayClass, 'append', 'one', 1, 1, (self, [item]) => {
  const array = asArray(self);
  const byte = byteValue(item);
  array.splice(array.length, array.length, Uint8Array.of(byte));
  return None;
});

method(bytearrayClass, 'extend', 'one', 1, 1, (self, [iterable]) => {
  const array = asArray(self);
  let data = bytesLikeData(iterable);
  if (data === undefined) {
    if (typeof unbox(iterable) === 'string') throw typeError("expected iterable of integers; got: 'str'");
    if (lookupSpecial(iterable, '__iter__') === undefined && lookupSpecial(iterable, '__getitem__') === undefined) {
      throw typeError(`can't extend bytearray with ${typeName(iterable)}`);
    }
    data = collectInts(iterable);
  } else {
    data = new Uint8Array(data);
  }
  array.splice(array.length, array.length, data);
  return None;
});

method(bytearrayClass, 'insert', 'expected', 2, 2, (self, [indexValue, item]) => {
  const array = asArray(self);
  let index = Number(toIndex(indexValue));
  const byte = byteValue(item);
  if (index < 0) index = Math.max(0, index + array.length);
  index = Math.min(index, array.length);
  array.splice(index, index, Uint8Array.of(byte));
  return None;
});

method(bytearrayClass, 'pop', 'expected', 0, 1, (self, [indexValue]) => {
  const array = asArray(self);
  if (array.length === 0) throw pyError('IndexError', 'pop from empty bytearray');
  const index = toIndex(indexValue ?? -1n);
  const resolved = index < 0n ? index + BigInt(array.length) : index;
  if (resolved < 0n || resolved >= BigInt(array.length)) throw pyError('IndexError', 'pop index out of range');
  const position = Number(resolved);
  const byte = array.data[position];
  array.splice(position, position + 1, new Uint8Array(0));
  return BigInt(byte);
});

method(bytearrayClass, 'remove', 'one', 1, 1, (self, [item]) => {
  const array = asArray(self);
  const index = array.data.indexOf(byteValue(item));
  if (index === -1) throw valueError('value not found in bytearray');
  array.splice(index, index + 1, new Uint8Array(0));
  return None;
});

method(bytearrayClass, 'reverse', 'none', 0, 0, (self) => {
  asArray(self).data.reverse();
  return None;
});

method(bytearrayClass, 'clear', 'none', 0, 0, (self) => {
  const array = asArray(self);
  array.splice(0, array.length, new Uint8Array(0));
  return None;
});

method(bytearrayClass, 'copy', 'none', 0, 0, (self) => newByteArray(new Uint8Array(asArray(self).data)));

method(bytearrayClass, 'resize', 'one', 1, 1, (self, [sizeValue]) => {
  const array = asArray(self);
  const size = Number(toIndex(sizeValue));
  if (size < 0) throw valueError(`Can only resize to positive sizes, got ${size}`);
  if (size < array.length) array.splice(size, array.length, new Uint8Array(0));
  else array.splice(array.length, array.length, new Uint8Array(size - array.length));
  return None;
});

method(bytearrayClass, '__iadd__', 'one', 1, 1, (self, [other]) => {
  const array = asArray(self);
  const data = bytesLikeData(other);
  if (data === undefined) throw typeError(`can't concat ${typeName(other)} to bytearray`);
  array.splice(array.length, array.length, new Uint8Array(data));
  return self;
});

method(bytearrayClass, '__imul__', 'one', 1, 1, (self, [count]) => {
  const array = asArray(self);
  if (typeof count !== 'bigint' && typeof count !== 'boolean' && lookupSpecial(count, '__index__') === undefined) {
    throw typeError(`can't multiply sequence by non-int of type '${typeName(count)}'`);
  }
  array.splice(0, array.length, repeatData(new Uint8Array(array.data), toIndex(count)));
  return self;
});
