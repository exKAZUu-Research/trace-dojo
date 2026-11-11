import { toIndex } from './numbers';
import { bindValue, callValue, lookupSpecial, toArray } from './objects';
import { currentRuntime } from './runtimeContext';
import { codePointAt, hasSurrogates, iterStr, sliceStr, strLength } from './strings';
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

/** Resolves a slice against a sequence length, as CPython's slice.indices does. */
// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes CPython's PySlice_AdjustIndices.
export function sliceIndices(slice: PySlice, length: number): SliceIndices {
  const stepValue = sliceIndex(slice.step) ?? 1n;
  if (stepValue === 0n) throw valueError('slice step cannot be zero');
  const step = Number(stepValue);
  const len = BigInt(length);
  const clamp = (value: bigint | undefined, defaultValue: bigint, isStart: boolean): number => {
    if (value === undefined) return Number(defaultValue);
    let index = value;
    if (index < 0n) {
      index += len;
      if (index < 0n) index = step < 0 ? -1n : 0n;
    } else if (index >= len) {
      index = step < 0 ? len - 1n : len;
    }
    void isStart;
    return Number(index);
  };
  const start = clamp(sliceIndex(slice.start), step < 0 ? len - 1n : 0n, true);
  const stop = clamp(sliceIndex(slice.stop), step < 0 ? -1n : len, false);
  let count = 0;
  if (step < 0) {
    if (stop < start) count = Math.floor((start - stop - 1) / -step) + 1;
  } else if (start < stop) {
    count = Math.floor((stop - start - 1) / step) + 1;
  }
  return { start, stop, step, count };
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

// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of subscriptable builtin.
export function getItem(container: PyValue, key: PyValue): PyValue {
  const runtime = currentRuntime();
  if (container instanceof PyList || container instanceof PyTuple) {
    const special = classOf(container).isBuiltin ? undefined : userMethod(container, '__getitem__');
    if (special !== undefined) return callValue(special, [key]);
    const kind = container instanceof PyList ? 'list' : 'tuple';
    if (key instanceof PySlice) {
      const items = sliceItems(container.items, sliceIndices(key, container.items.length));
      runtime.allocate(items.length);
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

function userMethod(container: PyValue, name: string): PyValue | undefined {
  const method = lookupSpecial(container, name);
  const builtin = classOf(container)
    .mro.find((cls) => cls.isBuiltin)
    ?.dict.get(name);
  return method === undefined || method === builtin ? undefined : bindValue(method, container);
}

function stringItem(text: string, key: PyValue): string {
  if (key instanceof PySlice) {
    const length = strLength(text);
    const { start, step, count } = sliceIndices(key, length);
    if (count <= 0) return '';
    const stop = start + step * count;
    return sliceStr(text, start, step > 0 ? Math.min(stop, length) : stop, step);
  }
  if (typeof key !== 'bigint' && typeof key !== 'boolean') {
    const index = lookupSpecial(key, '__index__');
    if (index === undefined) throw typeError(`string indices must be integers, not '${typeName(key)}'`);
  }
  const length = hasSurrogates(text) ? iterStr(text).length : text.length;
  const index = normalizeIndex(key, length, 'string');
  if (index === undefined) throw pyError('IndexError', 'string index out of range');
  return codePointAt(text, index);
}

function dictItem(dict: PyDict, key: PyValue): PyValue {
  const special = classOf(dict).isBuiltin ? undefined : userMethod(dict, '__getitem__');
  if (special !== undefined) return callValue(special, [key]);
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
    const indices = sliceIndices(key, Number(length));
    const start = range.start + BigInt(indices.start) * range.step;
    const step = range.step * BigInt(indices.step);
    const stop = start + BigInt(indices.count) * step;
    return new PyRange(rangeClass, start, stop, step);
  }
  const index = toIndex(key, (value) => `range indices must be integers or slices, not ${typeName(value)}`);
  const resolved = index < 0n ? index + length : index;
  if (resolved < 0n || resolved >= length) throw pyError('IndexError', 'range object index out of range');
  return range.start + resolved * range.step;
}

export function setItem(container: PyValue, key: PyValue, value: PyValue): void {
  currentRuntime().spend();
  if (container instanceof PyList && classOf(container).isBuiltin) {
    if (key instanceof PySlice) {
      assignSlice(container, key, value);
      return;
    }
    const index = normalizeIndex(key, container.items.length, 'list');
    if (index === undefined) throw pyError('IndexError', 'list assignment index out of range');
    container.items[index] = value;
    return;
  }
  if (container instanceof PyDict && classOf(container).isBuiltin) {
    container.store.set(key, value);
    return;
  }
  const special = lookupSpecial(container, '__setitem__');
  if (special !== undefined) {
    callValue(bindValue(special, container), [key, value]);
    return;
  }
  if (container instanceof PyClass) throw typeError(`'type' object does not support item assignment`);
  throw typeError(`'${typeName(container)}' object does not support item assignment`);
}

function assignSlice(list: PyList, slice: PySlice, value: PyValue): void {
  const items = value === list ? [...list.items] : toArray(value);
  const indices = sliceIndices(slice, list.items.length);
  currentRuntime().allocate(items.length);
  if (indices.step === 1) {
    const stop = Math.max(indices.start, indices.stop);
    list.items.splice(indices.start, stop - indices.start, ...items);
    return;
  }
  if (items.length !== indices.count) {
    throw valueError(`attempt to assign sequence of size ${items.length} to extended slice of size ${indices.count}`);
  }
  for (let index = 0, position = indices.start; index < indices.count; index++, position += indices.step) {
    list.items[position] = items[index];
  }
}

// code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of builtin that supports item deletion.
export function deleteItem(container: PyValue, key: PyValue): void {
  if (container instanceof PyList && classOf(container).isBuiltin) {
    if (key instanceof PySlice) {
      const indices = sliceIndices(key, container.items.length);
      if (indices.step === 1) {
        container.items.splice(indices.start, Math.max(0, indices.stop - indices.start));
        return;
      }
      const remove = new Set<number>();
      for (let index = 0, position = indices.start; index < indices.count; index++, position += indices.step)
        remove.add(position);
      container.items = container.items.filter((_, index) => !remove.has(index));
      return;
    }
    const index = normalizeIndex(key, container.items.length, 'list');
    if (index === undefined) throw pyError('IndexError', 'list assignment index out of range');
    container.items.splice(index, 1);
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
  throw typeError(`'${typeName(container)}' object doesn't support item deletion`);
}
