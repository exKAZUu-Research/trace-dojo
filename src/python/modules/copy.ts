import { builtin } from '../define';
import { DictStore } from '../dictStore';
import { registerModule } from '../modules';
import { bindValue, callValue, lookupSpecial } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { newTuple } from '../types';
import { PyDeque, PyDict, PyInstance, PyList, type PyObject, PySet, PyTuple, type PyValue } from '../values';

/** `copy.copy`: a new container or instance holding the same items. */
function shallowCopy(value: PyValue): PyValue {
  if (typeof value !== 'object') return value;
  const special = lookupSpecial(value, '__copy__');
  if (special !== undefined) return callValue(bindValue(special, value), []);
  if (value instanceof PyList) return new PyList(value.cls, [...value.items]);
  if (value instanceof PyDict) {
    const copy = new PyDict(value.cls, new DictStore(), value.defaultFactory);
    for (const entry of value.store.ordered()) copy.store.set(entry.key, entry.value);
    return copy;
  }
  if (value instanceof PySet) return new PySet(value.cls, value.table.copy());
  if (value instanceof PyDeque) return new PyDeque(value.cls, [...value.items], value.maxlen);
  if (value instanceof PyInstance && !value.cls.isBuiltin && !value.turtle) {
    const copy = new PyInstance(value.cls);
    for (const [key, item] of value.dict) copy.dict.set(key, item);
    copy.exception = value.exception && { ...value.exception };
    return copy;
  }
  return value;
}

/** `copy.deepcopy`: copies containers and instances recursively, sharing what the original shares. */
// code-gauge-allow functionNcss 41 -- One case per kind of container copy.deepcopy copies.
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of container copy.deepcopy copies.
function deepCopy(value: PyValue, memo: Map<PyObject, PyValue>): PyValue {
  if (typeof value !== 'object') return value;
  const known = memo.get(value);
  if (known !== undefined) return known;
  currentRuntime().spend();
  if (value instanceof PyList) {
    const copy = new PyList(value.cls, []);
    memo.set(value, copy);
    for (const item of value.items) copy.items.push(deepCopy(item, memo));
    return copy;
  }
  if (value instanceof PyTuple) {
    const items = value.items.map((item) => deepCopy(item, memo));
    const copy = items.every((item, index) => item === value.items[index])
      ? value
      : value.cls.isBuiltin
        ? newTuple(items)
        : new PyTuple(value.cls, items);
    memo.set(value, copy);
    return copy;
  }
  if (value instanceof PyDict) {
    const copy = new PyDict(value.cls, new DictStore(), value.defaultFactory);
    memo.set(value, copy);
    for (const entry of value.store.ordered()) copy.store.set(deepCopy(entry.key, memo), deepCopy(entry.value, memo));
    return copy;
  }
  if (value instanceof PySet) {
    const copy = new PySet(value.cls, value.table.copy());
    memo.set(value, copy);
    return copy;
  }
  if (value instanceof PyDeque) {
    const copy = new PyDeque(value.cls, [], value.maxlen);
    memo.set(value, copy);
    for (const item of value.items) copy.items.push(deepCopy(item, memo));
    return copy;
  }
  if (value instanceof PyInstance && !value.cls.isBuiltin && !value.turtle && value.enumValue === undefined) {
    const copy = new PyInstance(value.cls);
    memo.set(value, copy);
    for (const [key, item] of value.dict) copy.dict.set(key, deepCopy(item, memo));
    return copy;
  }
  return value;
}

registerModule(
  'copy',
  () =>
    new Map<string, PyValue>([
      ['copy', builtin('copy', 'one', 1, 1, ([value]) => shallowCopy(value))],
      ['deepcopy', builtin('deepcopy', 'expected', 1, 2, ([value]) => deepCopy(value, new Map()))],
    ])
);
