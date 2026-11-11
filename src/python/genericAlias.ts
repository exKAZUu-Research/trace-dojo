import { pyRepr } from './conversions';
import { method } from './define';
import { defineNew } from './instances';
import { checkArgs } from './nativeArgs';
import { callValue, getIterator, setAttribute } from './objects';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import { typeAliasClass } from './typeParams';
import {
  builtinClass,
  Ellipsis,
  newTuple,
  None,
  NotImplemented,
  propertyClass,
  typingClass,
  unionClass,
} from './types';
import {
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyError,
  PyList,
  PyObject,
  PyOpaque,
  PyTuple,
  type PyValue,
} from './values';

/** A `types.GenericAlias`, such as `list[int]`: its text, its origin (as `data`), and its arguments. */
export class PyGenericAlias extends PyOpaque {
  constructor(
    text: string,
    origin: PyValue,
    readonly args: readonly PyValue[],
    cls: PyClass = typingClass,
    /** Whether the alias is unpacked, as `*tuple[int]` is. */
    readonly unpacked = false
  ) {
    super(cls, text, origin);
  }
}

/** `origin[key]` for a class whose subscription CPython implements with `types.GenericAlias`. */
export function genericAlias(origin: PyValue, key: PyValue, cls: PyClass = typingClass): PyGenericAlias {
  const args = key instanceof PyTuple ? key.items : [key];
  return new PyGenericAlias(aliasText(origin, args), origin, args, cls);
}

function aliasText(origin: PyValue, args: readonly PyValue[]): string {
  return `${aliasArgumentText(origin)}[${args.map(aliasArgumentText).join(', ')}]`;
}

/** `typing._type_repr`, which reads the repr of an argument each time, as it may change. */
export function aliasArgumentText(value: PyValue): string {
  if (value instanceof PyClass) {
    return value.module === 'builtins' ? value.qualifiedName : `${value.module}.${value.qualifiedName}`;
  }
  if (value instanceof PyGenericAlias)
    return `${value.unpacked ? '*' : ''}${aliasText(value.data as PyValue, value.args)}`;
  if (value === Ellipsis) return '...';
  if (value instanceof PyList) return `[${value.items.map(aliasArgumentText).join(', ')}]`;
  return value instanceof PyOpaque ? value.text : pyRepr(value);
}

/** Whether `|` makes a union of a value, as `types.UnionType` accepts: None, a type, an alias, or a union. */
export function isUnionable(value: PyValue): boolean {
  if (value === None || value instanceof PyClass) return true;
  return (
    value instanceof PyObject && (value.cls === typingClass || value.cls === unionClass || value.cls === typeAliasClass)
  );
}

typingClass.isBaseType = true;
defineNew(typingClass, (cls, args, kwargs) => {
  checkArgs({ qualified: 'GenericAlias', min: 2, max: 2, style: 'expected' }, args, kwargs);
  return genericAlias(args[0], args[1], cls);
});

function property(name: string, get: (self: PyGenericAlias) => PyValue): void {
  const getter = new PyBuiltinFunction(builtinClass('getter'), name, ([self]) => get(self as PyGenericAlias));
  typingClass.dict.set(name, new PyDescriptor(propertyClass, getter));
}

property('__origin__', (self) => self.data as PyValue);
method(typingClass, '__repr__', 'none', 0, 0, (self) => aliasArgumentText(self));
property('__args__', (self) => newTuple([...self.args]));
property('__unpacked__', (self) => self.unpacked);
// Iterating an alias gives it unpacked once, as `*tuple[int]` does.
method(typingClass, '__iter__', 'none', 0, 0, (self) => {
  const alias = self as PyGenericAlias;
  const unpacked = new PyGenericAlias(alias.text, alias.data as PyValue, alias.args, alias.cls, true);
  return getIterator(newTuple([unpacked]));
});
method(typingClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(self instanceof PyGenericAlias) || !(other instanceof PyGenericAlias)) return NotImplemented;
  return (
    self.unpacked === other.unpacked &&
    equals(self.data as PyValue, other.data as PyValue) &&
    self.args.length === other.args.length &&
    self.args.every((arg, index) => equals(arg, other.args[index]))
  );
});
method(typingClass, '__hash__', 'none', 0, 0, (self) => {
  const alias = self as PyGenericAlias;
  const runtime = currentRuntime();
  return runtime.hashOf(alias.data as PyValue) ^ runtime.hashOf(newTuple([...alias.args]));
});
// Calling an alias creates an instance of its origin and records the alias on it, when the instance accepts that.
method(typingClass, '__call__', 'expected', 0, Number.POSITIVE_INFINITY, (self, args, kwargs) => {
  const result = callValue((self as PyGenericAlias).data as PyValue, args, kwargs);
  try {
    setAttribute(result, '__orig_class__', self);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
  }
  return result;
});
