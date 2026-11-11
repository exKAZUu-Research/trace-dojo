// Gives the builtin types the special methods of their operators, which instances of a program's subclasses reach
// through the classes' dictionaries, as `super().__add__(other)` and the operators on such instances do.
import type { BinaryOperator } from './ast';
import { method } from './define';
import { divmodFloat, floorDivInt, modInt } from './numbers';
import {
  builtinSlots,
  COMPARE_NAMES,
  nativeBinary,
  nativeCompare,
  nativeInplace,
  nativeUnary,
  SPECIAL_NAMES,
} from './operators';
import { formatPercent } from './percentFormat';
import {
  complexClass,
  dictClass,
  floatClass,
  frozensetClass,
  intClass,
  listClass,
  newTuple,
  NotImplemented,
  setClass,
  strClass,
  tupleClass,
  typeError,
  typeName,
  unbox,
} from './types';
import { type PyClass, PyComplex, PyDict, PyList, PySet, PyTuple, type PyValue } from './values';

type Accepts = (value: PyValue) => boolean;
type Slot = (self: PyValue, other: PyValue) => PyValue;

const isInt: Accepts = (value) => typeof value === 'bigint' || typeof value === 'boolean';
const isReal: Accepts = (value) => isInt(value) || typeof value === 'number';
const isComplexOperand: Accepts = (value) => isReal(value) || value instanceof PyComplex;
const isStr: Accepts = (value) => typeof value === 'string';
const isList: Accepts = (value) => value instanceof PyList;
const isTuple: Accepts = (value) => value instanceof PyTuple;
const isSet: Accepts = (value) => value instanceof PySet;
const isDict: Accepts = (value) => value instanceof PyDict;

const ARITHMETIC: BinaryOperator[] = ['+', '-', '*', '/', '//', '%', '**'];
const BITWISE: BinaryOperator[] = ['<<', '>>', '&', '|', '^'];
const ORDERING = ['<', '<=', '>', '>=', '==', '!='] as const;

/** Defines a special method whose slot the operators call, and which a program may call itself as `direct`. */
function defineSlot(cls: PyClass, name: string, slot: Slot, direct: Slot = slot): void {
  method(cls, name, 'one', 1, 1, (self, [other]) => direct(self, other));
  builtinSlots.set(cls.dict.get(name) as PyValue, slot);
}

/** An operator's method and its reflected method, for operands of the types `accepts` admits. */
function defineOperator(cls: PyClass, operator: BinaryOperator, accepts: Accepts): void {
  const [name, reflected] = SPECIAL_NAMES[operator];
  defineSlot(cls, name, (self, other) => {
    const value = unbox(other);
    return accepts(value) ? nativeBinary(operator, unbox(self), value) : NotImplemented;
  });
  defineSlot(cls, reflected, (self, other) => {
    const value = unbox(other);
    return accepts(value) ? nativeBinary(operator, value, unbox(self)) : NotImplemented;
  });
}

function defineComparisons(cls: PyClass, accepts: Accepts, operators: readonly (keyof typeof COMPARE_NAMES)[]): void {
  for (const operator of operators) {
    defineSlot(cls, COMPARE_NAMES[operator][0], (self, other) => {
      const value = unbox(other);
      return accepts(value) ? nativeCompare(operator, unbox(self), value) : NotImplemented;
    });
  }
}

function defineUnary(cls: PyClass): void {
  for (const [operator, name] of [
    ['-', '__neg__'],
    ['+', '__pos__'],
    ['~', '__invert__'],
  ] as const) {
    if (operator === '~' && cls !== intClass) continue;
    method(cls, name, 'none', 0, 0, (self) => nativeUnary(operator, unbox(self)));
  }
}

// Numbers -----------------------------------------------------------------------------------------------------------

for (const [cls, accepts, operators] of [
  [intClass, isInt, [...ARITHMETIC, ...BITWISE]],
  [floatClass, isReal, ARITHMETIC],
  [complexClass, isComplexOperand, ['+', '-', '*', '/', '**']],
] as const) {
  for (const operator of operators) defineOperator(cls, operator, accepts);
  defineComparisons(cls, accepts, cls === complexClass ? ['==', '!='] : ORDERING);
  defineUnary(cls);
}

for (const [cls, accepts] of [
  [intClass, isInt],
  [floatClass, isReal],
] as const) {
  defineSlot(cls, '__divmod__', (self, other) => divmodOf(unbox(self), unbox(other), accepts));
  defineSlot(cls, '__rdivmod__', (self, other) => divmodOf(unbox(other), unbox(self), accepts));
}

function divmodOf(a: PyValue, b: PyValue, accepts: Accepts): PyValue {
  if (!accepts(a) || !accepts(b)) return NotImplemented;
  const [x, y] = [a as bigint | number | boolean, b as bigint | number | boolean];
  if (isInt(x) && isInt(y)) return newTuple([floorDivInt(BigInt(x), BigInt(y)), modInt(BigInt(x), BigInt(y))]);
  return newTuple(divmodFloat(Number(x), Number(y)));
}

// Sequences ---------------------------------------------------------------------------------------------------------

for (const [cls, accepts] of [
  [strClass, isStr],
  [listClass, isList],
  [tupleClass, isTuple],
] as const) {
  const concatenate: Slot = (self, other) => {
    const value = unbox(other);
    return accepts(value) ? nativeBinary('+', unbox(self), value) : NotImplemented;
  };
  defineSlot(cls, '__add__', concatenate, (self, other) => {
    const result = concatenate(self, other);
    if (result !== NotImplemented) return result;
    throw typeError(`can only concatenate ${cls.name} (not "${typeName(other)}") to ${cls.name}`);
  });
  const repeat: Slot = (self, other) => {
    const count = unbox(other);
    return isInt(count) ? nativeBinary('*', unbox(self), count) : NotImplemented;
  };
  const repeatDirectly: Slot = (self, other) => {
    const result = repeat(self, other);
    if (result !== NotImplemented) return result;
    throw typeError(`'${typeName(other)}' object cannot be interpreted as an integer`);
  };
  defineSlot(cls, '__mul__', repeat, repeatDirectly);
  defineSlot(cls, '__rmul__', repeat, repeatDirectly);
  defineComparisons(cls, accepts, ORDERING);
}
defineSlot(strClass, '__mod__', (self, other) => formatPercent(unbox(self) as string, other));
defineSlot(strClass, '__rmod__', (self, other) =>
  isStr(unbox(other)) ? formatPercent(unbox(other) as string, self) : NotImplemented
);
for (const [name, operator] of [
  ['__iadd__', '+'],
  ['__imul__', '*'],
] as const) {
  defineSlot(listClass, name, (self, other) => nativeInplace(operator, self, other));
}

// Sets and dicts ----------------------------------------------------------------------------------------------------

for (const cls of [setClass, frozensetClass]) {
  for (const operator of ['|', '&', '-', '^'] as const) defineOperator(cls, operator, isSet);
  defineComparisons(cls, isSet, ORDERING);
}
for (const operator of ['|', '&', '-', '^'] as const) {
  defineSlot(setClass, SPECIAL_NAMES[operator][2], (self, other) =>
    isSet(other) ? nativeInplace(operator, self, other) : NotImplemented
  );
}
defineOperator(dictClass, '|', isDict);
defineSlot(dictClass, '__ior__', (self, other) => nativeInplace('|', self, other));
defineComparisons(dictClass, isDict, ['==', '!=']);
