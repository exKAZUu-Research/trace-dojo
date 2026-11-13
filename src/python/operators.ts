// code-gauge-allow-file fileNcss 707 -- The operator implementations of the builtin types belong together.
import type { BinaryOperator, CompareOperator } from './ast';
import { isBytesLike, PyBytes } from './bytesValues';
import { complexBinary, isComplexOperand, newComplex } from './complexNumbers';
import { floatPower } from './floatPower';
import { asFloat, divmodFloat, floorDivInt, intToFloat, modInt, toIndex, trueDivideInt } from './numbers';
import {
  bindValue,
  callSpecial,
  callValue,
  iterate,
  iterateOr,
  lookupSpecial,
  type NextFunction,
  overriding,
} from './objects';
import { formatPercent } from './percentFormat';
import { chargeStep, currentRuntime } from './runtimeContext';
import {
  dictViewBinary,
  differenceUpdate,
  isSetLikeView,
  isSubset,
  lookupSetKey,
  setIntersection,
  symmetricDifferenceUpdate,
  updateTable,
} from './setOperations';
import { repeatText } from './stringBuilder';
import { compareStr, strLength } from './strings';
import { containsStr } from './strSearch';
import {
  classOf,
  dictClass,
  frozensetClass,
  intClass,
  newDict,
  newList,
  newTuple,
  NotImplemented,
  objectClass,
  pyError,
  strClass,
  tupleClass,
  typeError,
  typeName,
  unbox,
} from './types';
import {
  DONE,
  type PyClass,
  PyComplex,
  PyDeque,
  PyDict,
  PyDictView,
  PyInstance,
  PyList,
  PyObject,
  PyRange,
  PySet,
  PyTuple,
  type PyValue,
} from './values';

export const SPECIAL_NAMES: Record<BinaryOperator, [string, string, string]> = {
  '+': ['__add__', '__radd__', '__iadd__'],
  '-': ['__sub__', '__rsub__', '__isub__'],
  '*': ['__mul__', '__rmul__', '__imul__'],
  '/': ['__truediv__', '__rtruediv__', '__itruediv__'],
  '//': ['__floordiv__', '__rfloordiv__', '__ifloordiv__'],
  '%': ['__mod__', '__rmod__', '__imod__'],
  '**': ['__pow__', '__rpow__', '__ipow__'],
  '@': ['__matmul__', '__rmatmul__', '__imatmul__'],
  '<<': ['__lshift__', '__rlshift__', '__ilshift__'],
  '>>': ['__rshift__', '__rrshift__', '__irshift__'],
  '&': ['__and__', '__rand__', '__iand__'],
  '|': ['__or__', '__ror__', '__ior__'],
  '^': ['__xor__', '__rxor__', '__ixor__'],
};

type Numeric = bigint | number | boolean;

function isNumeric(value: PyValue): value is Numeric {
  return typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean';
}

function asInt(value: bigint | boolean): bigint {
  return typeof value === 'boolean' ? (value ? 1n : 0n) : value;
}

/**
 * The special methods of builtin types, by the function in their class's dictionary, as the slots CPython's operators
 * call: they return NotImplemented for an operand of another type where calling the method itself may raise.
 */
export const builtinSlots = new Map<PyValue, (self: PyValue, other: PyValue) => PyValue>();

/** Whether a value's class is builtin, so that its operators are the builtin ones. */
function isPlain(value: PyValue): boolean {
  return typeof value !== 'object' || value.cls.isBuiltin;
}

/** Calls a special method found on an operand's class, through its slot when it is a builtin type's. */
function callSlot(method: PyValue, self: PyValue, other: PyValue): PyValue {
  const slot = builtinSlots.get(method);
  return slot === undefined ? callValue(bindValue(method, self), [other]) : slot(self, other);
}

/** Python's binary operators. */
export function binaryOp(operator: BinaryOperator, leftValue: PyValue, rightValue: PyValue): PyValue {
  if (typeof leftValue !== 'object' && typeof rightValue !== 'object') {
    const native = nativeBinary(operator, leftValue, rightValue);
    return native === NotImplemented ? dispatchOrRaise(operator, leftValue, rightValue, false) : native;
  }
  // The bitwise operators of a Flag combine its members into members, before an IntFlag counts as an int.
  if ('|&^'.includes(operator) && (isFlagMember(leftValue) || isFlagMember(rightValue))) {
    const combined = dispatchBinary(operator, leftValue, rightValue, false);
    if (combined !== NotImplemented) return combined;
  }
  const left = intEnumValue(leftValue);
  // A str template formats an enum member itself, whose str() and repr() differ from its value's.
  const right = operator === '%' && typeof left === 'string' ? rightValue : intEnumValue(rightValue);
  if (isPlain(left) && isPlain(right)) {
    const native = nativeBinary(operator, left, right);
    if (native !== NotImplemented) return native;
  }
  return dispatchOrRaise(operator, left, right, false);
}

function dispatchOrRaise(operator: BinaryOperator, left: PyValue, right: PyValue, isInplace: boolean): PyValue {
  const result = dispatchBinary(operator, left, right, isInplace);
  if (result !== NotImplemented) return result;
  throw binaryTypeError(operator, left, right, isInplace);
}

