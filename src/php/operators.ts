import { LIMITS, ExecutionLimitError } from '../interpreter/limits';
import {
  compareBytes,
  compareNumbers,
  debugType,
  floatFitsInt,
  formatFloat,
  intOrFloat,
  numericPrefix,
  numericValue,
  normalizeKeyString,
  toBool,
} from './conversions';
import { deprecated, throwError, warn } from './errors';
import { INT_MAX, INT_MIN, type Key, PhpArray, PhpObject, type Value } from './values';

/** Converts an object to a string through `__toString`, which the interpreter provides. */
let objectToString: (object: PhpObject) => string = () => '';
/** Compares two objects of the same class property by property, which the interpreter provides. */
let objectProps: (object: PhpObject) => [string, Value][] = () => [];

export function setObjectConversions(
  toString: (object: PhpObject) => string,
  props: (object: PhpObject) => [string, Value][]
): void {
  objectToString = toString;
  objectProps = props;
}

/** Converts a value to a byte string, as PHP's string conversion does. */
export function toStr(value: Value): string {
  if (typeof value === 'string') return value;
  if (value === null) return '';
  switch (typeof value) {
    case 'boolean': {
      return value ? '1' : '';
    }
    case 'bigint': {
      return value.toString();
    }
    case 'number': {
      if (Number.isNaN(value)) warn('unexpected NAN value was coerced to string');
      return formatFloat(value);
    }
  }
  if (value instanceof PhpArray) {
    warn('Array to string conversion');
    return 'Array';
  }
  if (value.cls.name === '(stream)') return `Resource id #${value.id}`;
  return objectToString(value);
}

/** Converts a value to an int as `(int)` and `intval` do. */
export function toInt(value: Value): bigint {
  if (value === null) return 0n;
  switch (typeof value) {
    case 'boolean': {
      return value ? 1n : 0n;
    }
    case 'bigint': {
      return value;
    }
    case 'number': {
      return floatToIntCast(value);
    }
    case 'string': {
      const prefix = numericPrefix(value);
      if (!prefix) return 0n;
      return typeof prefix.value === 'bigint' ? prefix.value : floatToIntCast(prefix.value);
    }
  }
  if (value instanceof PhpArray) return value.size > 0 ? 1n : 0n;
  warn(`Object of class ${(value as PhpObject).cls.name} could not be converted to int`);
  return 1n;
}

/** Converts a float to an int as `(int)` does: out-of-range and non-finite values become 0 in PHP 8 on 64 bits. */
export function floatToIntCast(value: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  if (!floatFitsInt(value)) return 0n;
  return BigInt(Math.trunc(value));
}

/** Converts a value to a float as `(float)` and `floatval` do. */
export function toFloat(value: Value): number {
  if (value === null) return 0;
  switch (typeof value) {
    case 'boolean': {
      return value ? 1 : 0;
    }
    case 'bigint': {
      return Number(value);
    }
    case 'number': {
      return value;
    }
    case 'string': {
      const prefix = numericPrefix(value);
      return prefix ? Number(prefix.value) : 0;
    }
  }
  if (value instanceof PhpArray) return value.size > 0 ? 1 : 0;
  warn(`Object of class ${(value as PhpObject).cls.name} could not be converted to float`);
  return 1;
}

/** Converts a value to a number for arithmetic, or throws PHP's TypeError for operands it cannot use. */
function arithmeticOperand(value: Value, op: string, left: Value, right: Value): bigint | number {
  if (typeof value === 'bigint' || typeof value === 'number') return value;
  if (value === null) return 0n;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') {
    const prefix = numericPrefix(value);
    if (!prefix) unsupportedOperands(op, left, right);
    if (!prefix.whole) warn('A non-numeric value encountered');
    return prefix.value;
  }
  return unsupportedOperands(op, left, right);
}

export function unsupportedOperands(op: string, left: Value, right: Value): never {
  throwError('TypeError', `Unsupported operand types: ${debugType(left)} ${op} ${debugType(right)}`);
}

