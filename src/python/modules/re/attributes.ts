import { builtinClass, nativeFunction, propertyClass } from '../../types';
import { PyBuiltinFunction, type PyClass, PyDescriptor, type PyValue } from '../../values';

/** The class of `_sre`'s struct members, whose assignment CPython rejects with "readonly attribute". */
const memberDescriptorClass = builtinClass('member_descriptor');

/**
 * Defines a read-only attribute: a struct member such as `Match.string`, or a computed attribute such as
 * `Match.lastindex`, whose assignment errors differ.
 */
export function readOnlyAttribute(
  cls: PyClass,
  name: string,
  kind: 'member' | 'getset',
  get: (self: PyValue) => PyValue
): void {
  const getter =
    kind === 'member'
      ? new PyBuiltinFunction(memberDescriptorClass, name, ([self]) => get(self))
      : nativeFunction(name, ([self]) => get(self));
  cls.dict.set(name, new PyDescriptor(propertyClass, getter));
}