/** Python's augmented assignment operators, which try the in-place method first. */
// code-gauge-allow functionCognitiveComplexity 21 -- Follows CPython's augmented-assignment slot fallback order.
export function inplaceOp(operator: BinaryOperator, left: PyValue, right: PyValue): PyValue {
  if ((operator === '+' || operator === '*') && isMutableSequence(left)) return sequenceInplace(operator, left, right);
  if (typeof left === 'object' && left.cls.isBuiltin) {
    const native = nativeInplace(operator, left, right);
    if (native !== NotImplemented) return native;
  }
  // A builtin type without a native in-place operator, such as deque, may define the method.
  const method = lookupSpecial(left, SPECIAL_NAMES[operator][2]);
  if (method !== undefined) {
    const result = callSlot(method, left, right);
    if (result !== NotImplemented) return result;
  }
  if ('|&^'.includes(operator) && (isFlagMember(left) || isFlagMember(right))) {
    const combined = dispatchBinary(operator, left, right, true);
    if (combined !== NotImplemented) return combined;
  }
  const leftVal = intEnumValue(left);
  const rightVal = operator === '%' && typeof leftVal === 'string' ? right : intEnumValue(right);
  if (isPlain(leftVal) && isPlain(rightVal)) {
    const native = nativeBinary(operator, leftVal, rightVal);
    if (native !== NotImplemented) return native;
  }
  return dispatchOrRaise(operator, leftVal, rightVal, true);
}

function isMutableSequence(value: PyValue): value is PyList | PyDeque {
  return (value instanceof PyList || value instanceof PyDeque) && value.cls.isBuiltin;
}

/**
 * `+=` and `*=` of a list or deque. CPython keeps their in-place methods in sequence slots, which it asks only after
 * the reflected method of the other operand, and after which it does not fall back to the binary operator.
 */
function sequenceInplace(operator: '+' | '*', left: PyList | PyDeque, right: PyValue): PyValue {
  const [, reflected, inplace] = SPECIAL_NAMES[operator];
  if (!isPlain(right)) {
    const reflectedMethod = lookupSpecial(right, reflected);
    if (reflectedMethod !== undefined && reflectedMethod !== classOf(left).lookup(reflected)) {
      const result = callSlot(reflectedMethod, right, left);
      if (result !== NotImplemented) return result;
    }
  }
  const result =
    left instanceof PyList
      ? listInplace(operator, left, right)
      : callValue(bindValue(lookupSpecial(left, inplace) as PyValue, left), [right]);
  if (result !== NotImplemented) return result;
  throw binaryTypeError(operator, left, right, true);
}

function listInplace(operator: '+' | '*', list: PyList, other: PyValue): PyValue {
  if (operator === '+') {
    extendList(list, other);
    return list;
  }
  if (!isIntLike(other) && (isBuiltinSequence(other) || lookupSpecial(other, '__index__') === undefined)) {
    return NotImplemented;
  }
  const times = repeatCount(toIndex(other));
  if (times <= 0) list.replaceItems([]);
  else list.extend(repeatItems(list.items, times - 1));
  return list;
}

/** The in-place operators of the builtin mutable types, or NotImplemented for the others. */
export function nativeInplace(operator: BinaryOperator, left: PyValue, right: PyValue): PyValue {
  if (left instanceof PyList && (operator === '+' || operator === '*')) {
    return listInplace(operator, left, right);
  }
  if (left instanceof PySet && right instanceof PySet && !left.cls.isSubclassOf(frozensetClass)) {
    return inplaceSet(operator, left, right);
  }
  if (left instanceof PyDict && operator === '|' && inheritsDictSlot(left, '__ior__')) {
    // CPython updates through dict.update itself, whatever `update` a subclass defines.
    callValue(dictClass.dict.get('update') as PyValue, [left, right]);
    return left;
  }
  if (left instanceof PyBytes && left.isMutable) {
    const method = lookupSpecial(left, SPECIAL_NAMES[operator][2]);
    if (method !== undefined) return callSlot(method, left, right);
  }
  return NotImplemented;
}

/** `list += iterable` and `list.extend(iterable)`, which append each item as the iterable yields it. */
export function extendList(list: PyList, iterable: PyValue): void {
  // CPython copies the items of a list or tuple at once, so that `a.extend(a)` ends.
  if (iterable === list || ((iterable instanceof PyList || iterable instanceof PyTuple) && iterable.cls.isBuiltin)) {
    list.extend([...(iterable as PyList | PyTuple).items]);
    return;
  }
  const next = iterate(iterable);
  for (let item = next(); item !== DONE; item = next()) list.append(item);
}

/** The in-place set operators, which change the set's table as CPython does: that decides the order of its elements. */
function inplaceSet(operator: BinaryOperator, left: PySet, right: PySet): PyValue {
  switch (operator) {
    case '|': {
      updateTable(left.table, right);
      return left;
    }
    case '&': {
      left.table.adopt(setIntersection(left, right).table);
      return left;
    }
    case '-': {
      differenceUpdate(left.table, right);
      return left;
    }
    case '^': {
      symmetricDifferenceUpdate(left.table, right);
      return left;
    }
    default: {
      return NotImplemented;
    }
  }
}

