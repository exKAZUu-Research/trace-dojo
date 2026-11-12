import { pythonFunction } from '../define';
import { DictStore } from '../dictStore';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { bindValue, callValue, lookupSpecial } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { SetTable } from '../setTable';
import { classOf, exceptionClassNamed, newDict, newTuple, typeError } from '../types';
import { type Kwargs, PyDeque, PyDict, PyInstance, PyList, PySet, PyTuple, type PyValue } from '../values';
import { builtinClassWithBase } from './moduleClasses';

/** `copy.copy`: a new container or instance holding the same items. */
function shallowCopy(value: PyValue): PyValue {
  if (typeof value !== 'object') return value;
  const special = lookupSpecial(value, '__copy__');
  if (special !== undefined) return callValue(bindValue(special, value), []);
  if (value instanceof PyList) return new PyList(value.cls, [...value.items]);
  if (value instanceof PyDict) {
    const copy = new PyDict(value.cls, new DictStore(value.store.plainWrites), value.defaultFactory);
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

/**
 * `copy.deepcopy`: copies containers and instances recursively, sharing what the original shares. `memo` maps the
 * `id()` of each copied object to its copy, as a program's `__deepcopy__` reads and fills it.
 */
// code-gauge-allow functionNcss 48 -- One case per kind of container copy.deepcopy copies.
// code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of container copy.deepcopy copies.
function deepCopy(value: PyValue, memo: PyDict): PyValue {
  if (typeof value !== 'object') return value;
  const runtime = currentRuntime();
  const id = runtime.idOf(value);
  const known = memo.store.get(id);
  if (known !== undefined) return known;
  runtime.spend();
  const special = value.cls.isBuiltin ? undefined : lookupSpecial(value, '__deepcopy__');
  if (special !== undefined) {
    const copy = callValue(bindValue(special, value), [memo]);
    if (copy !== value) memo.store.set(id, copy);
    return copy;
  }
  if (value instanceof PyList) {
    const copy = new PyList(value.cls, []);
    memo.store.set(id, copy);
    for (const item of value.items) copy.items.push(deepCopy(item, memo));
    return copy;
  }
  if (value instanceof PyTuple) return deepCopyTuple(value, id, memo);
  if (value instanceof PyDict) {
    const copy = new PyDict(value.cls, new DictStore(value.store.plainWrites), value.defaultFactory);
    memo.store.set(id, copy);
    for (const entry of value.store.ordered()) copy.store.set(deepCopy(entry.key, memo), deepCopy(entry.value, memo));
    return copy;
  }
  if (value instanceof PySet) {
    const copy = new PySet(value.cls, new SetTable());
    memo.store.set(id, copy);
    for (const key of value.table.keys()) copy.table.add(deepCopy(key, memo));
    return copy;
  }
  if (value instanceof PyDeque) {
    const copy = new PyDeque(value.cls, [], value.maxlen);
    memo.store.set(id, copy);
    for (const item of value.items) copy.items.push(deepCopy(item, memo));
    return copy;
  }
  if (value instanceof PyInstance && !value.cls.isBuiltin && !value.turtle && value.enumValue === undefined) {
    const copy = new PyInstance(value.cls);
    memo.store.set(id, copy);
    for (const [key, item] of value.dict) copy.dict.set(key, deepCopy(item, memo));
    return copy;
  }
  return value;
}

function deepCopyTuple(value: PyTuple, id: bigint, memo: PyDict): PyValue {
  const items = value.items.map((item) => deepCopy(item, memo));
  // Copying the items has copied the tuple itself when one of them refers back to it.
  const copied = memo.store.get(id);
  if (copied !== undefined) return copied;
  const copy = items.every((item, index) => item === value.items[index])
    ? value
    : value.cls.isBuiltin
      ? newTuple(items)
      : new PyTuple(value.cls, items);
  memo.store.set(id, copy);
  return copy;
}

const copyErrorClass = builtinClassWithBase('Error', exceptionClassNamed('Exception'), 'copy');

/** `copy.replace(obj, /, **changes)`, which calls the `__replace__` of the object's class. */
function replace([value]: PyValue[], kwargs: Kwargs): PyValue {
  const cls = classOf(value);
  const method = cls.lookup('__replace__');
  if (method === undefined) throw typeError(`replace() does not support ${cls.name} objects`);
  return callValue(bindValue(method, value), [], kwargs);
}

registerUnsupportedAttributes('copy', { dispatch_table: 'copy.dispatch_table（copyreg モジュール）' });

registerModule(
  'copy',
  () =>
    new Map<string, PyValue>([
      ['copy', pythonFunction('copy', 'x', ([value]) => shallowCopy(value))],
      [
        'deepcopy',
        pythonFunction('deepcopy', 'x, memo=None, _nil=[]', ([value, memo]) =>
          deepCopy(value, memo instanceof PyDict ? memo : newDict())
        ),
      ],
      ['replace', pythonFunction('replace', 'obj, /, **changes', replace)],
      ['Error', copyErrorClass],
      ['error', copyErrorClass],
    ])
);
