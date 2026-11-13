import { toIndex } from './numbers';
import { bindValue, callValue, lookupSpecial, overriding, toArray } from './objects';
import { currentRuntime } from './runtimeContext';
import { codePointAt, sliceStr, strLength } from './strings';
import {
  classOf,
  newException,
  newList,
  newTuple,
  None,
  pyError,
  rangeClass,
  typeError,
  typeName,
  valueError,
} from './types';
import { PyClass, PyDict, PyError, PyList, PyRange, PySlice, PyTuple, type PyValue } from './values';

export interface SliceIndices {
  start: number;
  stop: number;
  step: number;
  count: number;
}

function sliceIndex(value: PyValue): bigint | undefined {
  if (value === None) return undefined;
  return toIndex(value, () => 'slice indices must be integers or None or have an __index__ method');
}

/** Resolves a slice against the length of a sequence held in an array, whose indices are numbers. */
export function sliceIndices(slice: PySlice, length: number): SliceIndices {
  const bounds = exactSliceBounds(slice, BigInt(length));
  const [start, stop, step] = [Number(bounds.start), Number(bounds.stop), Number(bounds.step)];
  let count = 0;
  if (step < 0) {
    if (stop < start) count = Math.floor((start - stop - 1) / -step) + 1;
  } else if (start < stop) {
    count = Math.floor((stop - start - 1) / step) + 1;
  }
  return { start, stop, step, count };
}

/**
 * Resolves a slice against a length with exact integers, as CPython's PySlice_AdjustIndices does for sequences and
 * _PySlice_GetLongIndices for ranges and `slice.indices`.
 */
// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes CPython's PySlice_AdjustIndices.
export function exactSliceBounds(slice: PySlice, length: bigint): { start: bigint; stop: bigint; step: bigint } {
  const step = sliceIndex(slice.step) ?? 1n;
  if (step === 0n) throw valueError('slice step cannot be zero');
  const clamp = (value: bigint | undefined, defaultValue: bigint): bigint => {
    if (value === undefined) return defaultValue;
    if (value < 0n) {
      const index = value + length;
      return index < 0n ? (step < 0n ? -1n : 0n) : index;
    }
    if (value >= length) return step < 0n ? length - 1n : length;
    return value;
  };
  const start = clamp(sliceIndex(slice.start), step < 0n ? length - 1n : 0n);
  const stop = clamp(sliceIndex(slice.stop), step < 0n ? -1n : length);
  return { start, stop, step };
}

function sliceItems<T>(items: readonly T[], indices: SliceIndices): T[] {
  const { start, step, count } = indices;
  if (step === 1) return items.slice(start, start + count);
  const result: T[] = [];
  for (let index = 0, position = start; index < count; index++, position += step) result.push(items[position]);
  return result;
}

/** Interprets a sequence index, counting negative indices from the end, or returns undefined when out of range. */
function normalizeIndex(key: PyValue, length: number, kind: string): number | undefined {
  const index = toIndex(key, (value) => `${kind} indices must be integers or slices, not ${typeName(value)}`);
  const resolved = index < 0n ? index + BigInt(length) : index;
  if (resolved < 0n || resolved >= BigInt(length)) return undefined;
  return Number(resolved);
}

export function getItem(container: PyValue, key: PyValue): PyValue {
  const special = overriding(container, '__getitem__');
  if (special !== undefined) return callValue(bindValue(special, container), [key]);
  return builtinGetItem(container, key);
}

/** `container[key]` as the builtin type of `container` defines it, whatever `__getitem__` its class defines. */
// code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of subscriptable builtin.
export function builtinGetItem(container: PyValue, key: PyValue): PyValue {
  const runtime = currentRuntime();
  if (container instanceof PyList || container instanceof PyTuple) {
    const kind = container instanceof PyList ? 'list' : 'tuple';
    if (key instanceof PySlice) {
      const items = sliceItems(container.items, sliceIndices(key, container.items.length));
      return container instanceof PyList ? newList(items) : newTuple(items);
    }
    const index = normalizeIndex(key, container.items.length, kind);
    if (index === undefined) throw pyError('IndexError', `${kind} index out of range`);
    return container.items[index];
  }
  if (typeof container === 'string') return stringItem(container, key);
  if (container instanceof PyDict) return dictItem(container, key);
  if (container instanceof PyRange) return rangeItem(container, key);
  if (container instanceof PyClass) return runtime.classItem(container, key);
  const special = lookupSpecial(container, '__getitem__');
  if (special !== undefined) return callValue(bindValue(special, container), [key]);
  throw typeError(`'${typeName(container)}' object is not subscriptable`);
}

function stringItem(text: string, key: PyValue): string {
  if (key instanceof PySlice) {
    const length = strLength(text);
    const { start, step, count } = sliceIndices(key, length);
    if (count <= 0) return '';
    // A slice of the whole string is the string itself, as CPython returns it.
    if (step === 1 && count === length) return text;
    currentRuntime().buildString(count);
    const stop = start + step * count;
    return sliceStr(text, start, step > 0 ? Math.min(stop, length) : stop, step);
  }
  if (typeof key !== 'bigint' && typeof key !== 'boolean') {
    const index = lookupSpecial(key, '__index__');
    if (index === undefined) throw typeError(`string indices must be integers, not '${typeName(key)}'`);
  }
  const index = normalizeIndex(key, strLength(text), 'string');
  if (index === undefined) throw pyError('IndexError', 'string index out of range');
  return codePointAt(text, index);
}

function dictItem(dict: PyDict, key: PyValue): PyValue {
  const value = dict.store.get(key);
  if (value !== undefined) return value;
  return currentRuntime().missingKey(dict, key);
}

