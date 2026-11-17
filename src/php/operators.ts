// code-gauge-allow-file fileNcss 442 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import {
  compareBytes,
  compareNumbers,
  debugType,
  floatFitsInt,
  formatFloat,
  formatFloatRepr,
  intOrFloat,
  normalizeKeyString,
  numericPrefix,
  numericValue,
  toBool,
  valueName,
} from './conversions';
import { deprecated, notice, throwError, warn } from './errors';
import { cPow } from './floatPow';
import { rt } from './runtime';
import { copyValueSlot, INT_MAX, INT_MIN, type Key, PhpArray, PhpObject, type Value } from './values';

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
// code-gauge-allow duplicateLines 19 -- Mirrors toFloat, as PHP converts each type to int and to float by separate rules.
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
      return typeof prefix.value === 'bigint' ? prefix.value : floatToIntCap(prefix.value);
    }
  }
  if (value instanceof PhpArray) return value.size > 0 ? 1n : 0n;
  warn(`Object of class ${(value as PhpObject).cls.name} could not be converted to int`);
  return 1n;
}

/**
 * Converts a float to an int as PHP 8.5 does: a value out of range wraps around 64 bits, and NaN and the infinities
 * become 0, both with a warning.
 */
export function floatToIntCast(value: number): bigint {
  if (floatFitsInt(value)) return BigInt(Math.trunc(value));
  warn(`The float ${formatFloatForMessage(value)} is not representable as an int, cast occurred`);
  return Number.isFinite(value) ? BigInt.asIntN(64, BigInt(value)) : 0n;
}

/** Converts the float a numeric string holds to an int, which PHP clamps to the range of ints, as strtol does. */
function floatToIntCap(value: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  if (value >= 9.223372036854776e18) return INT_MAX;
  if (value < -9.223372036854776e18) return INT_MIN;
  return BigInt(Math.trunc(value));
}

/** Converts a value to a float as `(float)` and `floatval` do. */
// code-gauge-allow duplicateLines 20 -- Mirrors toInt, as PHP converts each type to int and to float by separate rules.
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

/** `%`, which reads its operands as ints, as the bitwise operators do. */
function modulo(left: Value, right: Value): bigint {
  const x = intOperand(left, '%', left, right);
  const y = intOperand(right, '%', left, right);
  if (y === 0n) throwError('DivisionByZeroError', 'Modulo by zero');
  if (y === -1n) return 0n;
  return x % y;
}

export function unsupportedOperands(op: string, left: Value, right: Value): never {
  throwError('TypeError', `Unsupported operand types: ${debugType(left)} ${op} ${debugType(right)}`);
}

// code-gauge-allow functionCognitiveComplexity 27 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function arithmetic(op: string, left: Value, right: Value): Value {
  if (op === '+' && left instanceof PhpArray && right instanceof PhpArray) return arrayUnion(left, right);
  if (left instanceof PhpArray || right instanceof PhpArray) unsupportedOperands(op, left, right);
  if (left instanceof PhpObject || right instanceof PhpObject) unsupportedOperands(op, left, right);
  if (op === '%') return modulo(left, right);
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
    case '**': {
      return power(a, b);
    }
  }
  throw new Error(`Unknown arithmetic operator ${op}`);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function power(a: bigint | number, b: bigint | number): bigint | number {
  if (typeof a === 'bigint' && typeof b === 'bigint' && b >= 0n) {
    if (a === 0n || a === 1n || b === 0n) return b === 0n ? 1n : a;
    if (a === -1n) return b % 2n === 0n ? 1n : -1n;
    // The result overflows once the exponent passes 63 for any base other than 0 and ±1.
    if (b > 64n) return cPow(Number(a), Number(b));
    return intOrFloat(a ** b);
  }
  if (Number(a) === 0 && Number(b) < 0) {
    deprecated('Power of base 0 and negative exponent is deprecated');
  }
  return cPow(Number(a), Number(b));
}

/**
 * Converts a float used where PHP needs an int (an operand of `%` or a bitwise operator, an array key), warning as
 * PHP does about a value out of range and deprecating one with a fraction.
 */