function dispatchBinary(operator: BinaryOperator, left: PyValue, right: PyValue, isInplace: boolean): PyValue {
  if (operator === '*' && (isBuiltinSequence(left) || isBuiltinSequence(right))) {
    return dispatchRepeat(left, right, isInplace);
  }
  const [name, reflected] = SPECIAL_NAMES[operator];
  const leftMethod = lookupSpecial(left, name);
  const rightMethod = asksReflected(operator, left, right, isInplace) ? lookupSpecial(right, reflected) : undefined;
  if (rightMethod !== undefined && asksReflectedFirst(operator, left, right, reflected)) {
    const result = callSlot(rightMethod, right, left);
    if (result !== NotImplemented) return result;
    return leftMethod === undefined ? NotImplemented : callSlot(leftMethod, left, right);
  }
  if (leftMethod !== undefined) {
    const result = callSlot(leftMethod, left, right);
    if (result !== NotImplemented) return result;
  }
  if (rightMethod !== undefined) return callSlot(rightMethod, right, left);
  return NotImplemented;
}

/**
 * Whether the right operand's reflected method gets the first chance: a subclass's that overrides the base's, and any
 * before a sequence concatenates or repeats, which is not a numeric operator in CPython and raises where the operator
 * must go on.
 */
function asksReflectedFirst(operator: BinaryOperator, left: PyValue, right: PyValue, reflected: string): boolean {
  const isSequenceOperation =
    (operator === '+' && isBuiltinSequence(left)) ||
    ((operator === '+' || operator === '*') && left instanceof PyDeque);
  if (isSequenceOperation) return true;
  const leftClass = classOf(left);
  const rightClass = classOf(right);
  return (
    rightClass !== leftClass &&
    rightClass.isSubclassOf(leftClass) &&
    overridesReflected(leftClass, rightClass, reflected)
  );
}

/**
 * Whether a subclass's reflected method differs from the base's, which gives it the first call. A builtin base has a
 * native slot that a class's method always differs from; between classes, slot_nb_* asks method_is_overloaded.
 */
function overridesReflected(leftClass: PyClass, rightClass: PyClass, reflected: string): boolean {
  const right = rightClass.lookup(reflected);
  if (right === undefined) return false;
  return leftClass.lookup(reflected) !== right;
}

function asksReflected(operator: BinaryOperator, left: PyValue, right: PyValue, isInplace: boolean): boolean {
  if (classOf(left) === classOf(right)) return false;
  // `instance *= deque` does not repeat the deque: an instance of a class has sequence slots of its own.
  return !(isInplace && operator === '*' && right instanceof PyDeque && isUserObject(left));
}

/**
 * `sequence * other` where the native operation did not apply: the other operand's method decides, then its
 * `__index__`. The sequence's own `__mul__` is not asked, because it raises where the operator must go on.
 */
function dispatchRepeat(left: PyValue, right: PyValue, isInplace: boolean): PyValue {
  const isSequenceLeft = isBuiltinSequence(left);
  const [sequence, other] = isSequenceLeft ? [left, right] : [right, left];
  if (isBuiltinSequence(other)) return NotImplemented;
  const method = lookupSpecial(other, isSequenceLeft ? '__rmul__' : '__mul__');
  if (method !== undefined) {
    const result = callSlot(method, other, sequence);
    if (result !== NotImplemented) return result;
  }
  // `other *= sequence` repeats the sequence only for a number: an instance of a class has sequence slots of its own.
  if (isInplace && !isSequenceLeft && isUserObject(other)) return NotImplemented;
  if (lookupSpecial(other, '__index__') === undefined) return NotImplemented;
  return nativeBinary('*', sequence, toIndex(other));
}

function isBuiltinSequence(value: PyValue): boolean {
  return typeof value === 'string' || (isSequence(value) && value.cls.isBuiltin);
}

function binaryTypeError(operator: BinaryOperator, left: PyValue, right: PyValue, isInplace = false): Error {
  const base = sequenceTypeName(left);
  if (operator === '+' && base !== undefined && !isUserObject(right)) {
    return typeError(`can only concatenate ${base} (not "${typeName(right)}") to ${base}`);
  }
  // `*=` does not fall back to repeating the right operand when the left one is a container that cannot repeat.
  const repeatsRight = isSequenceLike(right) && !(isInplace && isUnrepeatableContainer(left));
  if (operator === '*' && (isSequenceLike(left) || repeatsRight)) {
    const other = isSequenceLike(left) ? right : left;
    return typeError(`can't multiply sequence by non-int of type '${typeName(other)}'`);
  }
  const shown = isInplace ? `${operator}=` : operator === '**' ? '** or pow()' : operator;
  return typeError(`unsupported operand type(s) for ${shown}: '${typeName(left)}' and '${typeName(right)}'`);
}

/** The name of the builtin sequence type a value is an instance of, which concatenation errors name. */
function sequenceTypeName(value: PyValue): string | undefined {
  if (typeof unbox(value) === 'string') return 'str';
  if (value instanceof PyList) return 'list';
  if (value instanceof PyTuple) return 'tuple';
  return undefined;
}

/** Whether a value is an instance of a class the program defined, whose special methods decide its operators. */
function isUserObject(value: PyValue): boolean {
  return value instanceof PyInstance && !classOf(value).isBuiltin;
}

function isSequence(value: PyValue): value is PyList | PyTuple {
  return value instanceof PyList || value instanceof PyTuple;
}

function isSequenceLike(value: PyValue): boolean {
  return typeof value === 'string' || isSequence(value) || value instanceof PyDeque;
}

