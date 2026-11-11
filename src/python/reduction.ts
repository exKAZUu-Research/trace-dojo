import { newBytes, PyBytes } from './bytesValues';
import {
  bindValue,
  callValue,
  getAttribute,
  getAttributeOrUndefined,
  getIterator,
  isTruthy,
  lookupSpecial,
} from './objects';
import { currentRuntime } from './runtimeContext';
import { classOf, dictClass, listClass, newDict, newTuple, None, objectClass, typeError, unbox } from './types';
import { PyComplex, PyDict, PyInstance, type PyObject, PyTuple, type PyValue } from './values';

// `object.__reduce_ex__`, `object.__reduce__`, and `object.__getstate__`, which pickle and copy use, as CPython's
// typeobject.c implements them on top of the module `copyreg`.

/** `object.__getstate__()`: the instance's `__dict__` and the values of its slots, or None when it has neither. */
export function objectState(self: PyValue): PyValue {
  if (!(self instanceof PyInstance) && !isSubclassObject(self)) return None;
  const object = self as PyObject;
  const attributes = object instanceof PyInstance ? object.dict : object.instanceDict;
  const state = attributes && attributes.size > 0 ? newDict([...attributes]) : None;
  const slots = object.slotValues;
  if (!slots || slots.size === 0) return state;
  return newTuple([state, newDict([...slots])]);
}

function isSubclassObject(value: PyValue): boolean {
  return typeof value === 'object' && !value.cls.isBuiltin;
}

/** `object.__reduce_ex__(protocol)`. */
export function reduceEx(self: PyValue, protocol: PyValue): PyValue {
  const reduce = classOf(self).lookup('__reduce__');
  if (reduce !== undefined && reduce !== objectClass.dict.get('__reduce__')) {
    return callValue(bindValue(reduce, self), []);
  }
  return commonReduce(self, protocol);
}

/** `object.__reduce__()`. */
export function reduce(self: PyValue): PyValue {
  return commonReduce(self, 0n);
}

function commonReduce(self: PyValue, protocol: PyValue): PyValue {
  const copyreg = currentRuntime().importModule('copyreg');
  if (typeof protocol === 'bigint' && protocol >= 2n) return reduceNewObject(self, copyreg);
  return reduceWithReconstructor(self, copyreg);
}

/**
 * `copyreg._reduce_ex`: `copyreg._reconstructor` with the class, the builtin class whose `__new__` creates the object,
 * and the value that class makes of it, followed by the object's state when it has one.
 */
function reduceWithReconstructor(self: PyValue, copyreg: PyValue): PyValue {
  const runtime = currentRuntime();
  const cls = classOf(self);
  const base = cls.mro.find((each) => each.isBuiltin) ?? objectClass;
  if (base === cls && base !== objectClass) throw typeError(`cannot pickle '${cls.name}' object`);
  const state = base === objectClass ? None : callValue(base, [self]);
  const args = newTuple([cls, base, state]);
  const slots = getAttributeOrUndefined(self, '__slots__');
  const getstate = lookupSpecial(self, '__getstate__');
  if (slots !== undefined && isTruthy(slots) && getstate === objectClass.dict.get('__getstate__')) {
    throw typeError('a class that defines __slots__ without defining __getstate__ cannot be pickled');
  }
  const dict = getstate === undefined ? None : callValue(bindValue(getstate, self), []);
  const reconstructor = getAttribute(copyreg, '_reconstructor');
  return isTruthy(dict) ? runtime.tuple([reconstructor, args, dict]) : runtime.tuple([reconstructor, args]);
}

/** `reduce_newobj`: the class and the arguments that recreate the object, its state, and its items. */
function reduceNewObject(self: PyValue, copyreg: PyValue): PyValue {
  const cls = classOf(self);
  const [args, kwargs] = newArguments(self);
  const runtime = currentRuntime();
  const getstate = lookupSpecial(self, '__getstate__');
  const state = getstate === undefined ? None : callValue(bindValue(getstate, self), []);
  const listItems = cls.isSubclassOf(listClass) ? getIterator(self) : None;
  const dictItems = cls.isSubclassOf(dictClass) ? getIterator(callValue(getAttribute(self, 'items'), [])) : None;
  if (kwargs !== undefined && kwargs.store.size > 0) {
    const constructor = getAttribute(copyreg, '__newobj_ex__');
    return runtime.tuple([constructor, newTuple([cls, newTuple(args), kwargs]), state, listItems, dictItems]);
  }
  const constructor = getAttribute(copyreg, '__newobj__');
  return runtime.tuple([constructor, newTuple([cls, ...args]), state, listItems, dictItems]);
}

/** What `__getnewargs_ex__` or `__getnewargs__` give, or what the builtin immutable types pass to `__new__`. */
function newArguments(self: PyValue): [PyValue[], PyDict | undefined] {
  const ex = lookupSpecial(self, '__getnewargs_ex__');
  if (ex !== undefined) {
    const result = callValue(bindValue(ex, self), []);
    if (!(result instanceof PyTuple) || result.items.length !== 2) {
      throw typeError('__getnewargs_ex__ should return a tuple of length 2');
    }
    const [args, kwargs] = result.items;
    if (!(args instanceof PyTuple))
      throw typeError('first item of the tuple returned by __getnewargs_ex__ must be a tuple');
    if (!(kwargs instanceof PyDict))
      throw typeError('second item of the tuple returned by __getnewargs_ex__ must be a dict');
    return [[...args.items], kwargs];
  }
  const plain = lookupSpecial(self, '__getnewargs__');
  if (plain !== undefined) {
    const result = callValue(bindValue(plain, self), []);
    if (!(result instanceof PyTuple)) throw typeError('__getnewargs__ should return a tuple');
    return [[...result.items], undefined];
  }
  return [builtinNewArguments(self), undefined];
}

/** The `__getnewargs__` of int, float, str, bytes, complex, and tuple, which hold their value in the object itself. */
function builtinNewArguments(self: PyValue): PyValue[] {
  const value = unbox(self);
  if (typeof value === 'boolean') return [value ? 1n : 0n];
  if (typeof value !== 'object') return [value];
  if (value instanceof PyComplex) return [value.real, value.imag];
  if (value instanceof PyBytes && !value.isMutable) return [newBytes(value.data)];
  if (value instanceof PyTuple) return [newTuple([...value.items])];
  return [];
}
