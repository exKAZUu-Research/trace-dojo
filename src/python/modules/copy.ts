import { pythonFunction } from '../define';
import { DictStore } from '../dictStore';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { bindValue, callValue, getAttribute, lookupSpecial, setAttribute, toArray } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { SetTable } from '../setTable';
import { classOf, exceptionClassNamed, newDict, newTuple, typeError } from '../types';
import {
  type AttributeMap,
  type ExceptionState,
  type Kwargs,
  type PyClass,
  PyDeque,
  PyDict,
  PyInstance,
  PyList,
  PySet,
  PyTuple,
  type PyValue,
} from '../values';
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
  const rebuilt = reconstructed(value, (item) => item);
  if (rebuilt !== undefined) return rebuilt;
  if (value instanceof PyInstance && !value.cls.isBuiltin && !value.turtle) {
    const copy = new PyInstance(value.cls);
    for (const [key, item] of value.dict) copy.dict.set(key, item);
    return copy;
  }
  return value;
}

/**
 * `copy.deepcopy`: copies containers and instances recursively, sharing what the original shares. `memo` maps the
 * `id()` of each copied object to its copy, as a program's `__deepcopy__` reads and fills it.
 */
// code-gauge-allow functionNcss 51 -- One case per kind of container copy.deepcopy copies.
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
    for (const item of value.items) copy.append(deepCopy(item, memo));
    return copy;
  }
  const rebuilt = reconstructed(value, (item) => deepCopy(item, memo), { memo, id });
  if (rebuilt !== undefined) return rebuilt;
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
    for (const item of value.items) copy.append(deepCopy(item, memo));
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

/** What a deepcopy call copies into: its memo, and the `id()` of the value being copied. */
interface DeepCopy {
  memo: PyDict;
  id: bigint;
}

/**
 * A copy of a value that copy._reconstruct rebuilds from what `__reduce_ex__(4)` gives, a namedtuple or its subclass
 * or an exception, with its parts copied by `copyItem`; undefined for any other value.
 */
function reconstructed(value: PyValue, copyItem: (item: PyValue) => PyValue, deep?: DeepCopy): PyValue | undefined {
  if (value instanceof PyTuple && !value.cls.isBuiltin) return reconstructTuple(value, copyItem, deep);
  if (value instanceof PyInstance && value.exception) return reconstructException(value, copyItem, deep);
  return undefined;
}

/**
 * Copies a namedtuple or an instance of its subclass as copy._reconstruct does with what `__reduce_ex__(4)` gives: a
 * new instance from `cls.__new__(cls, *self.__getnewargs__())`, then its `__dict__`, both copied by `copyItem`.
 */
function reconstructTuple(value: PyTuple, copyItem: (item: PyValue) => PyValue, deep?: DeepCopy): PyTuple {
  const newArgs = toArray(callValue(getAttribute(value, '__getnewargs__'), [])).map((item) => copyItem(item));
  const construct = value.cls.mro.find((cls) => cls.construct)?.construct as NonNullable<PyClass['construct']>;
  const copy = construct(value.cls, newArgs, undefined) as PyTuple;
  if (deep) deep.memo.store.set(deep.id, copy);
  const state = value.attributes && (deep ? deepCopiedState(value.attributes, deep.memo) : value.attributes);
  for (const [key, item] of state ?? []) copy.attributes?.set(key, item);
  return copy;
}

/**
 * Copies an exception as copy._reconstruct does with what BaseException.__reduce__ gives: the class called with the
 * exception's arguments, then its `__dict__` (with `__notes__`) set attribute by attribute, both copied by `copyItem`.
 */
function reconstructException(value: PyInstance, copyItem: (item: PyValue) => PyValue, deep?: DeepCopy): PyValue {
  const state = value.exception as ExceptionState;
  const copy = callValue(
    value.cls,
    state.args.items.map((item) => copyItem(item))
  );
  if (deep) deep.memo.store.set(deep.id, copy);
  for (const [key, item] of value.dict) setAttribute(copy, key, copyItem(item));
  if (state.notes) setAttribute(copy, '__notes__', copyItem(state.notes));
  return copy;
}

/** The deep copies of the `__dict__`s a deepcopy call has copied, by memo, which CPython finds through the memo. */
const copiedStates = new WeakMap<PyDict, Map<AttributeMap, Map<string, PyValue>>>();

/** A deep copy of a `__dict__`, made once per deepcopy call as copying the dict itself would be. */
function deepCopiedState(attributes: AttributeMap, memo: PyDict): Map<string, PyValue> {
  let states = copiedStates.get(memo);
  if (!states) {
    states = new Map();
    copiedStates.set(memo, states);
  }
  const known = states.get(attributes);
  if (known) return known;
  const state = new Map<string, PyValue>();
  states.set(attributes, state);
  for (const [key, item] of attributes) state.set(key, deepCopy(item, memo));
  return state;
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