function isUnrepeatableContainer(value: PyValue): boolean {
  return (
    value instanceof PyDict ||
    value instanceof PySet ||
    value instanceof PyDictView ||
    value instanceof PyRange ||
    value instanceof PyInstance
  );
}

/** The result of an operator on builtin operands, or NotImplemented when their types do not define it. */
// code-gauge-allow functionCognitiveComplexity 19 -- One case per builtin type that defines binary operators.
export function nativeBinary(operator: BinaryOperator, left: PyValue, right: PyValue): PyValue {
  if (isNumeric(left) && isNumeric(right)) return numericBinary(operator, left, right);
  if (isComplexOperand(left) && isComplexOperand(right) && (left instanceof PyComplex || right instanceof PyComplex)) {
    return complexBinary(operator, left, right);
  }
  if ((isSetLikeView(left) || isSetLikeView(right)) && '&|-^'.includes(operator)) {
    return dictViewBinary(operator as '&' | '|' | '-' | '^', left, right, viewContains);
  }
  if (typeof left === 'string') return stringBinary(operator, left, right);
  if (typeof right === 'string' && operator === '*' && isIntLike(left)) return repeatString(right, left);
  if (isSequence(left) && !isUserObject(left)) return sequenceBinary(operator, left, right);
  if (isSequence(right) && operator === '*' && isIntLike(left)) return repeatSequence(right, left);
  if (left instanceof PySet && right instanceof PySet) return setBinary(operator, left, right);
  return operator === '|' ? dictUnion(left, right) : NotImplemented;
}

/** `dict | dict`, unless a dict subclass such as Counter defines its own union, which then takes over. */
function dictUnion(left: PyValue, right: PyValue): PyValue {
  if (!(left instanceof PyDict && right instanceof PyDict)) return NotImplemented;
  if (!inheritsDictSlot(left, '__or__') || !inheritsDictSlot(right, '__ror__')) return NotImplemented;
  return mergeDicts(left, right);
}

/** Whether a dict's class takes dict's own method of this name, as opposed to one of a subclass like Counter. */
function inheritsDictSlot(value: PyDict, name: string): boolean {
  return value.cls === dictClass || value.cls.lookup(name) === dictClass.dict.get(name);
}

function stringBinary(operator: BinaryOperator, left: string, right: PyValue): PyValue {
  if (operator === '+' && typeof right === 'string') {
    currentRuntime().buildString(left.length + right.length);
    return left + right;
  }
  if (operator === '*' && isIntLike(right)) return repeatString(left, right);
  if (operator === '%' && !isUserObject(right)) return formatPercent(left, right);
  return NotImplemented;
}

function sequenceBinary(operator: BinaryOperator, left: PyList | PyTuple, right: PyValue): PyValue {
  if (operator === '+' && isSequence(right) && sameSequenceKind(left, right)) {
    const items = [...left.items, ...right.items];
    return left instanceof PyList ? newList(items) : newTuple(items);
  }
  if (operator === '*' && isIntLike(right)) return repeatSequence(left, right);
  return NotImplemented;
}

/** `dict | dict`, which gives a plain dict for subclasses that do not define the operator themselves. */
export function mergeDicts(left: PyDict, right: PyDict): PyDict {
  const result = newDict();
  for (const entry of left.store.ordered()) result.store.set(entry.key, entry.value);
  for (const entry of right.store.ordered()) result.store.set(entry.key, entry.value);
  return result;
}

function isIntLike(value: PyValue): value is bigint | boolean {
  return typeof value === 'bigint' || typeof value === 'boolean';
}

function repeatCount(count: PyValue): number {
  if (!isIntLike(count)) throw typeError(`can't multiply sequence by non-int of type '${typeName(count)}'`);
  const times = asInt(count);
  if (times >= 1n << 63n || times < -(1n << 63n)) {
    throw pyError('OverflowError', `cannot fit 'int' into an index-sized integer`);
  }
  return Number(times);
}

function repeatString(text: string, count: bigint | boolean): string {
  const times = repeatCount(count);
  return repeatText(text, times);
}

function repeatSequence(sequence: PyList | PyTuple, count: bigint | boolean): PyValue {
  const times = repeatCount(count);
  if (times === 1 && sequence.cls === tupleClass) return sequence;
  const items = repeatItems(sequence.items, times);
  return sequence instanceof PyList ? newList(items) : newTuple(items);
}

/** `rounds` copies of the items, refused before any copy is made when the program has no room for them. */
function repeatItems(items: readonly PyValue[], rounds: number): PyValue[] {
  const repeated: PyValue[] = [];
  if (items.length === 0 || rounds <= 0) return repeated;
  currentRuntime().ensureRoom(items.length * rounds);
  for (let round = 0; round < rounds; round++) for (const item of items) repeated.push(item);
  return repeated;
}

function setBinary(operator: BinaryOperator, left: PySet, right: PySet): PyValue {
  const runtime = currentRuntime();
  switch (operator) {
    case '|': {
      return runtime.setUnion(left, [right]);
    }
    case '&': {
      return runtime.setIntersection(left, right);
    }
    case '-': {
      return runtime.setDifference(left, right);
    }
    case '^': {
      return runtime.setSymmetricDifference(left, right);
    }
    default: {
      return NotImplemented;
    }
  }
}

