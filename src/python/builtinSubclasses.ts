import { method } from './define';
// Gives the builtin types the `__new__` and `__init__` that create and fill instances of a program's subclasses.
import { DictStore } from './dictStore';
import { defineNew } from './instances';
import { deleteListItem, setListItem } from './items';
import { checkArgs } from './nativeArgs';
import { extendList } from './operators';
import { currentRuntime } from './runtimeContext';
import { updateTable } from './setOperations';
import { SetTable } from './setTable';
import { turtleClass } from './turtle';
import { updateDict } from './typeContainers';
import {
  baseExceptionClass,
  complexClass,
  defineMethod,
  dictClass,
  floatClass,
  frozensetClass,
  intClass,
  listClass,
  None,
  setClass,
  strClass,
  tupleClass,
} from './types';
import { type Kwargs, type PyClass, PyComplex, PyDict, PyInstance, PyList, PySet, type PyValue } from './values';

// Immutable types, whose `__new__` takes the value ---------------------------------------------------------------

for (const cls of [intClass, floatClass, strClass]) {
  const construct = cls.construct as NonNullable<PyClass['construct']>;
  defineNew(cls, (subtype, args, kwargs) => {
    const value = construct(cls, args, kwargs);
    return subtype === cls ? value : box(subtype, value as bigint | number | string);
  });
}

/** An instance of a program's subclass of int, float, or str, standing for a builtin value. */
function box(cls: PyClass, value: bigint | number | string): PyInstance {
  const instance = new PyInstance(cls);
  instance.primitive = value;
  return instance;
}

defineNew(complexClass, (subtype, args, kwargs) => {
  const value = (complexClass.construct as NonNullable<PyClass['construct']>)(complexClass, args, kwargs) as PyComplex;
  return subtype === complexClass ? value : new PyComplex(subtype, value.real, value.imag);
});
defineNew(tupleClass, tupleClass.construct as NonNullable<PyClass['construct']>);
defineNew(frozensetClass, frozensetClass.construct as NonNullable<PyClass['construct']>);
defineNew(baseExceptionClass, baseExceptionClass.construct as NonNullable<PyClass['construct']>);

// Mutable types, whose `__new__` creates an empty instance that `__init__` fills ---------------------------------

defineNew(listClass, (subtype) => new PyList(subtype, []));
defineMethod(listClass, '__init__', (self, args, kwargs) => {
  checkArgs({ qualified: 'list', min: 0, max: 1, style: 'expected' }, args, kwargs);
  const list = self as PyList;
  const removed = list.replaceItems([]).toReversed();
  if (removed.length > 0) currentRuntime().finalizer.release(removed, args);
  if (args.length > 0) extendList(list, args[0]);
  return None;
});

method(listClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  setListItem(self as PyList, key, value);
  return None;
});
method(listClass, '__delitem__', 'one', 1, 1, (self, [key]) => {
  deleteListItem(self as PyList, key);
  return None;
});

defineNew(dictClass, (subtype) => new PyDict(subtype, new DictStore()));
defineMethod(dictClass, '__init__', (self, args, kwargs) => {
  updateDictFromArguments(self as PyDict, 'dict', args, kwargs);
  return None;
});

/** Updates a dict from an optional mapping or iterable of pairs, then from keyword arguments, as `dict()` does. */
export function updateDictFromArguments(dict: PyDict, qualified: string, args: PyValue[], kwargs: Kwargs): void {
  checkArgs({ qualified, min: 0, max: 1, style: 'expected', keywords: [...(kwargs?.keys() ?? [])] }, args, kwargs);
  if (args.length > 0) updateDict(dict, args[0]);
  for (const [key, value] of kwargs ?? []) dict.store.set(key, value);
}

defineNew(setClass, (subtype) => new PySet(subtype, new SetTable()));
defineMethod(setClass, '__init__', (self, args, kwargs) => {
  checkArgs({ qualified: 'set', min: 0, max: 1, style: 'expected' }, args, kwargs);
  const table = (self as PySet).table;
  const removed = table.keys();
  table.clear();
  if (removed.length > 0) currentRuntime().finalizer.release(removed, args);
  if (args.length > 0) updateTable(table, args[0]);
  return None;
});

defineNew(turtleClass, (subtype) => new PyInstance(subtype));
