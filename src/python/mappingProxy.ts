import { pyRepr, pyStr } from './conversions';
import { method } from './define';
import { pyHash } from './hashing';
import { getItem } from './items';
import { callValue, getAttribute, getIterator, lengthOf, lookupSpecial } from './objects';
import { binaryOp, compareOp, contains } from './operators';
import { builtinClass, typeError, typeName } from './types';
import { PyDict, PyOpaque, type PyValue } from './values';

/** `types.MappingProxyType`, a read-only view of a mapping, which a class's `__dict__` also is. */
export const mappingProxyClass = builtinClass('mappingproxy');

export function newMappingProxy(mapping: PyValue): PyOpaque {
  return new PyOpaque(mappingProxyClass, 'mappingproxy', mapping);
}

const mappingOf = (self: PyValue): PyValue => (self as PyOpaque).data as PyValue;

mappingProxyClass.construct = (_cls, args, kwargs) => {
  if (kwargs !== undefined && kwargs.size > 0) throw typeError('mappingproxy() takes no keyword arguments');
  if (args.length !== 1) throw typeError(`mappingproxy() takes exactly one argument (${args.length} given)`);
  const [mapping] = args;
  const isMapping = mapping instanceof PyDict || lookupSpecial(mapping, 'keys') !== undefined;
  if (!isMapping || lookupSpecial(mapping, '__getitem__') === undefined) {
    throw typeError(`mappingproxy() argument must be a mapping, not ${typeName(mapping)}`);
  }
  return newMappingProxy(mapping);
};

const callOnMapping = (self: PyValue, name: string, args: PyValue[]): PyValue =>
  callValue(getAttribute(mappingOf(self), name), args);

method(mappingProxyClass, '__repr__', 'none', 0, 0, (self) => `mappingproxy(${pyRepr(mappingOf(self))})`);
method(mappingProxyClass, '__str__', 'none', 0, 0, (self) => pyStr(mappingOf(self)));
method(mappingProxyClass, '__getitem__', 'one', 1, 1, (self, [key]) => getItem(mappingOf(self), key));
method(mappingProxyClass, '__contains__', 'one', 1, 1, (self, [key]) => contains(mappingOf(self), key));
method(mappingProxyClass, '__len__', 'none', 0, 0, (self) => BigInt(lengthOf(mappingOf(self))));
method(mappingProxyClass, '__iter__', 'none', 0, 0, (self) => getIterator(mappingOf(self)));
method(mappingProxyClass, '__reversed__', 'none', 0, 0, (self) => callOnMapping(self, '__reversed__', []));
method(mappingProxyClass, 'get', 'expected', 1, 2, (self, args) => callOnMapping(self, 'get', args));
for (const name of ['keys', 'values', 'items', 'copy']) {
  method(mappingProxyClass, name, 'none', 0, 0, (self) => callOnMapping(self, name, []));
}
for (const [name, operator] of [
  ['__eq__', '=='],
  ['__ne__', '!='],
  ['__lt__', '<'],
  ['__le__', '<='],
  ['__gt__', '>'],
  ['__ge__', '>='],
] as const) {
  method(mappingProxyClass, name, 'one', 1, 1, (self, [other]) => compareOp(operator, mappingOf(self), other));
}
method(mappingProxyClass, '__or__', 'one', 1, 1, (self, [other]) =>
  other instanceof PyOpaque && other.cls === mappingProxyClass
    ? binaryOp('|', mappingOf(self), mappingOf(other))
    : binaryOp('|', mappingOf(self), other)
);
method(mappingProxyClass, '__ror__', 'one', 1, 1, (self, [other]) => binaryOp('|', other, mappingOf(self)));
method(mappingProxyClass, '__ior__', 'one', 1, 1, () => {
  throw typeError("'|=' is not supported by mappingproxy; use '|' instead");
});
method(mappingProxyClass, '__hash__', 'none', 0, 0, (self) => pyHash(mappingOf(self)));