// code-gauge-allow functionNcss 59 -- One case per operator for ints and floats.
// code-gauge-allow functionCognitiveComplexity 27 -- One case per operator for ints and floats.
function numericBinary(operator: BinaryOperator, left: Numeric, right: Numeric): PyValue {
  const runtime = currentRuntime();
  if (typeof left !== 'number' && typeof right !== 'number') {
    const a = asInt(left);
    const b = asInt(right);
    switch (operator) {
      case '+': {
        return a + b;
      }
      case '-': {
        return a - b;
      }
      case '*': {
        runtime.chargeBigint(a, b);
        return a * b;
      }
      case '/': {
        return trueDivideInt(a, b);
      }
      case '//': {
        return floorDivInt(a, b);
      }
      case '%': {
        return modInt(a, b);
      }
      case '**': {
        return powInt(a, b);
      }
      case '<<': {
        if (b < 0n) throw pyError('ValueError', 'negative shift count');
        runtime.chargeBits(BigInt(a.toString(2).length) + b);
        return a << b;
      }
      case '>>': {
        if (b < 0n) throw pyError('ValueError', 'negative shift count');
        return a >> b;
      }
      case '&': {
        return typeof left === 'boolean' && typeof right === 'boolean' ? left && right : a & b;
      }
      case '|': {
        return typeof left === 'boolean' && typeof right === 'boolean' ? left || right : a | b;
      }
      case '^': {
        return typeof left === 'boolean' && typeof right === 'boolean' ? left !== right : a ^ b;
      }
      default: {
        return NotImplemented;
      }
    }
  }
  const x = asFloat(left);
  const y = asFloat(right);
  switch (operator) {
    case '+': {
      return x + y;
    }
    case '-': {
      return x - y;
    }
    case '*': {
      return x * y;
    }
    case '/': {
      if (y === 0) throw pyError('ZeroDivisionError', 'division by zero');
      return x / y;
    }
    case '//': {
      return divmodFloat(x, y)[0];
    }
    case '%': {
      return divmodFloat(x, y)[1];
    }
    case '**': {
      return powFloat(x, y);
    }
    default: {
      return NotImplemented;
    }
  }
}

function powInt(base: bigint, exponent: bigint): PyValue {
  if (exponent < 0n) {
    if (base === 0n) throw pyError('ZeroDivisionError', 'zero to a negative power');
    return powFloat(intToFloat(base), Number(exponent));
  }
  if (base === 0n || base === 1n) return exponent === 0n ? 1n : base;
  if (base === -1n) return exponent % 2n === 0n ? 1n : -1n;
  const bits = BigInt(base.toString(2).length) * exponent;
  currentRuntime().chargeBits(bits);
  return base ** exponent;
}

/** Raises a float to a power as CPython's float_pow does, returning a complex for a negative base. */
export function powFloat(x: number, y: number): PyValue {
  if (y === 0) return 1;
  if (Number.isNaN(x)) return y === 0 ? 1 : x;
  if (Number.isNaN(y)) return x === 1 ? 1 : y;
  if (x === 0 && y < 0 && Number.isFinite(y)) throw pyError('ZeroDivisionError', 'zero to a negative power');
  if (x < 0 && Number.isFinite(x) && Number.isFinite(y) && !Number.isInteger(y)) {
    return complexBinary('**', newComplex(x, 0), y);
  }
  if (x === -1 && !Number.isFinite(y)) return 1;
  const result = floatPower(x, y);
  if (!Number.isFinite(result) && Number.isFinite(x) && Number.isFinite(y)) {
    throw pyError('OverflowError', "(34, 'Result too large')");
  }
  return result;
}

// Unary operators ---------------------------------------------------------------------------------------------------

const UNARY_NAMES = { '-': '__neg__', '+': '__pos__', '~': '__invert__' } as const;

export function unaryOp(operator: '-' | '+' | '~', operandValue: PyValue): PyValue {
  if (operator === '~' && isFlagMember(operandValue)) return callSpecial(operandValue, '__invert__', []);
  const operand = intEnumValue(operandValue);
  if (isPlain(operand)) {
    const native = nativeUnary(operator, operand);
    if (native !== NotImplemented) return native;
  }
  const method = lookupSpecial(operand, UNARY_NAMES[operator]);
  if (method !== undefined) return callValue(bindValue(method, operand), []);
  throw typeError(`bad operand type for unary ${operator}: '${typeName(operand)}'`);
}

/** The unary operators of the builtin numbers, or NotImplemented for any other operand. */
export function nativeUnary(operator: '-' | '+' | '~', operand: PyValue): PyValue {
  if (typeof operand === 'bigint' || typeof operand === 'boolean') {
    const value = asInt(operand);
    return operator === '-' ? -value : operator === '+' ? value : ~value;
  }
  if (operator === '~') return NotImplemented;
  if (typeof operand === 'number') return operator === '-' ? -operand : operand;
  if (!(operand instanceof PyComplex)) return NotImplemented;
  if (operator === '-') return newComplex(-operand.real, -operand.imag);
  return operand.cls.isBuiltin ? operand : newComplex(operand.real, operand.imag);
}

// Comparisons -------------------------------------------------------------------------------------------------------

export const COMPARE_NAMES: Record<'<' | '<=' | '>' | '>=' | '==' | '!=', [string, string]> = {
  '<': ['__lt__', '__gt__'],
  '<=': ['__le__', '__ge__'],
  '>': ['__gt__', '__lt__'],
  '>=': ['__ge__', '__le__'],
  '==': ['__eq__', '__eq__'],
  '!=': ['__ne__', '__ne__'],
};

