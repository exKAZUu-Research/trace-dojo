import { builtin } from '../define';
import { DictStore } from '../dictStore';
import { stateOf } from '../iteratorStates';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { bindValue, callValue, getAttribute, lookupSpecial } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { classOf, exceptionClassNamed, nativeFunction, newTuple, None, typeError } from '../types';
import {
  type Kwargs,
  PyDeque,
  PyDict,
  PyInstance,
  PyIterator,
  PyList,
  type PyObject,
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
  const copy = shallowCopyContents(value);
  if (copy !== value && typeof copy === 'object') copyAttributes(value, copy, (item) => item);
  return copy;
}

/** Copies the attributes a program's class gives an instance outside the instance's own dict, such as slots. */
function copyAttributes(source: PyObject, target: PyObject, copyItem: (item: PyValue) => PyValue): void {
  if (source.instanceDict) target.instanceDict = mapValues(source.instanceDict, copyItem);
  if (source.slotValues) target.slotValues = mapValues(source.slotValues, copyItem);
}

function mapValues(map: Map<string, PyValue>, copyItem: (item: PyValue) => PyValue): Map<string, PyValue> {
  const copy = new Map<string, PyValue>();
  for (const [key, item] of map) copy.set(key, copyItem(item));
  return copy;
}

function shallowCopyContents(value: PyObject): PyValue {
  if (value instanceof PyList) return new PyList(value.cls, [...value.items]);
  if (value instanceof PyDict) {
    const copy = new PyDict(value.cls, new DictStore(value.store.plainWrites), value.defaultFactory);
    for (const entry of value.store.ordered()) copy.store.set(entry.key, entry.value);
    return copy;
  }
  if (value instanceof PySet) return new PySet(value.cls, value.table.copy());
  if (value instanceof PyDeque) return new PyDeque(value.cls, [...value.items], value.maxlen);
  if (value instanceof PyIterator) return copyIterator(value, (item) => item) ?? value;
  if (value instanceof PyInstance && !value.cls.isBuiltin && !value.turtle) {
    const copy = new PyInstance(value.cls);
    for (const [key, item] of value.dict) copy.dict.set(key, item);
    copy.exception = value.exception && { ...value.exception };
    copy.primitive = value.primitive;
    return copy;
  }
  return value;
}

/** `copy.deepcopy`: copies containers and instances recursively, sharing what the original shares. */
function deepCopy(value: PyValue, memo: Map<PyObject, PyValue>): PyValue {
  if (typeof value !== 'object') return value;
  const known = memo.get(value);
  if (known !== undefined) return known;
  currentRuntime().spend();
  const copy = deepCopyContents(value, memo);
  if (copy !== value && typeof copy === 'object') copyAttributes(value, copy, (item) => deepCopy(item, memo));
  return copy;
}

// code-gauge-allow functionNcss 41 -- One case per kind of container copy.deepcopy copies.
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of container copy.deepcopy copies.
function deepCopyContents(value: PyObject, memo: Map<PyObject, PyValue>): PyValue {
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
    const copy = new PyDict(value.cls, new DictStore(value.store.plainWrites), value.defaultFactory);
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
  if (value instanceof PyIterator) {
    const copy = copyIterator(value, (item) => deepCopy(item, memo)) ?? value;
    memo.set(value, copy);
    return copy;
  }
  if (value instanceof PyInstance && !value.cls.isBuiltin && !value.turtle && value.enumValue === undefined) {
    const copy = new PyInstance(value.cls);
    memo.set(value, copy);
    for (const [key, item] of value.dict) copy.dict.set(key, deepCopy(item, memo));
    copy.primitive = value.primitive;
    return copy;
  }
  return value;
}

/**
 * A copy of a builtin iterator made from what it reduces to, as `copy._reconstruct` makes one: the callable applied to
 * the arguments, copied by `copyItem`, then moved to the state. Undefined for an iterator that does not reduce.
 */
function copyIterator(value: PyIterator, copyItem: (item: PyValue) => PyValue): PyValue | undefined {
  const state = stateOf(value.next);
  if (!state) return undefined;
  const [fn, args, position] = (state.reduce() as PyTuple).items;
  const copy = callValue(fn, (args as PyTuple).items.map(copyItem));
  if (position !== undefined && position !== None) callValue(getAttribute(copy, '__setstate__'), [copyItem(position)]);
  return copy;
}

const copyErrorClass = builtinClassWithBase('Error', exceptionClassNamed('Exception'), 'copy');

/** `copy.replace(obj, /, **changes)`, which calls the `__replace__` of the object's class. */
function replace(args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length !== 1) throw typeError(`replace() takes 1 positional argument but ${args.length} were given`);
  const [value] = args;
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
      ['copy', builtin('copy', 'one', 1, 1, ([value]) => shallowCopy(value))],
      ['deepcopy', builtin('deepcopy', 'expected', 1, 2, ([value]) => deepCopy(value, new Map()))],
      ['replace', nativeFunction('replace', replace)],
      ['Error', copyErrorClass],
      ['error', copyErrorClass],
    ])
);