export function toIntForOperator(value: bigint | number): bigint {
  if (typeof value === 'bigint') return value;
  if (!floatFitsInt(value)) {
    const result = floatToIntCast(value);
    if (Number.isNaN(value)) deprecated('Implicit conversion from float NAN to int loses precision');
    return result;
  }
  if (!Number.isInteger(value)) {
    deprecated(`Implicit conversion from float ${formatFloatForMessage(value)} to int loses precision`);
  }
  return BigInt(Math.trunc(value));
}

/** Converts a numeric string holding a float where PHP needs an int, deprecating a value an int cannot hold. */
function floatStringToInt(text: string, value: number): bigint {
  const result = floatToIntCap(value);
  if (Number(result) !== value) deprecated(`Implicit conversion from float-string "${text}" to int loses precision`);
  return result;
}

export function formatFloatForMessage(value: number): string {
  return formatFloatRepr(value);
}

function arrayUnion(left: PhpArray, right: PhpArray): PhpArray {
  const result = left.copy();
  for (const [key, slot] of right.map) {
    if (!result.map.has(key)) result.setSlot(key, copyValueSlot(slot));
  }
  return result;
}

export function concat(left: Value, right: Value): string {
  const a = toStr(left);
  const b = toStr(right);
  rt().ensureStringFits(a.length + b.length);
  return a + b;
}

