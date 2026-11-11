// code-gauge-allow-file fileNcss 573 -- The operator implementations of the builtin types belong together.
import type { BinaryOperator, CompareOperator } from './ast';
import { isBytesLike, PyBytes } from './bytesValues';
import { complexBinary, isComplexOperand, newComplex } from './complexNumbers';
import { DictStore } from './dictStore';
import { asFloat, divmodFloat, floorDivInt, intToFloat, modInt, trueDivideInt } from './numbers';
import { bindValue, callSpecial, callValue, iterate, lookupSpecial, overriding } from './objects';
import { formatPercent } from './percentFormat';
import { currentRuntime } from './runtimeContext';
import { compareStr, strLength } from './strings';
import {
  classOf,
  intClass,
  newList,
  newSet,
  newTuple,
  NotImplemented,
  objectClass,
  pyError,
  resultClassOf,
  strClass,
  typeError,
  typeName,
  unbox,
} from './types';
import {
  DONE,
  PyComplex,
  PyDict,
  PyDictView,
  PyError,
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
    return native === NotImplemented ? dispatchOrRaise(operator, leftValue, rightValue) : native;
  }
  // The bitwise operators of a Flag combine its members into members, before an IntFlag counts as an int.
  if ('|&^'.includes(operator) && (isFlagMember(leftValue) || isFlagMember(rightValue))) {
    const combined = dispatchBinary(operator, leftValue, rightValue);
    if (combined !== NotImplemented) return combined;
  }
  const left = intEnumValue(leftValue);
  // A str template formats an enum member itself, whose str() and repr() differ from its value's.
  const right = operator === '%' && typeof left === 'string' ? rightValue : intEnumValue(rightValue);
  if (isPlain(left) && isPlain(right)) {
    const native = nativeBinary(operator, left, right);
    if (native !== NotImplemented) return native;
  }
  return dispatchOrRaise(operator, left, right);
}

function dispatchOrRaise(operator: BinaryOperator, left: PyValue, right: PyValue): PyValue {
  const result = dispatchBinary(operator, left, right);
  if (result !== NotImplemented) return result;
  throw binaryTypeError(operator, left, right);
}

/** Python's augmented assignment operators, which try the in-place method first. */
export function inplaceOp(operator: BinaryOperator, left: PyValue, right: PyValue): PyValue {
  if (typeof left !== 'object') return binaryOp(operator, left, right);
  if (left.cls.isBuiltin) {
    const native = nativeInplace(operator, left, right);
    if (native !== NotImplemented) return native;
  }
  // A builtin type without a native in-place operator, such as deque, may define the method.
  const method = lookupSpecial(left, SPECIAL_NAMES[operator][2]);
  if (method !== undefined) {
    const result = callSlot(method, left, right);
    if (result !== NotImplemented) return result;
  }
  return binaryOp(operator, left, right);
}

/** The in-place operators of the builtin mutable types, or NotImplemented for the others. */
// code-gauge-allow functionCognitiveComplexity 18 -- One case per builtin mutable type.
export function nativeInplace(operator: BinaryOperator, left: PyValue, right: PyValue): PyValue {
  if (left instanceof PyList) {
    if (operator === '+') {
      left.items.push(...iterateAll(right));
      currentRuntime().allocate(0);
      return left;
    }
    if (operator === '*') {
      const times = repeatCount(right, left);
      const items = [...left.items];
      currentRuntime().allocate(items.length * Math.max(times - 1, 0));
      left.items = times <= 0 ? [] : Array.from({ length: times }, () => items).flat();
      return left;
    }
  }
  if (
    left instanceof PySet &&
    !left.cls.name.startsWith('frozen') &&
    right instanceof PySet &&
    '|&-^'.includes(operator)
  ) {
    const result = binaryOp(operator, left, right) as PySet;
    left.table = result.table;
    return left;
  }
  if (left instanceof PyDict && operator === '|') {
    for (const [key, value] of mappingItems(right)) left.store.set(key, value);
    return left;
  }
  if (left instanceof PyBytes && left.isMutable) {
    const method = lookupSpecial(left, SPECIAL_NAMES[operator][2]);
    if (method !== undefined) return callSlot(method, left, right);
  }
  return NotImplemented;
}

function iterateAll(value: PyValue): PyValue[] {
  const next = iterate(value);
  const items: PyValue[] = [];
  for (let item = next(); item !== DONE; item = next()) items.push(item);
  return items;
}

function mappingItems(value: PyValue): [PyValue, PyValue][] {
  if (value instanceof PyDict) return value.store.ordered().map((entry) => [entry.key, entry.value]);
  throw typeError(`'${typeName(value)}' object is not a mapping`);
}