/** Python's comparison operators, which may return any value from a rich comparison method. */
export function compareOp(operator: CompareOperator, left: PyValue, right: PyValue): PyValue {
  switch (operator) {
    case 'is': {
      return isSame(left, right);
    }
    case 'is not': {
      return !isSame(left, right);
    }
    case 'in': {
      return contains(right, left);
    }
    case 'not in': {
      return !contains(right, left);
    }
    default: {
      return richCompare(operator, intEnumValue(left), intEnumValue(right));
    }
  }
}

/** Python's `is`: identity for objects, and value identity for the immutable values this interpreter keeps unboxed. */
export function isSame(left: PyValue, right: PyValue): boolean {
  if (typeof left === 'number' && typeof right === 'number') return Object.is(left, right) || left === right;
  return left === right;
}

function richCompare(operator: keyof typeof COMPARE_NAMES, left: PyValue, right: PyValue): PyValue {
  if (isPlain(left) && isPlain(right)) {
    const native = nativeCompare(operator, left, right);
    if (native !== NotImplemented) return native;
  }
  const [name, reflected] = COMPARE_NAMES[operator];
  const leftClass = classOf(left);
  const rightClass = classOf(right);
  const rightFirst = rightClass !== leftClass && rightClass.isSubclassOf(leftClass);
  const attempts: [PyValue, string, PyValue][] = rightFirst
    ? [
        [right, reflected, left],
        [left, name, right],
      ]
    : [
        [left, name, right],
        [right, reflected, left],
      ];
  for (const [receiver, method, argument] of attempts) {
    const special = lookupSpecial(receiver, method);
    if (special === undefined) continue;
    const result = callSlot(special, receiver, argument);
    if (result !== NotImplemented) return result;
  }
  if (operator === '==') return left === right;
  if (operator === '!=') return left !== right;
  throw typeError(`'${operator}' not supported between instances of '${typeName(left)}' and '${typeName(right)}'`);
}

function isTruthyValue(value: PyValue): boolean {
  return currentRuntime().truthy(value);
}

// code-gauge-allow functionCognitiveComplexity 21 -- One case per kind of builtin value.
export function nativeCompare(operator: keyof typeof COMPARE_NAMES, left: PyValue, right: PyValue): PyValue {
  if (isNumeric(left) && isNumeric(right)) {
    const a = typeof left === 'boolean' ? Number(left) : left;
    const b = typeof right === 'boolean' ? Number(right) : right;
    return applyOrder(operator, a, b);
  }
  if (typeof left === 'string' && typeof right === 'string') return applyOrderValue(operator, compareStr(left, right));
  if (operator === '==' || operator === '!=') {
    const equal = nativeEquals(left, right);
    if (equal !== undefined) return operator === '==' ? equal : !equal;
  }
  if (isSequence(left) && isSequence(right) && sameSequenceKind(left, right)) {
    return compareSequences(operator, left.items, right.items);
  }
  if (left instanceof PySet && right instanceof PySet) return compareSets(operator, left, right);
  if (isSetLike(left) && isSetLike(right)) return compareSetLikeView(operator, left, right);
  return NotImplemented;
}

function applyOrder(operator: keyof typeof COMPARE_NAMES, a: bigint | number, b: bigint | number): boolean {
  switch (operator) {
    case '<': {
      return a < b;
    }
    case '<=': {
      return a <= b;
    }
    case '>': {
      return a > b;
    }
    case '>=': {
      return a >= b;
    }
    case '==': {
      // oxlint-disable-next-line eqeqeq -- Loose equality compares bigints and numbers by their exact values.
      return a == b;
    }
    default: {
      // oxlint-disable-next-line eqeqeq -- Loose equality compares bigints and numbers by their exact values.
      return a != b;
    }
  }
}

function applyOrderValue(operator: keyof typeof COMPARE_NAMES, order: number): boolean {
  return applyOrder(operator, order, 0);
}

/** Equality of builtin values whose types define it natively, or undefined to defer to `__eq__` and the containers. */
// code-gauge-allow functionCognitiveComplexity 28 -- One case per kind of builtin value.
function nativeEquals(left: PyValue, right: PyValue): boolean | undefined {
  if (definesEquality(left) || definesEquality(right) || isBytesLike(left) || isBytesLike(right)) return undefined;
  if (left instanceof PyComplex || right instanceof PyComplex) {
    if (!isComplexOperand(left) || !isComplexOperand(right)) return false;
    if (!(left instanceof PyComplex)) return complexEqualsReal(right as PyComplex, left);
    if (!(right instanceof PyComplex)) return complexEqualsReal(left, right);
    return left.real === right.real && left.imag === right.imag;
  }
  if (typeof left === 'string' || typeof right === 'string' || isNumeric(left) || isNumeric(right)) return false;
  if (left instanceof PyRange && right instanceof PyRange) return rangesEqual(left, right);
  if (left instanceof PyDict && right instanceof PyDict) return dictsEqual(left, right);
  if (left instanceof PyDictView || right instanceof PyDictView) return viewEquals(left, right);
  if (isSequence(left) && isSequence(right)) return sameSequenceKind(left, right) ? undefined : false;
  if (left instanceof PySet && right instanceof PySet) return undefined;
  // Another builtin object, such as a deque or type hint, compares by its own `__eq__`.
  if (builtinEquality(left) || builtinEquality(right)) return undefined;
  return left === right;
}