/** Converts an operand of `%` or a bitwise operator to an int, as PHP's zendi_try_get_long does. */
function intOperand(value: Value, op: string, left: Value, right: Value): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return toIntForOperator(value);
  if (value === null) return 0n;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') {
    const prefix = numericPrefix(value);
    if (!prefix) unsupportedOperands(op, left, right);
    if (!prefix.whole) warn('A non-numeric value encountered');
    return typeof prefix.value === 'bigint' ? prefix.value : floatStringToInt(value, prefix.value);
  }
  return unsupportedOperands(op, left, right);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function bitwise(op: string, left: Value, right: Value): Value {
  if ((op === '&' || op === '|' || op === '^') && typeof left === 'string' && typeof right === 'string') {
    return bytewise(op, left, right);
  }
  if (
    left instanceof PhpArray ||
    right instanceof PhpArray ||
    left instanceof PhpObject ||
    right instanceof PhpObject
  ) {
    unsupportedOperands(op, left, right);
  }
  const a = intOperand(left, op, left, right);
  const b = intOperand(right, op, left, right);
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
  throwError('TypeError', `Cannot perform bitwise not on ${valueName(value)}`);
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

type ComparisonMode = 'order' | 'loose' | 'strict';
type ComparisonPair = [Value, Value, ComparisonMode];
interface ComparisonFrame {
  owner: PhpArray | PhpObject;
  pairs: Generator<ComparisonPair, number>;
}

/** The result of PHP's `<=>`, where 1 also stands for values PHP cannot order. */
export function compare(a: Value, b: Value): number {
  return walkComparison(a, b, 'order');
}

export function looseEquals(a: Value, b: Value): boolean {
  return walkComparison(a, b, 'loose') === 0;
}

export function strictEquals(a: Value, b: Value): boolean {
  return walkComparison(a, b, 'strict') === 0;
}

// code-gauge-allow functionCognitiveComplexity 23 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function walkComparison(a: Value, b: Value, mode: ComparisonMode): number {
  const stack: ComparisonFrame[] = [];
  const active = new Set<PhpArray | PhpObject>();
  let pair: ComparisonPair | undefined = [a, b, mode];
  for (;;) {
    if (pair) {
      rt().spend();
      const result = comparisonStep(...pair);
      if (typeof result === 'number') {
        if (result !== 0) return result;
      } else {
        if (active.has(result.owner)) throwError('Error', 'Nesting level too deep - recursive dependency?');
        active.add(result.owner);
        stack.push(result);
      }
    }
    const frame = stack.at(-1);
    if (!frame) return 0;
    const step = frame.pairs.next();
    if (step.done) {
      active.delete(frame.owner);
      stack.pop();
      if (step.value !== 0) return step.value;
      pair = undefined;
    } else pair = step.value;
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function comparisonStep(a: Value, b: Value, mode: ComparisonMode): number | ComparisonFrame {
  if (a === b) return typeof a === 'number' && Number.isNaN(a) ? 1 : 0;
  if (a instanceof PhpArray && b instanceof PhpArray) {
    if (a.size !== b.size) return a.size < b.size ? -1 : 1;
    return { owner: a, pairs: arrayComparisonPairs(a, b, mode) };
  }
  if (mode === 'strict') return 1;
  if (a instanceof PhpObject && b instanceof PhpObject) {
    if (a.cls !== b.cls) return 1;
    return { owner: a, pairs: objectComparisonPairs(a, b) };
  }
  if (mode === 'loose' && typeof a === 'string' && typeof b === 'string') return looseStringEquals(a, b) ? 0 : 1;
  return compareScalar(a, b);
}

function* arrayComparisonPairs(a: PhpArray, b: PhpArray, mode: ComparisonMode): Generator<ComparisonPair, number> {
  const right = mode === 'strict' ? b.entries() : undefined;
  for (const [key, value] of a.entries()) {
    if (right) {
      const item = right.next();
      if (item.done || item.value[0] !== key) return 1;
      yield [value, item.value[1], mode];
    } else {
      if (!b.has(key)) return 1;
      yield [value, b.get(key) as Value, mode];
    }
  }
  return 0;
}

function* objectComparisonPairs(a: PhpObject, b: PhpObject): Generator<ComparisonPair, number> {
  const left = objectProps(a);
  const right = new Map(objectProps(b));
  if (left.length !== right.size && (hasDynamicProps(a) || hasDynamicProps(b)))
    return left.length > right.size ? 1 : -1;
  for (const [name, value] of left) {
    if (!right.has(name)) return 1;
    yield [value, right.get(name) as Value, 'order'];
  }
  return 0;
}

function hasDynamicProps(object: PhpObject): boolean {
  return [...object.props.keys()].some((key) => !key.startsWith('\0') && !object.cls.propByName.has(key));
}

function compareScalar(a: Value, b: Value): number {
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
  if (a instanceof PhpObject) return compareObjectScalar(a, b);
  if (b instanceof PhpObject) return -compareObjectScalar(b, a);
  if (a instanceof PhpArray) return 1;
  if (b instanceof PhpArray) return -1;
  return 1;
}

function compareStringNumber(text: string, number: bigint | number): number {
  const value = numericValue(text);
  if (value !== undefined) return compareNumbers(value, number);
  const numberText = typeof number === 'bigint' ? number.toString() : formatFloat(number);
  return Math.sign(compareBytes(text, numberText));
}

/**
 * Compares an object with a value of another type as PHP's zend_std_compare_objects does: the object is converted to
 * the value's type, and an object that cannot be converted is greater.
 */
function compareObjectScalar(object: PhpObject, other: Value): number {
  if (typeof other === 'string' && object.cls.findMethod('__tostring')) return compare(objectToString(object), other);
  if (typeof other === 'bigint' || typeof other === 'number') {
    const kind = typeof other === 'bigint' ? 'int' : 'float';
    notice(`Object of class ${object.cls.name} could not be converted to ${kind}`);
    return compareNumbers(1n, other);
  }
  return 1;
}

/** `==` on two strings: numeric strings compare as numbers, others as text. */
function looseStringEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const x = numericValue(a);
  if (x === undefined) return false;
  const y = numericValue(b);
  if (y === undefined) return false;
  // Numbers too large for their type compare as text, since converting both lost what tells them apart.
  if (typeof x === 'number' && x === y && (!Number.isFinite(x) || (isIntegerText(a) && isIntegerText(b)))) return false;
  return compareNumbers(x, y) === 0;
}

/** Whether a numeric string is written as an integer, which a float holds only when the integer overflows. */
function isIntegerText(text: string): boolean {
  return /^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/.test(text);
}

// Keys -----------------------------------------------------------------------------------------------------------------

/** What an array key is used for, which PHP names in the error for a key of an invalid type. */
export type KeyUse = 'access' | 'isset' | 'unset';

/** Converts a value to an array key, as `$a[$key]` does, throwing for keys PHP rejects. */
export function toKey(value: Value, use: KeyUse = 'access'): Key {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return normalizeKeyString(value);
  if (value === null) {
    deprecated('Using null as an array offset is deprecated, use an empty string instead');
    return '';
  }
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return toIntForOperator(value);
  const type = debugType(value);
  if (use === 'isset') throwError('TypeError', `Cannot access offset of type ${type} in isset or empty`);
  throwError('TypeError', `Cannot ${use === 'unset' ? 'unset' : 'access'} offset of type ${type} on array`);
}