/** The KeyError a missing key raises, carrying the key as its argument. */
export function keyError(key: PyValue): PyError {
  return new PyError(newException(currentRuntime().exceptionClass('KeyError'), [key]));
}

function rangeItem(range: PyRange, key: PyValue): PyValue {
  const length = range.length;
  if (key instanceof PySlice) {
    const bounds = exactSliceBounds(key, length);
    const start = range.start + bounds.start * range.step;
    // CPython's compute_slice maps the slice's adjusted stop as it maps its start, not the stop after the last item.
    const stop = range.start + bounds.stop * range.step;
    return new PyRange(rangeClass, start, stop, range.step * bounds.step);
  }
  const index = toIndex(key, (value) => `range indices must be integers or slices, not ${typeName(value)}`);
  const resolved = index < 0n ? index + length : index;
  if (resolved < 0n || resolved >= length) throw pyError('IndexError', 'range object index out of range');
  return range.start + resolved * range.step;
}

export function setItem(container: PyValue, key: PyValue, value: PyValue): void {
  currentRuntime().spend();
  if (container instanceof PyList && overriding(container, '__setitem__') === undefined) {
    setListItem(container, key, value);
    return;
  }
  if (container instanceof PyDict && classOf(container).isBuiltin) {
    container.store.set(key, value);
    return;
  }
  const name = container instanceof PyClass ? 'type' : typeName(container);
  callItemMethod(container, '__setitem__', [key, value], `'${name}' object does not support item assignment`);
}

/** Calls the item method of a container's class, raising TypeError with `missing` when it has none. */
function callItemMethod(container: PyValue, name: string, args: PyValue[], missing: string): void {
  const special = lookupSpecial(container, name);
  if (special === undefined) throw typeError(missing);
  callValue(bindValue(special, container), args);
}

/** `list[key] = value` as list defines it. */
export function setListItem(list: PyList, key: PyValue, value: PyValue): void {
  if (key instanceof PySlice) {
    assignSlice(list, key, value);
    return;
  }
  const index = normalizeIndex(key, list.items.length, 'list');
  if (index === undefined) throw pyError('IndexError', 'list assignment index out of range');
  list.editableItems[index] = value;
}

function assignSlice(list: PyList, slice: PySlice, value: PyValue): void {
  const items = value === list ? [...list.items] : toArray(value, 'must assign iterable to extended slice');
  const indices = sliceIndices(slice, list.items.length);
  if (indices.step === 1) {
    const stop = Math.max(indices.start, indices.stop);
    list.splice(indices.start, stop - indices.start, items);
    return;
  }
  if (items.length !== indices.count) {
    throw valueError(`attempt to assign sequence of size ${items.length} to extended slice of size ${indices.count}`);
  }
  currentRuntime().scan(indices.count);
  for (let index = 0, position = indices.start; index < indices.count; index++, position += indices.step) {
    list.editableItems[position] = items[index];
  }
}

export function deleteItem(container: PyValue, key: PyValue): void {
  currentRuntime().spend();
  if (container instanceof PyList && overriding(container, '__delitem__') === undefined) {
    deleteListItem(container, key);
    return;
  }
  if (container instanceof PyDict && classOf(container).isBuiltin) {
    if (!container.store.delete(key)) throw keyError(key);
    return;
  }
  const special = lookupSpecial(container, '__delitem__');
  if (special !== undefined) {
    callValue(bindValue(special, container), [key]);
    return;
  }
  throw unsupportedDeletion(container, key);
}

/** `del list[key]` as list defines it. */
export function deleteListItem(list: PyList, key: PyValue): void {
  if (key instanceof PySlice) {
    const indices = sliceIndices(key, list.items.length);
    if (indices.step === 1) {
      list.removeRange(indices.start, Math.max(0, indices.stop - indices.start));
      return;
    }
    // As list_ass_subscript does, an empty slice removes nothing without visiting the list.
    if (indices.count === 0) return;
    currentRuntime().scan(list.items.length);
    list.replaceItems(withoutSlice(list.items, indices));
    return;
  }
  const index = normalizeIndex(key, list.items.length, 'list');
  if (index === undefined) throw pyError('IndexError', 'list assignment index out of range');
  list.removeRange(index, 1);
}

/** The items left after deleting an extended slice, kept in order. */
function withoutSlice(items: readonly PyValue[], { start, step, count }: SliceIndices): PyValue[] {
  // Walk the slice from its lowest position, so that each removed position is met in order.
  const lowest = step > 0 ? start : start + step * (count - 1);
  const stride = Math.abs(step);
  const kept: PyValue[] = [];
  let next = lowest;
  let removed = 0;
  for (let index = 0; index < items.length; index++) {
    if (index === next && removed < count) {
      removed++;
      next += stride;
    } else {
      kept.push(items[index]);
    }
  }
  return kept;
}

/**
 * The error of deleting an item from a value that cannot, as PyObject_DelItem decides it: a class with `__setitem__`
 * has the slot that then misses `__delitem__`; a sequence type with an index refuses in its own words; others refuse.
 */
function unsupportedDeletion(container: PyValue, key: PyValue): Error {
  if (lookupSpecial(container, '__setitem__') !== undefined) return pyError('AttributeError', '__delitem__');
  const cls = classOf(container);
  // A program's classes always have the sequence slots; a builtin type has them when it has a sequence protocol.
  const isSequenceType = !cls.isBuiltin || ['__getitem__', '__len__', '__contains__'].some((name) => cls.lookup(name));
  const isIndex = typeof key === 'bigint' || typeof key === 'boolean' || lookupSpecial(key, '__index__') !== undefined;
  const words = isSequenceType && isIndex ? "doesn't" : 'does not';
  return typeError(`'${typeName(container)}' object ${words} support item deletion`);
}