// code-gauge-allow functionCognitiveComplexity 30 -- One case per arithmetic operator, as PHP's operators differ.
export function arithmetic(op: string, left: Value, right: Value): Value {
  if (op === '+' && left instanceof PhpArray && right instanceof PhpArray) return arrayUnion(left, right);
  if (left instanceof PhpArray || right instanceof PhpArray) unsupportedOperands(op, left, right);
  if (left instanceof PhpObject || right instanceof PhpObject) unsupportedOperands(op, left, right);
  const a = arithmeticOperand(left, op, left, right);
  const b = arithmeticOperand(right, op, left, right);
  switch (op) {
    case '+': {
      return typeof a === 'bigint' && typeof b === 'bigint' ? intOrFloat(a + b) : Number(a) + Number(b);
    }
    case '-': {
      return typeof a === 'bigint' && typeof b === 'bigint' ? intOrFloat(a - b) : Number(a) - Number(b);
    }
    case '*': {
      return typeof a === 'bigint' && typeof b === 'bigint' ? intOrFloat(a * b) : Number(a) * Number(b);
    }
    case '/': {
      if (Number(b) === 0) throwError('DivisionByZeroError', 'Division by zero');
      if (typeof a === 'bigint' && typeof b === 'bigint') {
        if (a % b === 0n && !(a === INT_MIN && b === -1n)) return a / b;
        return Number(a) / Number(b);
      }
      return Number(a) / Number(b);
    }
    case '%': {
      const x = toIntForOperator(a);
      const y = toIntForOperator(b);
      if (y === 0n) throwError('DivisionByZeroError', 'Modulo by zero');
      if (y === -1n) return 0n;
      return x % y;
    }
    case '**': {
      return power(a, b);
    }
  }
  throw new Error(`Unknown arithmetic operator ${op}`);
}

function power(a: bigint | number, b: bigint | number): bigint | number {
  if (typeof a === 'bigint' && typeof b === 'bigint' && b >= 0n) {
    if (a === 0n || a === 1n || b === 0n) return b === 0n ? 1n : a;
    if (a === -1n) return b % 2n === 0n ? 1n : -1n;
    // The result overflows once the exponent passes 63 for any base other than 0 and ±1.
    if (b > 64n) return Math.pow(Number(a), Number(b));
    return intOrFloat(a ** b);
  }
  if (Number(a) === 0 && Number(b) < 0) {
    deprecated('Power of base 0 and negative exponent is deprecated');
  }
  return Math.pow(Number(a), Number(b));
}

/** Converts an operand of `%`, `<<`, and the bitwise operators to an int, as PHP does with a precision warning. */
export function toIntForOperator(value: bigint | number): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isFinite(value) || !floatFitsInt(value)) {
    // PHP 8.5 deprecates implicitly converting out-of-range floats.
    return 0n;
  }
  if (!Number.isInteger(value)) {
    deprecated(`Implicit conversion from float ${formatFloatForMessage(value)} to int loses precision`);
  }
  return BigInt(Math.trunc(value));
}

export function formatFloatForMessage(value: number): string {
  return formatFloat(value, 17).replace(/^(-?\d+)$/, '$1');
}

function arrayUnion(left: PhpArray, right: PhpArray): PhpArray {
  const result = left.copy();
  for (const [key, slot] of right.map) {
    if (!result.map.has(key)) result.setSlot(key, slot);
  }
  return result;
}

export function concat(left: Value, right: Value): string {
  const a = toStr(left);
  const b = toStr(right);
  if (a.length + b.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  return a + b;
}

function bitwiseOperand(value: Value, op: string, left: Value, right: Value): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return toIntForOperator(value);
  if (value === null) return 0n;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') {
    const prefix = numericPrefix(value);
    if (!prefix) unsupportedOperands(op, left, right);
    if (!prefix.whole) warn('A non-numeric value encountered');
    return typeof prefix.value === 'bigint' ? prefix.value : toIntForOperator(prefix.value);
  }
  return unsupportedOperands(op, left, right);
}