function builtinEquality(value: PyValue): boolean {
  return value instanceof PyObject && lookupSpecial(value, '__eq__') !== objectClass.dict.get('__eq__');
}

/** Whether a value is an instance whose class defines `==`, such as a program's class or `fractions.Fraction`. */
function definesEquality(value: PyValue): boolean {
  // A dict subclass such as Counter may compare its own way.
  if (value instanceof PyDict) return value.cls.lookup('__eq__') !== dictClass.dict.get('__eq__');
  if (!(value instanceof PyInstance)) return false;
  const cls = classOf(value);
  return !cls.isBuiltin || cls.lookup('__eq__') !== objectClass.dict.get('__eq__');
}

/** Equality with a dict view: keys and items views compare as sets with each other and with sets, values views by identity. */
function viewEquals(left: PyValue, right: PyValue): boolean {
  if (left === right) return true;
  if (!isSetLike(left) || !isSetLike(right)) return false;
  return compareSetLikeView('==', left, right);
}

const SWAPPED = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' } as const;

/**
 * Compares a keys or items view with a set or another such view, as CPython's dictview_richcompare does. With a set on
 * the left, the set refuses the view and the view answers the swapped comparison.
 */
function compareSetLikeView(
  operator: keyof typeof COMPARE_NAMES,
  left: PyDictView | PySet,
  right: PyDictView | PySet
): boolean {
  if (left instanceof PySet) return compareSetLikeView(SWAPPED[operator], right, left);
  const leftSize = setLikeSize(left);
  const rightSize = setLikeSize(right);
  switch (operator) {
    case '==': {
      return leftSize === rightSize && allContainedIn(left, right);
    }
    case '!=': {
      return !(leftSize === rightSize && allContainedIn(left, right));
    }
    case '<': {
      return leftSize < rightSize && allContainedIn(left, right);
    }
    case '<=': {
      return leftSize <= rightSize && allContainedIn(left, right);
    }
    case '>': {
      return leftSize > rightSize && allContainedIn(right, left);
    }
    default: {
      return leftSize >= rightSize && allContainedIn(right, left);
    }
  }
}

function setLikeSize(value: PyDictView | PySet): number {
  return value instanceof PySet ? value.table.size : value.dict.store.size;
}

function allContainedIn(items: PyDictView | PySet, container: PyDictView | PySet): boolean {
  const runtime = currentRuntime();
  const next = iterate(items);
  for (let item = next(); item !== DONE; item = next()) {
    runtime.spend();
    const isContained =
      container instanceof PySet
        ? lookupSetKey(item, (key) => container.table.has(key))
        : viewContains(container, item);
    if (!isContained) return false;
  }
  return true;
}

function isSetLike(value: PyValue): value is PyDictView | PySet {
  return value instanceof PySet || isSetLikeView(value);
}

function sameSequenceKind(left: PyList | PyTuple, right: PyList | PyTuple): boolean {
  return left instanceof PyList === right instanceof PyList;
}

/** Whether a complex number equals an int, bool, or float, comparing an int exactly as int and float compare. */
function complexEqualsReal(complex: PyComplex, real: PyValue): boolean {
  if (complex.imag !== 0 || Number.isNaN(complex.real)) return false;
  const other = typeof real === 'boolean' ? Number(real) : (real as bigint | number);
  if (typeof other === 'number') return complex.real === other;
  // JavaScript compares a bigint with a number by their exact values.
  return !(complex.real < other) && !(complex.real > other);
}

function rangesEqual(left: PyRange, right: PyRange): boolean {
  const length = left.length;
  if (length !== right.length) return false;
  if (length === 0n) return true;
  if (left.start !== right.start) return false;
  return length === 1n || left.step === right.step;
}

export function dictsEqual(left: PyDict, right: PyDict): boolean {
  if (left.store.size !== right.store.size) return false;
  for (const entry of left.store.liveEntries()) {
    currentRuntime().spend();
    const other = right.store.lookup(entry.key);
    if (!other || !equals(entry.value, other.value)) return false;
  }
  return true;
}

function compareSequences(
  operator: keyof typeof COMPARE_NAMES,
  left: readonly PyValue[],
  right: readonly PyValue[]
): PyValue {
  if ((operator === '==' || operator === '!=') && left.length !== right.length) return operator === '!=';
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    currentRuntime().spend();
    if (!equals(left[index], right[index])) {
      if (operator === '==') return false;
      if (operator === '!=') return true;
      return compareOp(operator, left[index], right[index]);
    }
  }
  return applyOrder(operator, left.length, right.length);
}

function compareSets(operator: keyof typeof COMPARE_NAMES, left: PySet, right: PySet): boolean {
  switch (operator) {
    case '==': {
      return left.table.size === right.table.size && isSubset(left.table, right.table);
    }
    case '!=': {
      return !(left.table.size === right.table.size && isSubset(left.table, right.table));
    }
    case '<=': {
      return isSubset(left.table, right.table);
    }
    case '<': {
      return left.table.size < right.table.size && isSubset(left.table, right.table);
    }
    case '>=': {
      return isSubset(right.table, left.table);
    }
    default: {
      return right.table.size < left.table.size && isSubset(right.table, left.table);
    }
  }
}

