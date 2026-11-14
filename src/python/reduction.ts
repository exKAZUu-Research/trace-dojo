import { memberDescriptorClass, type PyAttribute } from './attributeDescriptors';
// The reduction protocol of `object` and the builtin types, which pickle and copyreg rely on: `__reduce_ex__`,
// `__reduce__`, `__getstate__` and `__getnewargs__`, as CPython's typeobject.c and the builtin types define them.
import { bytesLikeData, latin1Text, newBytes } from './bytesValues';
import { method } from './define';
import { fieldedCTypes, ownDict } from './descriptors';
import { importModule } from './modules';
import { toIndex } from './numbers';
import { callValue, getAttribute, getAttributeOrUndefined, getIterator, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import {
  baseExceptionClass,
  builtinFunctionClass,
  bytearrayClass,
  bytesClass,
  classOf,
  complexClass,
  floatClass,
  frozensetClass,
  intClass,
  iteratorClasses,
  methodClass,
  methodDescriptorClass,
  methodWrapperClass,
  newDict,
  newList,
  newTuple,
  None,
  objectClass,
  rangeClass,
  setClass,
  sliceClass,
  strClass,
  tupleClass,
  typeError,
  typeName,
  unbox,
  wrapperDescriptorClass,
} from './types';
import {
  type PyBoundMethod,
  type PyBuiltinFunction,
  PyClass,
  type PyComplex,
  PyDict,
  PyInstance,
  PyList,
  PyModule,
  type PyRange,
  type PySet,
  type PySlice,
  PyTuple,
  type PyValue,
} from './values';

const copyreg = (): PyModule => importModule(currentRuntime(), 'copyreg');
const copyregFunction = (name: string): PyValue => copyreg().dict.get(name) as PyValue;

method(objectClass, '__reduce_ex__', 'one', 1, 1, (self, [protocol]) => {
  const proto = Number(toIndex(protocol));
  const reduce = getAttributeOrUndefined(self, '__reduce__');
  if (reduce !== undefined && lookupSpecial(self, '__reduce__') !== objectClass.dict.get('__reduce__')) {
    return callValue(reduce, []);
  }
  return commonReduce(self, proto);
});
method(objectClass, '__reduce__', 'none', 0, 0, (self) => commonReduce(self, 0));
method(objectClass, '__getstate__', 'none', 0, 0, (self) => defaultState(self, false));

function commonReduce(self: PyValue, proto: number): PyValue {
  // CPython's builtin iterators reduce to their position, which this interpreter does not expose.
  if (iteratorClasses.get(classOf(self).name) === classOf(self))
    throw currentRuntime().unsupported('イテレータの pickle');
  if (proto >= 2) return reduceNewobj(self);
  return callValue(copyregFunction('_reduce_ex'), [self, BigInt(proto)]);
}

function reduceNewobj(obj: PyValue): PyValue {
  const cls = classOf(obj);
  const [args, kwargs] = newArguments(obj);
  let newobj: PyValue;
  let newargs: PyValue;
  if (kwargs === undefined || kwargs.store.size === 0) {
    newobj = copyregFunction('__newobj__');
    newargs = newTuple([cls, ...(args?.items ?? [])]);
  } else {
    newobj = copyregFunction('__newobj_ex__');
    newargs = newTuple([cls, args ?? newTuple([]), kwargs]);
  }
  const isList = obj instanceof PyList;
  const isDict = obj instanceof PyDict;
  const state = objectState(obj, !(args !== undefined || isList || isDict));
  const listitems = isList ? getIterator(obj) : None;
  const dictitems = isDict ? getIterator(callValue(getAttribute(obj, 'items'), [])) : None;
  return newTuple([newobj, newargs, state, listitems, dictitems]);
}

/** `_PyObject_GetNewArguments`: what `__getnewargs_ex__` or `__getnewargs__` return, checked as CPython checks them. */
function newArguments(obj: PyValue): [PyTuple | undefined, PyDict | undefined] {
  if (lookupSpecial(obj, '__getnewargs_ex__') !== undefined) {
    const result = callValue(getAttribute(obj, '__getnewargs_ex__'), []);
    if (!(result instanceof PyTuple)) {
      throw typeError(`__getnewargs_ex__ should return a tuple, not '${typeName(result)}'`);
    }
    if (result.items.length !== 2) {
      throw typeError(`__getnewargs_ex__ should return a tuple of length 2, not ${result.items.length}`);
    }
    const [args, kwargs] = result.items;
    if (!(args instanceof PyTuple)) {
      throw typeError(`first item of the tuple returned by __getnewargs_ex__ must be a tuple, not '${typeName(args)}'`);
    }
    if (!(kwargs instanceof PyDict)) {
      throw typeError(
        `second item of the tuple returned by __getnewargs_ex__ must be a dict, not '${typeName(kwargs)}'`
      );
    }
    return [args, kwargs];
  }
  if (lookupSpecial(obj, '__getnewargs__') === undefined) return [undefined, undefined];
  const args = callValue(getAttribute(obj, '__getnewargs__'), []);
  if (!(args instanceof PyTuple)) throw typeError(`__getnewargs__ should return a tuple, not '${typeName(args)}'`);
  return [args, undefined];
}

/** `object_getstate`: the object's own `__getstate__`, or the default state. */
export function objectState(obj: PyValue, required: boolean): PyValue {
  if (lookupSpecial(obj, '__getstate__') === objectClass.dict.get('__getstate__')) return defaultState(obj, required);
  return callValue(getAttribute(obj, '__getstate__'), []);
}

/** The name CPython's C types give themselves in messages: the module's name and the type's, except for builtins. */
export function cTypeName(cls: PyClass): string {
  if (!cls.isBuiltin || cls.module === undefined || cls.module === 'builtins') return cls.name;
  return `${cls.module}.${cls.name}`;
}

/** `object_getstate_default`: the instance's dict, with the values of its slots, or None. */
function defaultState(obj: PyValue, required: boolean): PyValue {
  const dict = typeof obj === 'object' ? ownDict(obj) : undefined;
  let state: PyValue = dict === undefined || dict.size === 0 ? None : getAttribute(obj, '__dict__');
  const cls = classOf(obj);
  const slotnames = slotNames(cls);
  if (required && !hasPlainLayout(obj)) throw typeError(`cannot pickle '${cTypeName(cls)}' object`);
  if (slotnames.length === 0) return state;
  const slots = newDict();
  for (const name of slotnames) {
    const value = getAttributeOrUndefined(obj, name);
    if (value !== undefined) slots.store.set(name, value);
  }
  if (slots.store.size > 0) state = newTuple([state, slots]);
  return state;
}

/** Whether CPython's instances of the object's type hold nothing beyond what `object`, a dict and slots hold. */
function hasPlainLayout(obj: PyValue): boolean {
  if (obj === None) return true;
  return (
    obj instanceof PyInstance &&
    obj.primitive === undefined &&
    obj.exception === undefined &&
    obj.turtle === undefined &&
    !obj.cls.mro.some((cls) => fieldedCTypes.has(cls))
  );
}

function slotNames(cls: PyClass): string[] {
  const cached = cls.dict.get('__slotnames__');
  const names = cached !== undefined && cached !== None ? cached : callValue(copyregFunction('_slotnames'), [cls]);
  return names instanceof PyList ? (names.items as string[]) : [];
}

// The builtin types --------------------------------------------------------------------------------------------------

method(intClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([BigInt(unbox(self) as bigint | boolean)]));
method(floatClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([unbox(self)]));
method(strClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([unbox(self)]));
method(bytesClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([newBytes(bytesLikeData(self) as Uint8Array)]));
method(tupleClass, '__getnewargs__', 'none', 0, 0, (self) => newTuple([newTuple((self as PyTuple).items)]));
method(complexClass, '__getnewargs__', 'none', 0, 0, (self) =>
  newTuple([(self as PyComplex).real, (self as PyComplex).imag])
);

/** `_PyObject_GetState` for the builtin types whose reduce adds the state: the instance's dict, or None. */
function instanceState(self: PyValue): PyValue {
  return objectState(self, false);
}

for (const cls of [setClass, frozensetClass]) {
  method(cls, '__reduce__', 'none', 0, 0, (self) =>
    newTuple([classOf(self), newTuple([newList((self as PySet).table.keys())]), instanceState(self)])
  );
}
method(bytearrayClass, '__reduce_ex__', 'expected', 0, 1, (self, [protocol]) => bytearrayReduce(self, protocol));
method(bytearrayClass, '__reduce__', 'none', 0, 0, (self) => bytearrayReduce(self, 0n));

function bytearrayReduce(self: PyValue, protocol: PyValue | undefined): PyValue {
  const proto = protocol === undefined ? 0 : Number(toIndex(protocol));
  const data = bytesLikeData(self) as Uint8Array;
  const state = instanceState(self);
  if (proto < 3) return newTuple([classOf(self), newTuple([latin1Text(data), 'latin-1']), state]);
  return newTuple([classOf(self), newTuple(data.length > 0 ? [newBytes(data)] : []), state]);
}

method(rangeClass, '__reduce__', 'none', 0, 0, (self) => {
  const range = self as PyRange;
  return newTuple([rangeClass, newTuple([range.start, range.stop, range.step])]);
});
method(sliceClass, '__reduce__', 'none', 0, 0, (self) => {
  const slice = self as PySlice;
  return newTuple([sliceClass, newTuple([slice.start, slice.stop, slice.step])]);
});

method(builtinFunctionClass, '__reduce__', 'none', 0, 0, (self) => reduceBuiltin(self as PyBuiltinFunction));
for (const cls of [methodDescriptorClass, wrapperDescriptorClass, methodWrapperClass]) {
  method(cls, '__reduce__', 'none', 0, 0, (self) => reduceBuiltin(self as PyBuiltinFunction));
}

method(memberDescriptorClass, '__reduce__', 'none', 0, 0, (self) => {
  const { owner, name } = self as PyAttribute;
  return newTuple([currentRuntime().builtins.get('getattr') as PyValue, newTuple([owner, name])]);
});

/** A module's builtin function reduces to its name; a method to `getattr` of its object or class. */
function reduceBuiltin(fn: PyBuiltinFunction): PyValue {
  const getattr = currentRuntime().builtins.get('getattr') as PyValue;
  if (fn.self !== undefined && fn.self !== None && !(fn.self instanceof PyModule)) {
    return newTuple([getattr, newTuple([fn.self, fn.name])]);
  }
  const owner = fn.ownerName === undefined ? undefined : currentRuntime().builtins.get(fn.ownerName);
  if (owner instanceof PyClass) return newTuple([getattr, newTuple([owner, fn.name])]);
  return fn.name;
}
method(methodClass, '__reduce__', 'none', 0, 0, (self) => {
  const bound = self as PyBoundMethod;
  return newTuple([
    currentRuntime().builtins.get('getattr') as PyValue,
    newTuple([bound.self, getAttribute(bound.fn, '__name__')]),
  ]);
});

method(baseExceptionClass, '__reduce__', 'none', 0, 0, (self) => {
  const args = getAttribute(self, 'args');
  const dict = ownDict(self);
  if (dict === undefined || dict.size === 0) return newTuple([classOf(self), args]);
  return newTuple([classOf(self), args, getAttribute(self, '__dict__')]);
});
method(baseExceptionClass, '__setstate__', 'one', 1, 1, (self, [state]) => {
  if (state === None) return None;
  if (!(state instanceof PyDict)) throw typeError('state is not a dictionary');
  for (const entry of state.store.ordered()) currentRuntime().setAttributeOf(self, entry.key as string, entry.value);
  return None;
});