export function bitwise(op: string, left: Value, right: Value): Value {
  if ((op === '&' || op === '|' || op === '^') && typeof left === 'string' && typeof right === 'string') {
    return bytewise(op, left, right);
  }
  if (left instanceof PhpArray || right instanceof PhpArray || left instanceof PhpObject || right instanceof PhpObject) {
    unsupportedOperands(op, left, right);
  }
  const a = bitwiseOperand(left, op, left, right);
  const b = bitwiseOperand(right, op, left, right);
  switch (op) {
    case '&': {
      return a & b;
    }
    case '|': {
      return a | b;
    }
    case '^': {
      return a ^ b;
    }
    case '<<': {
      if (b < 0n) throwError('ArithmeticError', 'Bit shift by negative number');
      if (b >= 64n) return 0n;
      return BigInt.asIntN(64, a << b);
    }
    case '>>': {
      if (b < 0n) throwError('ArithmeticError', 'Bit shift by negative number');
      if (b >= 64n) return a < 0n ? -1n : 0n;
      return a >> b;
    }
  }
  throw new Error(`Unknown bitwise operator ${op}`);
}

function bytewise(op: string, left: string, right: string): string {
  const length = op === '&' ? Math.min(left.length, right.length) : Math.max(left.length, right.length);
  let result = '';
  for (let index = 0; index < length; index++) {
    if (op === '&') result += String.fromCharCode(left.charCodeAt(index) & right.charCodeAt(index));
    else if (index >= left.length || index >= right.length) {
      if (op === '^') break;
      result += index >= left.length ? right[index] : left[index];
    } else if (op === '|') result += String.fromCharCode(left.charCodeAt(index) | right.charCodeAt(index));
    else result += String.fromCharCode(left.charCodeAt(index) ^ right.charCodeAt(index));
  }
  if (op === '^') return result.slice(0, Math.min(left.length, right.length));
  return result;
}

export function bitwiseNot(value: Value): Value {
  if (typeof value === 'bigint') return ~value;
  if (typeof value === 'number') return ~toIntForOperator(value);
  if (typeof value === 'string') {
    let result = '';
    for (let index = 0; index < value.length; index++) result += String.fromCharCode(~value.charCodeAt(index) & 0xff);
    return result;
  }
  throwError('TypeError', `Cannot perform bitwise not on ${debugType(value)}`);
}

export function negate(value: Value): Value {
  if (typeof value === 'bigint') return value === INT_MIN ? -Number(value) : -value;
  if (typeof value === 'number') return -value;
  return arithmetic('*', value, -1n);
}

export function unaryPlus(value: Value): Value {
  if (typeof value === 'bigint' || typeof value === 'number') return value;
  return arithmetic('*', value, 1n);
}

// Comparison ---------------------------------------------------------------------------------------------------------

/** Compares two strings as PHP 8 does: numerically when both are numeric, otherwise by bytes. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const x = numericValue(a);
  if (x !== undefined) {
    const y = numericValue(b);
    if (y !== undefined) return compareNumbers(x, y);
  }
  return Math.sign(compareBytes(a, b));
}

/** The result of PHP's `<=>`, where 1 also stands for values PHP cannot order. */
// code-gauge-allow functionCognitiveComplexity 35 -- Transcribes PHP's zend_compare type pairs.
export function compare(a: Value, b: Value): number {
  if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) {
    return compareNumbers(a, b);
  }
  if (typeof a === 'string' && typeof b === 'string') return compareStrings(a, b);
  if (typeof a === 'boolean' || typeof b === 'boolean' || a === null || b === null) {
    if (a === null && typeof b === 'string') return b === '' ? 0 : -1;
    if (b === null && typeof a === 'string') return a === '' ? 0 : 1;
    if (a === null && b instanceof PhpObject) return -1;
    if (b === null && a instanceof PhpObject) return 1;
    const x = toBool(a);
    const y = toBool(b);
    return x === y ? 0 : x ? 1 : -1;
  }
  if (typeof a === 'string' && (typeof b === 'bigint' || typeof b === 'number')) return compareStringNumber(a, b);
  if (typeof b === 'string' && (typeof a === 'bigint' || typeof a === 'number')) return -compareStringNumber(b, a);
  if (a instanceof PhpArray && b instanceof PhpArray) return compareArrays(a, b);
  if (a instanceof PhpArray) return 1;
  if (b instanceof PhpArray) return -1;
  if (a instanceof PhpObject && b instanceof PhpObject) return compareObjects(a, b);
  if (a instanceof PhpObject) return compareObjectScalar(a, b);
  if (b instanceof PhpObject) return -compareObjectScalar(b, a);
  return 1;
}

