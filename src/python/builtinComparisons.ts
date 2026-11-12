import { method } from './define';
import { nativeCompare } from './operators';
import {
  complexClass,
  dictClass,
  floatClass,
  frozensetClass,
  intClass,
  listClass,
  NotImplemented,
  rangeClass,
  setClass,
  strClass,
  tupleClass,
} from './types';
import { type PyClass, PyComplex, PyDict, PyList, PyRange, PySet, PyTuple, type PyValue } from './values';

const COMPARISONS = [
  ['__eq__', '=='],
  ['__ne__', '!='],
  ['__lt__', '<'],
  ['__le__', '<='],
  ['__gt__', '>'],
  ['__ge__', '>='],
] as const;

const isInt = (value: PyValue): boolean => typeof value === 'bigint' || typeof value === 'boolean';
const isReal = (value: PyValue): boolean => isInt(value) || typeof value === 'number';

/**
 * The comparison methods each builtin type defines, which answer for the other operands the type compares with and
 * return NotImplemented for the rest, as CPython's slots do; the operators reach the same comparisons natively.
 */
const COMPARABLE: [cls: PyClass, accepts: (other: PyValue) => boolean, ordered: boolean][] = [
  [intClass, isInt, true],
  [floatClass, isReal, true],
  [complexClass, (other) => isReal(other) || other instanceof PyComplex, false],
  [strClass, (other) => typeof other === 'string', true],
  [listClass, (other) => other instanceof PyList, true],
  [tupleClass, (other) => other instanceof PyTuple, true],
  [dictClass, (other) => other instanceof PyDict, false],
  [setClass, (other) => other instanceof PySet, true],
  [frozensetClass, (other) => other instanceof PySet, true],
  [rangeClass, (other) => other instanceof PyRange, false],
];

for (const [cls, accepts, ordered] of COMPARABLE) {
  for (const [name, operator] of COMPARISONS) {
    method(cls, name, 'one', 1, 1, (self, [other]) => {
      if (!accepts(other) || (!ordered && operator !== '==' && operator !== '!=')) return NotImplemented;
      return nativeCompare(operator, self, other);
    });
  }
}
