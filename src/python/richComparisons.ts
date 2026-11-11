import { method } from './define';
import { pyHash } from './hashing';
import { compareOp } from './operators';
import {
  classOf,
  complexClass,
  floatClass,
  intClass,
  memoryviewClass,
  newTuple,
  NotImplemented,
  rangeClass,
  sliceClass,
} from './types';
import { type PyClass, PyComplex, PyRange, PySlice, type PyValue } from './values';

// The comparison methods of the builtin types whose C type defines tp_richcompare, which gives every type all six.

const ORDERINGS: [string, '<' | '<=' | '>' | '>='][] = [
  ['__lt__', '<'],
  ['__le__', '<='],
  ['__gt__', '>'],
  ['__ge__', '>='],
];

/** Defines the comparisons a type lacks: equality as `equal` tells, and orderings, which only slices have. */
function defineComparisons(
  cls: PyClass,
  equal?: (self: PyValue, other: PyValue) => boolean | typeof NotImplemented
): void {
  if (equal) {
    method(cls, '__eq__', 'one', 1, 1, (self, [other]) => equal(self, other));
    method(cls, '__ne__', 'one', 1, 1, (self, [other]) => {
      const result = equal(self, other);
      return result === NotImplemented ? result : !result;
    });
  }
  for (const [name, operator] of ORDERINGS) {
    if (cls.dict.has(name)) continue;
    method(cls, name, 'one', 1, 1, (self, [other]) =>
      cls === sliceClass && other instanceof PySlice
        ? compareOp(operator, sliceKey(self), sliceKey(other))
        : NotImplemented
    );
  }
}

function sliceKey(value: PyValue): PyValue {
  const { start, stop, step } = value as PySlice;
  return newTuple([start, stop, step]);
}

defineComparisons(complexClass, (self, other) => {
  const { real, imag } = self as PyComplex;
  if (other instanceof PyComplex) return real === other.real && imag === other.imag;
  const kind = classOf(other);
  if (!kind.isSubclassOf(intClass) && !kind.isSubclassOf(floatClass)) return NotImplemented;
  return imag === 0 && compareOp('==', real, other) === true;
});
defineComparisons(rangeClass, (self, other) => {
  if (!(other instanceof PyRange)) return NotImplemented;
  const left = self as PyRange;
  if (left.length !== other.length) return false;
  if (left.length === 0n) return true;
  return left.start === other.start && (left.length === 1n || left.step === other.step);
});
defineComparisons(sliceClass, (self, other) =>
  other instanceof PySlice ? compareOp('==', sliceKey(self), sliceKey(other)) === true : NotImplemented
);
defineComparisons(memoryviewClass);
for (const cls of [complexClass, rangeClass, sliceClass]) {
  if (!cls.dict.has('__hash__')) method(cls, '__hash__', 'none', 0, 0, (self) => pyHash(self));
}
