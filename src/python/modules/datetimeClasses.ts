import { method } from '../define';
import { nativeFunction, objectClass, propertyClass, typeClass } from '../types';
import { PyClass, PyDescriptor, type PyValue } from '../values';

/** A class of the `datetime` module, which programs may subclass and whose messages call it `datetime.<name>`. */
export function datetimeClass(name: string, base: PyClass = objectClass): PyClass {
  const cls = new PyClass(name, [base], typeClass);
  cls.mro = [cls, ...base.mro];
  cls.module = 'datetime';
  cls.typeName = `datetime.${name}`;
  cls.isBaseType = true;
  cls.construct = base.construct;
  return cls;
}

/** Defines read-only attributes computed from the instance, as C getters are. */
export function defineGetters(cls: PyClass, getters: Record<string, (self: PyValue) => PyValue>): void {
  for (const [name, getter] of Object.entries(getters)) {
    const fn = nativeFunction(name, ([self]) => getter(self), cls.name);
    cls.dict.set(name, new PyDescriptor(propertyClass, fn));
  }
}

export function defineConstants(cls: PyClass, constants: () => Record<string, PyValue>): void {
  for (const [name, value] of Object.entries(constants())) cls.dict.set(name, value);
}

const ORDERINGS = [
  ['__eq__', (order: number) => order === 0],
  ['__ne__', (order: number) => order !== 0],
  ['__lt__', (order: number) => order < 0],
  ['__le__', (order: number) => order <= 0],
  ['__gt__', (order: number) => order > 0],
  ['__ge__', (order: number) => order >= 0],
] as const;

/**
 * Defines the six comparisons from `compare`, which gives the sign of `self - other`, or the result itself:
 * NotImplemented for another type, or the answer of `==` and `!=` between a naive and an aware value.
 */
export function defineComparisons(
  cls: PyClass,
  compare: (self: PyValue, other: PyValue, name: (typeof ORDERINGS)[number][0]) => number | PyValue
): void {
  for (const [name, test] of ORDERINGS) {
    method(cls, name, 'one', 1, 1, (self, [other]) => {
      const order = compare(self, other, name);
      return typeof order === 'number' ? test(order) : order;
    });
  }
}

export function signOf(difference: bigint): number {
  if (difference === 0n) return 0;
  return difference < 0n ? -1 : 1;
}

export { defineValueHash as valueHash } from '../slotWrappers';