/**
 * Python's `==` as a boolean, which identity short-circuits as containers do. Floats are unboxed, so every NaN counts
 * as one object: `x in [x]` and `math.nan in [math.nan]` hold as in CPython, at the cost of two separately computed
 * NaNs, which CPython keeps apart.
 */
export function equals(left: PyValue, right: PyValue): boolean {
  // Every equality test costs a step, the identity shortcut included, which compares equal host strings by scanning
  // them, so that the clock check stops any native loop of them.
  chargeStep();
  if (isSame(left, right)) return true;
  return isTruthyValue(compareOp('==', left, right));
}

/** The int an IntEnum member stands for, which int operators use; any other value as it is. */
export function intEnumValue(value: PyValue): PyValue {
  if (!(value instanceof PyInstance) || value.enumValue === undefined) return value;
  const { enumValue, cls } = value;
  if (typeof enumValue === 'bigint' && cls.isSubclassOf(intClass)) return enumValue;
  if (typeof enumValue === 'string' && cls.isSubclassOf(strClass)) return enumValue;
  return value;
}

/** Whether a value is a member of a Flag class, whose bitwise operators make members. */
function isFlagMember(value: PyValue): boolean {
  return value instanceof PyInstance && value.enumValue !== undefined && value.cls.lookup('__invert__') !== undefined;
}

/** Whether two dict keys or set elements are the same key: identical, or equal by `==`. */
export function keysEqual(left: PyValue, right: PyValue): boolean {
  if (isSame(left, right)) return true;
  const leftType = typeof left;
  if (leftType !== 'object' && typeof right !== 'object') {
    if (leftType === 'string' || typeof right === 'string') return false;
    return applyOrder('==', asNumber(left as Numeric), asNumber(right as Numeric));
  }
  return equals(left, right);
}

function asNumber(value: Numeric): bigint | number {
  return typeof value === 'boolean' ? Number(value) : value;
}

/** Orders two values by `<`, as sorting does. */
export function lessThan(left: PyValue, right: PyValue): boolean {
  if (typeof left === 'bigint' && typeof right === 'bigint') return left < right;
  if (typeof left === 'string' && typeof right === 'string') return compareStr(left, right) < 0;
  return isTruthyValue(compareOp('<', left, right));
}

/** Python's `in`. */
export function contains(containerValue: PyValue, item: PyValue): boolean {
  // A StrEnum member is searched as the str it stands for.
  const unboxed = intEnumValue(containerValue);
  const container = typeof unboxed === 'string' ? unboxed : containerValue;
  const special = overriding(container, '__contains__');
  if (special !== undefined) return isTruthyValue(callValue(bindValue(special, container), [item]));
  return builtinContains(container, item);
}

/** `item in container` as the builtin type of `container` defines it, whatever `__contains__` its class defines. */
export function builtinContains(container: PyValue, item: PyValue): boolean {
  const unboxed = unbox(container);
  if (typeof unboxed === 'string') {
    const sub = unbox(item);
    if (typeof sub !== 'string') {
      throw typeError(`'in <string>' requires string as left operand, not ${typeName(item)}`);
    }
    return containsStr(unboxed, sub);
  }
  if (container instanceof PyDict) return container.store.has(item);
  if (container instanceof PySet) return lookupSetKey(item, (key) => container.table.has(key));
  if (container instanceof PyDictView && container.view !== 'values') return viewContains(container, item);
  if (container instanceof PyRange) {
    return isIntLike(item) ? rangeContains(container, asInt(item)) : countEqual(iterate(container), item, 1) > 0;
  }
  if (container instanceof PyList || container instanceof PyTuple) {
    return sequenceContains(container, item);
  }
  const special = lookupSpecial(container, '__contains__');
  if (special !== undefined) return isTruthyValue(callValue(bindValue(special, container), [item]));
  const next = iterateOr(container, `argument of type '${typeName(container)}' is not a container or iterable`);
  return countEqual(next, item, 1) > 0;
}

function sequenceContains(sequence: PyList | PyTuple, item: PyValue): boolean {
  // As list_contains does, the length is read again after each comparison, which may change the list.
  for (let index = 0; index < sequence.items.length; index++) {
    if (equals(sequence.items[index], item)) return true;
  }
  return false;
}

/** The number of items an iterator yields that equal a value, stopping at `limit` of them. */
export function countEqual(next: NextFunction, item: PyValue, limit = Number.POSITIVE_INFINITY): number {
  let count = 0;
  // The limit is tested before the iterator is asked again: a generator must not run past the deciding item.
  while (count < limit) {
    const element = next();
    if (element === DONE) break;
    currentRuntime().spend();
    if (equals(element, item)) count++;
  }
  return count;
}

function viewContains(view: PyDictView, item: PyValue): boolean {
  if (view.view === 'keys') return view.dict.store.has(item);
  if (!(item instanceof PyTuple) || item.items.length !== 2) return false;
  const entry = view.dict.store.lookup(item.items[0]);
  return entry !== undefined && equals(entry.value, item.items[1]);
}

function rangeContains(range: PyRange, value: bigint): boolean {
  const { start, step, length } = range;
  if (length === 0n) return false;
  const offset = value - start;
  if (offset % step !== 0n) return false;
  const index = offset / step;
  return index >= 0n && index < length;
}

export { newTuple, strLength };
