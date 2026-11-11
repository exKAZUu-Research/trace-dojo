import { pyRepr } from './conversions';
import { method } from './define';
import { defineNew } from './instances';
import { checkArgs } from './nativeArgs';
import { callValue, setAttribute } from './objects';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import { builtinClass, newTuple, NotImplemented, propertyClass, typingClass } from './types';
import { PyBuiltinFunction, PyClass, PyDescriptor, PyError, PyOpaque, PyTuple, type PyValue } from './values';

/** A `types.GenericAlias`, such as `list[int]`: its text, its origin (as `data`), and its arguments. */
export class PyGenericAlias extends PyOpaque {
  constructor(
    text: string,
    origin: PyValue,
    readonly args: readonly PyValue[],
    cls: PyClass = typingClass
  ) {
    super(cls, text, origin);
  }
}

/** `origin[key]` for a class whose subscription CPython implements with `types.GenericAlias`. */
export function genericAlias(origin: PyValue, key: PyValue, cls: PyClass = typingClass): PyGenericAlias {
  const args = key instanceof PyTuple ? key.items : [key];
  const text = `${aliasArgumentText(origin)}[${args.map(aliasArgumentText).join(', ')}]`;
  return new PyGenericAlias(text, origin, args, cls);
}

/** `typing._type_repr`. */
function aliasArgumentText(value: PyValue): string {
  if (value instanceof PyClass) {
    return value.module === 'builtins' ? value.qualifiedName : `${value.module}.${value.qualifiedName}`;
  }
  return value instanceof PyOpaque ? value.text : pyRepr(value);
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
property('__args__', (self) => newTuple([...self.args]));
property('__unpacked__', () => false);
method(typingClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(self instanceof PyGenericAlias) || !(other instanceof PyGenericAlias)) return NotImplemented;
  return (
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