function dispatchBinary(operator: BinaryOperator, left: PyValue, right: PyValue): PyValue {
  const [name, reflected] = SPECIAL_NAMES[operator];
  const leftClass = classOf(left);
  const rightClass = classOf(right);
  const leftMethod = lookupSpecial(left, name);
  const rightMethod = leftClass === rightClass ? undefined : lookupSpecial(right, reflected);
  // A subclass that overrides the reflected method gets the first chance.
  if (rightMethod !== undefined && rightClass.isSubclassOf(leftClass) && rightMethod !== leftClass.lookup(reflected)) {
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

function binaryTypeError(operator: BinaryOperator, left: PyValue, right: PyValue): Error {
  const base = sequenceTypeName(left);
  if (operator === '+' && base !== undefined && !isUserObject(right)) {
    return typeError(`can only concatenate ${base} (not "${typeName(right)}") to ${base}`);
  }
  if (operator === '*' && (isSequenceLike(left) || isSequenceLike(right))) {
    const other = isSequenceLike(left) ? right : left;
    return typeError(`can't multiply sequence by non-int of type '${typeName(other)}'`);
  }
  const shown = operator === '**' ? '** or pow()' : operator;
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
  return typeof value === 'string' || isSequence(value);
}

/** The result of an operator on builtin operands, or NotImplemented when their types do not define it. */
// code-gauge-allow functionCognitiveComplexity 18 -- One case per builtin type that defines binary operators.
export function nativeBinary(operator: BinaryOperator, left: PyValue, right: PyValue): PyValue {
  if (isNumeric(left) && isNumeric(right)) return numericBinary(operator, left, right);
  if (isComplexOperand(left) && isComplexOperand(right) && (left instanceof PyComplex || right instanceof PyComplex)) {
    return complexBinary(operator, left, right);
  }
  if (typeof left === 'string') return stringBinary(operator, left, right);
  if (typeof right === 'string' && operator === '*' && isIntLike(left)) return repeatString(right, left);
  if (isSequence(left) && !isUserObject(left)) return sequenceBinary(operator, left, right);
  if (isSequence(right) && operator === '*' && isIntLike(left)) return repeatSequence(right, left);
  if (left instanceof PySet && right instanceof PySet) return setBinary(operator, left, right);
  if (left instanceof PyDictView && left.view !== 'values' && '&|-^'.includes(operator)) {
    return setBinary(operator, newSet(iterateAll(left)), newSet(iterateAll(right)));
  }
  if (left instanceof PyDict && right instanceof PyDict && operator === '|') {
    return mergeDicts(left, right);
  }
  return NotImplemented;
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
    currentRuntime().allocate(items.length);
    return left instanceof PyList ? newList(items) : newTuple(items);
  }
  if (operator === '*' && isIntLike(right)) return repeatSequence(left, right);
  return NotImplemented;
}

function mergeDicts(left: PyDict, right: PyDict): PyDict {
  const result = new PyDict(resultClassOf(left.cls), new DictStore(), left.defaultFactory);
  for (const entry of left.store.ordered()) result.store.set(entry.key, entry.value);
  for (const entry of right.store.ordered()) result.store.set(entry.key, entry.value);
  return result;
}

function isIntLike(value: PyValue): value is bigint | boolean {
  return typeof value === 'bigint' || typeof value === 'boolean';
}

function repeatCount(count: PyValue, sequence: PyValue): number {
  if (!isIntLike(count)) throw typeError(`can't multiply sequence by non-int of type '${typeName(count)}'`);
  const times = asInt(count);
  if (times > BigInt(Number.MAX_SAFE_INTEGER))
    throw pyError('OverflowError', `cannot fit 'int' into an index-sized integer`);
  void sequence;
  return Number(times);
}

function repeatString(text: string, count: bigint | boolean): string {
  const times = repeatCount(count, text);
  if (times <= 0 || text === '') return '';
  currentRuntime().buildString(text.length * times);
  return text.repeat(times);
}

function repeatSequence(sequence: PyList | PyTuple, count: bigint | boolean): PyValue {
  const times = Math.max(repeatCount(count, sequence), 0);
  currentRuntime().allocate(sequence.items.length * times);
  const items: PyValue[] = [];
  for (let index = 0; index < times; index++) items.push(...sequence.items);
  return sequence instanceof PyList ? newList(items) : newTuple(items);
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
  const result = x ** y;
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

// code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of builtin value.
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
// code-gauge-allow functionCognitiveComplexity 27 -- One case per kind of builtin value.
function nativeEquals(left: PyValue, right: PyValue): boolean | undefined {
  if (definesEquality(left) || definesEquality(right) || isBytesLike(left) || isBytesLike(right)) return undefined;
  if (left instanceof PyComplex || right instanceof PyComplex) {
    if (!isComplexOperand(left) || !isComplexOperand(right)) return false;
    const a = toComplexParts(left);
    const b = toComplexParts(right);
    return a[0] === b[0] && a[1] === b[1];
  }
  if (typeof left === 'string' || typeof right === 'string' || isNumeric(left) || isNumeric(right)) return false;
  if (left instanceof PyRange && right instanceof PyRange) return rangesEqual(left, right);
  if (left instanceof PyDict && right instanceof PyDict) return dictsEqual(left, right);
  if (left instanceof PyDictView && right instanceof PyDictView) {
    return left.view !== 'values' && left.view === right.view && dictsEqual(left.dict, right.dict);
  }
  if (isSequence(left) && isSequence(right)) return sameSequenceKind(left, right) ? undefined : false;
  if (left instanceof PySet && right instanceof PySet) return undefined;
  if (left instanceof PyDictView && left.view === 'keys' && right instanceof PySet) {
    return compareSets('==', newSet(iterateAll(left)), right);
  }
  // Another builtin object, such as a deque, compares by its own `__eq__`.
  if (builtinEquality(left) || builtinEquality(right)) return undefined;
  return left === right;
}

function builtinEquality(value: PyValue): boolean {
  return value instanceof PyObject && lookupSpecial(value, '__eq__') !== objectClass.dict.get('__eq__');
}

/** Whether a value is an instance whose class defines `==`, such as a program's class or `fractions.Fraction`. */
function definesEquality(value: PyValue): boolean {
  if (!(value instanceof PyInstance)) return false;
  const cls = classOf(value);
  return !cls.isBuiltin || cls.lookup('__eq__') !== objectClass.dict.get('__eq__');
}

function sameSequenceKind(left: PyList | PyTuple, right: PyList | PyTuple): boolean {
  return left instanceof PyList === right instanceof PyList;
}

function toComplexParts(value: PyValue): [number, number] {
  if (value instanceof PyComplex) return [value.real, value.imag];
  return [asFloat(value as Numeric), 0];
}

function rangesEqual(left: PyRange, right: PyRange): boolean {
  const length = left.length;
  if (length !== right.length) return false;
  if (length === 0n) return true;
  if (left.start !== right.start) return false;
  return length === 1n || left.step === right.step;
}

function dictsEqual(left: PyDict, right: PyDict): boolean {
  if (left.store.size !== right.store.size) return false;
  for (const entry of left.store.ordered()) {
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

function subset(a: PySet, b: PySet): boolean {
  return a.table.keys().every((key) => b.table.has(key));
}

function compareSets(operator: keyof typeof COMPARE_NAMES, left: PySet, right: PySet): boolean {
  switch (operator) {
    case '==': {
      return left.table.size === right.table.size && subset(left, right);
    }
    case '!=': {
      return !(left.table.size === right.table.size && subset(left, right));
    }
    case '<=': {
      return subset(left, right);
    }
    case '<': {
      return left.table.size < right.table.size && subset(left, right);
    }
    case '>=': {
      return subset(right, left);
    }
    default: {
      return right.table.size < left.table.size && subset(right, left);
    }
  }
}

/** Python's `==` as a boolean, which identity short-circuits as containers do. */
export function equals(left: PyValue, right: PyValue): boolean {
  if (left === right && !(typeof left === 'number' && Number.isNaN(left))) return true;
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
  if (left === right) return true;
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
  if (typeof container === 'string') {
    if (typeof item !== 'string') {
      throw typeError(`'in <string>' requires string as left operand, not ${typeName(item)}`);
    }
    currentRuntime().scan(container.length);
    return container.includes(item);
  }
  if (container instanceof PyDict) return container.store.has(item);
  if (container instanceof PySet) return container.table.has(item);
  if (container instanceof PyDictView && container.view !== 'values') return viewContains(container, item);
  if (container instanceof PyRange && isIntLike(item)) return rangeContains(container, asInt(item));
  if (container instanceof PyList || container instanceof PyTuple) {
    currentRuntime().scan(container.items.length);
    return container.items.some((element) => equals(element, item));
  }
  const special = lookupSpecial(container, '__contains__');
  if (special !== undefined) return isTruthyValue(callValue(bindValue(special, container), [item]));
  const next = iterateContainer(container);
  for (let element = next(); element !== DONE; element = next()) {
    currentRuntime().spend();
    if (equals(element, item)) return true;
  }
  return false;
}

/** Starts iterating the right operand of `in`, whose lack of both protocols CPython words differently. */
function iterateContainer(container: PyValue): () => PyValue | typeof DONE {
  try {
    return iterate(container);
  } catch (error) {
    const message = error instanceof PyError ? error.exception.exception?.args.items[0] : undefined;
    if (message === `'${typeName(container)}' object is not iterable`) {
      throw typeError(`argument of type '${typeName(container)}' is not a container or iterable`);
    }
    throw error;
  }
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