function compareStringNumber(text: string, number: bigint | number): number {
  const value = numericValue(text);
  if (value !== undefined) return compareNumbers(value, number);
  const numberText = typeof number === 'bigint' ? number.toString() : formatFloat(number);
  return Math.sign(compareBytes(text, numberText));
}

function compareObjectScalar(object: PhpObject, other: Value): number {
  if (typeof other === 'string' && object.cls.findMethod('__tostring')) {
    return Math.sign(compareBytes(objectToString(object), other));
  }
  if (typeof other === 'bigint' || typeof other === 'number') {
    const kind = typeof other === 'bigint' ? 'int' : 'float';
    warn(`Object of class ${object.cls.name} could not be converted to ${kind}`);
    return compareNumbers(1n, other);
  }
  return 1;
}

function compareArrays(a: PhpArray, b: PhpArray): number {
  if (a.size !== b.size) return a.size < b.size ? -1 : 1;
  for (const [key, value] of a.entries()) {
    if (!b.has(key)) return 1;
    const result = compare(value, b.get(key) as Value);
    if (result !== 0) return result;
  }
  return 0;
}

const comparing = new Set<PhpObject>();

function compareObjects(a: PhpObject, b: PhpObject): number {
  if (a === b) return 0;
  if (a.cls !== b.cls) return 1;
  if (comparing.has(a)) throwError('Error', 'Nesting level too deep - recursive dependency?');
  comparing.add(a);
  try {
    const left = objectProps(a);
    const right = new Map(objectProps(b));
    for (const [name, value] of left) {
      if (!right.has(name)) return 1;
      const result = compare(value, right.get(name) as Value);
      if (result !== 0) return result;
    }
    return 0;
  } finally {
    comparing.delete(a);
  }
}

export function looseEquals(a: Value, b: Value): boolean {
  if (a instanceof PhpArray && b instanceof PhpArray) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a.entries()) {
      if (!b.has(key)) return false;
      if (!looseEquals(value, b.get(key) as Value)) return false;
    }
    return true;
  }
  if (a instanceof PhpObject && b instanceof PhpObject) {
    if (a === b) return true;
    if (a.cls !== b.cls) return false;
    return compareObjects(a, b) === 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return true;
    const x = numericValue(a);
    if (x === undefined) return false;
    const y = numericValue(b);
    return y !== undefined && compareNumbers(x, y) === 0;
  }
  return compare(a, b) === 0;
}

export function strictEquals(a: Value, b: Value): boolean {
  if (a === b) return typeof a !== 'number' || !Number.isNaN(a);
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (a instanceof PhpArray && b instanceof PhpArray) {
    if (a.size !== b.size) return false;
    const right = [...b.entries()];
    let index = 0;
    for (const [key, value] of a.entries()) {
      const [otherKey, otherValue] = right[index++];
      if (key !== otherKey || !strictEquals(value, otherValue)) return false;
    }
    return true;
  }
  return false;
}

// Keys -----------------------------------------------------------------------------------------------------------------

/** Converts a value to an array key, as `$a[$key]` does, throwing for keys PHP rejects. */
export function toKey(value: Value): Key {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return normalizeKeyString(value);
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !floatFitsInt(value)) {
      deprecated(`Implicit conversion from float ${formatFloat(value, 17)} to int loses precision`);
      return 0n;
    }
    if (!Number.isInteger(value)) {
      deprecated(`Implicit conversion from float ${formatFloatForMessage(value)} to int loses precision`);
    }
    return BigInt(Math.trunc(value));
  }
  if (value instanceof PhpArray) throwError('TypeError', 'Illegal offset type');
  throwError('TypeError', `Cannot access offset of type ${debugType(value)} on array`);
}

export function keyToValue(key: Key): Value {
  return key;
}

/** Whether the int range holds `value`. */
export function inIntRange(value: bigint): boolean {
  return value <= INT_MAX && value >= INT_MIN;
}
