// code-gauge-allow-file fileNcss 535 -- PHP operators share coercion and comparison helpers.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import {
  boolValue,
  compareBytes,
  compareNumbers,
  debugType,
  floatFitsInt,
  formatFloat,
  formatFloatRepr,
  intOrFloat,
  NAN_STRING_WARNING,
  normalizeKeyString,
  numericPrefix,
  numericValue,
  valueName,
} from './conversions';
import { deprecated, notice, throwError, type UpdateWarning, warn, withCleanupExceptions } from './errors';
import { cPow } from './floatPow';
import { ExitSignal, PhpThrow, rt } from './runtime';
import {
  copyValueSlot,
  deref,
  INT_MAX,
  INT_MIN,
  type Key,
  PhpArray,
  PhpObject,
  type Ref,
  UNDEFINED_RESULT,
  UNINIT,
  type Value,
} from './values';

/** Converts an object to a string through `__toString`, which the interpreter provides. */
let objectToString: (object: PhpObject) => string = () => '';

export function setObjectToString(toString: (object: PhpObject) => string): void {
  objectToString = toString;
}

/** Converts a value to a byte string, as PHP's string conversion does. */
export function toStr(value: Value): string {
  return stringify(value, warn);
}

function stringify(value: Value, reportWarning: (message: string) => void): string {
  if (typeof value === 'string') return value;
  if (value === null || value === UNDEFINED_RESULT) return '';
  switch (typeof value) {
    case 'boolean': {
      return value ? '1' : '';
    }
    case 'bigint': {
      return value.toString();
    }
    case 'number': {
      rt().constantEvaluationEpoch++;
      if (Number.isNaN(value)) reportWarning(NAN_STRING_WARNING);
      return formatFloat(value);
    }
  }
  if (value instanceof PhpArray) {
    reportWarning('Array to string conversion');
    return 'Array';
  }
  if (value.cls.name === '(stream)') return `Resource id #${value.id}`;
  return objectToString(value);
}

export function withStringConversionErrors(
  continuation: (
    convert: (value: Value) => string,
    reportWarning: (message: string) => void,
    hold: (error: unknown) => void,
    tryConvert: (value: Value) => string | undefined
  ) => void
): void {
  const runtime = rt();
  const pending = runtime.nativeStringConversionPending;
  try {
    withCleanupExceptions(runtime, (capture) => {
      const hold = (error: unknown): void => {
        if (!(error instanceof PhpThrow || error instanceof ExitSignal)) throw error;
        capture(error);
        runtime.nativeStringConversionPending = true;
      };
      const reportWarning = (message: string): void => {
        try {
          warn(message);
        } catch (error) {
          hold(error);
        }
      };
      const tryConvert = (value: Value): string | undefined => {
        if (runtime.nativeStringConversionPending && value instanceof PhpObject && !value.isResource) return undefined;
        try {
          return stringify(value, reportWarning);
        } catch (error) {
          hold(error);
          return undefined;
        }
      };
      continuation((value) => tryConvert(value) ?? '', reportWarning, hold, tryConvert);
    });
  } finally {
    runtime.nativeStringConversionPending = pending;
  }
}

/** Converts a value to an int as `(int)` and `intval` do. */
// code-gauge-allow duplicateLines 22 -- Mirrors toFloat, as PHP converts each type to int and to float by separate rules.
export function toInt(value: Value): bigint {
  if (value === null || value === UNDEFINED_RESULT) return 0n;
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
  if (value instanceof PhpObject && value.isResource) return BigInt(value.id);
  warn(`Object of class ${(value as PhpObject).cls.name} could not be converted to int`);
  return 1n;
}

/**
 * Converts a float to an int as PHP 8.5 does: a value out of range wraps around 64 bits, and NaN and the infinities
 * become 0, both with a warning.
 */
export function floatToIntCast(value: number, pending?: PhpThrow, warning?: UpdateWarning): bigint {
  if (floatFitsInt(value)) return BigInt(Math.trunc(value));
  operatorDiagnostic(
    pending,
    warn,
    `The float ${formatFloatForMessage(value)} is not representable as an int, cast occurred`,
    warning
  );
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
// code-gauge-allow duplicateLines 22 -- Mirrors toInt, as PHP converts each type to int and to float by separate rules.
export function toFloat(value: Value, reportWarning = warn): number {
  if (value === null) return 0;
  if (value === UNDEFINED_RESULT) return 1;
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
  if (value instanceof PhpObject && value.isResource) return value.id;
  reportWarning(`Object of class ${(value as PhpObject).cls.name} could not be converted to float`);
  return 1;
}

/** Converts a value to a number for arithmetic, or throws PHP's TypeError for operands it cannot use. */
function arithmeticOperand(value: Value, op: string, left: Value, right: Value, pending?: PhpThrow): bigint | number {
  if (typeof value === 'bigint' || typeof value === 'number') return value;
  if (value === null) return 0n;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') {
    const prefix = numericPrefix(value);
    if (!prefix) unsupportedOperands(op, left, right, pending);
    if (!prefix.whole) operatorDiagnostic(pending, warn, 'A non-numeric value encountered');
    return prefix.value;
  }
  return unsupportedOperands(op, left, right, pending);
}

/** `%`, which reads its operands as ints, as the bitwise operators do. */
function modulo(left: Value, right: Value, pending?: PhpThrow): bigint {
  const x = intOperand(left, '%', left, right, pending);
  const y = intOperand(right, '%', left, right, pending);
  if (y === 0n) throwError('DivisionByZeroError', 'Modulo by zero');
  if (y === -1n) return 0n;
  return x % y;
}

function unsupportedOperands(op: string, left: Value, right: Value, pending?: PhpThrow): never {
  if (pending) throw pending;
  throwError('TypeError', `Unsupported operand types: ${debugType(left)} ${op} ${debugType(right)}`);
}

function operatorDiagnostic(
  pending: PhpThrow | undefined,
  report: (message: string) => void,
  message: string,
  warning?: UpdateWarning
): void {
  if (pending) throw pending;
  if (warning) warning(() => report(message));
  else report(message);
}

// code-gauge-allow functionCognitiveComplexity 27 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function arithmetic(op: string, left: Value, right: Value, pending?: PhpThrow): Value {
  if (op === '+' && left instanceof PhpArray && right instanceof PhpArray) return arrayUnion(left, right);
  if (op === '%') return modulo(left, right, pending);
  const a = arithmeticOperand(left, op, left, right, pending);
  const b = arithmeticOperand(right, op, left, right, pending);
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
      return power(a, b, pending);
    }
  }
  throw new Error(`Unknown arithmetic operator ${op}`);
}

function power(a: bigint | number, b: bigint | number, pending?: PhpThrow): bigint | number {
  if (typeof a === 'bigint' && typeof b === 'bigint' && b >= 0n) {
    if (a === 0n || a === 1n || b === 0n) return b === 0n ? 1n : a;
    if (a === -1n) return b % 2n === 0n ? 1n : -1n;
    let result = 1n;
    let factor = a;
    let exponent = b;
    while (exponent > 0n) {
      if (exponent % 2n !== 0n) {
        exponent--;
        const product = result * factor;
        if (product < INT_MIN || product > INT_MAX)
          return Number(result) * Number(factor) * cPow(Number(factor), Number(exponent));
        result = product;
      } else {
        exponent /= 2n;
        const square = factor * factor;
        if (square < INT_MIN || square > INT_MAX)
          return Number(result) * cPow(Number(factor) * Number(factor), Number(exponent));
        factor = square;
      }
    }
    return result;
  }
  if (Number(a) === 0 && Number(b) < 0) {
    operatorDiagnostic(pending, deprecated, 'Power of base 0 and negative exponent is deprecated');
  }
  return cPow(Number(a), Number(b));
}

/**
 * Converts a float used where PHP needs an int (an operand of `%` or a bitwise operator, an array key), warning as
 * PHP does about a value out of range and deprecating one with a fraction.
 */
export function toIntForOperator(value: bigint | number, pending?: PhpThrow, warning?: UpdateWarning): bigint {
  if (typeof value === 'bigint') return value;
  if (!floatFitsInt(value)) {
    const result = floatToIntCast(value, pending, warning);
    if (Number.isNaN(value))
      operatorDiagnostic(pending, deprecated, 'Implicit conversion from float NAN to int loses precision', warning);
    return result;
  }
  if (!Number.isInteger(value)) {
    operatorDiagnostic(
      pending,
      deprecated,
      `Implicit conversion from float ${formatFloatForMessage(value)} to int loses precision`,
      warning
    );
  }
  return BigInt(Math.trunc(value));
}

/** Converts a numeric string holding a float where PHP needs an int, deprecating a value an int cannot hold. */
function floatStringToInt(text: string, value: number, pending?: PhpThrow): bigint {
  const result = floatToIntCap(value);
  if (Number(result) !== value)
    operatorDiagnostic(pending, deprecated, `Implicit conversion from float-string "${text}" to int loses precision`);
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

export function concat(left: Value, right: Value, pending?: PhpThrow): string {
  const a = concatenateOperand(left, pending);
  const b = concatenateOperand(right, pending);
  rt().ensureStringFits(a.length + b.length);
  return a + b;
}

function concatenateOperand(value: Value, pending?: PhpThrow): string {
  if (!pending) return toStr(value);
  if (value instanceof PhpObject && !value.isResource) throw pending;
  return stringify(value, () => {
    throw pending;
  });
}

/** Converts an operand of `%` or a bitwise operator to an int, as PHP's zendi_try_get_long does. */
function intOperand(value: Value, op: string, left: Value, right: Value, pending?: PhpThrow): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return toIntForOperator(value, pending);
  if (value === null) return 0n;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') {
    const prefix = numericPrefix(value);
    if (!prefix) unsupportedOperands(op, left, right, pending);
    if (!prefix.whole) operatorDiagnostic(pending, warn, 'A non-numeric value encountered');
    return typeof prefix.value === 'bigint' ? prefix.value : floatStringToInt(value, prefix.value, pending);
  }
  return unsupportedOperands(op, left, right, pending);
}

export function bitwise(op: string, left: Value, right: Value, pending?: PhpThrow): Value {
  if ((op === '&' || op === '|' || op === '^') && typeof left === 'string' && typeof right === 'string') {
    return bytewise(op, left, right);
  }
  const a = intOperand(left, op, left, right, pending);
  const b = intOperand(right, op, left, right, pending);
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
  return a === b ? 0 : (compareNumericStrings(a, b) ?? Math.sign(compareBytes(a, b)));
}

function compareNumericStrings(a: string, b: string): number | undefined {
  const x = numericValue(a);
  const y = numericValue(b);
  if (x === undefined || y === undefined) return;
  const order = compareNumbers(x, y);
  if (order !== 0) return order;
  const xOverflow = typeof x === 'number' && isIntegerText(a);
  const yOverflow = typeof y === 'number' && isIntegerText(b);
  if (xOverflow && typeof y === 'bigint') return Math.sign(x);
  if (yOverflow && typeof x === 'bigint') return -Math.sign(y);
  if (!(xOverflow && yOverflow) && Number.isFinite(Number(x))) return 0;
}

type ComparisonMode = 'order' | 'strict';
type ObjectString = (object: PhpObject) => string | undefined;
type ComparisonOperand = Value | Ref;
type ComparisonPair = [ComparisonOperand, ComparisonOperand, ComparisonMode];
interface ComparisonFrame {
  owner: PhpArray | PhpObject;
  pairs: Generator<ComparisonPair, number>;
}

/** The result of PHP's `<=>`, where 1 also stands for values PHP cannot order. */
export function compare(a: ComparisonOperand, b: ComparisonOperand, tryString?: ObjectString): number {
  return walkComparison(a, b, 'order', tryString);
}

export function looseEquals(a: Value, b: Value): boolean {
  return compare(a, b) === 0;
}

export function strictEquals(a: Value, b: Value): boolean {
  return walkComparison(a, b, 'strict') === 0;
}

// code-gauge-allow functionCognitiveComplexity 23 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function walkComparison(
  a: ComparisonOperand,
  b: ComparisonOperand,
  mode: ComparisonMode,
  tryString?: ObjectString
): number {
  const stack: ComparisonFrame[] = [];
  const active = new Set<PhpArray | PhpObject>();
  let pair: ComparisonPair | undefined = [a, b, mode];
  for (;;) {
    if (pair) {
      rt().spend();
      const result = comparisonStep(...pair, tryString);
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

// code-gauge-allow functionCognitiveComplexity 26 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function comparisonStep(
  left: ComparisonOperand,
  right: ComparisonOperand,
  mode: ComparisonMode,
  tryString?: ObjectString
): number | ComparisonFrame {
  const a = deref(left);
  const b = deref(right);
  if (a === b) return typeof a === 'number' && Number.isNaN(a) ? 1 : 0;
  if (a instanceof PhpArray && b instanceof PhpArray) {
    if (a.size !== b.size) return a.size < b.size ? -1 : 1;
    return { owner: a, pairs: arrayComparisonPairs(a, b, mode) };
  }
  if (mode === 'strict') return 1;
  if ((a instanceof PhpObject && a.isResource) || (b instanceof PhpObject && b.isResource)) return compareScalar(a, b);
  if (a instanceof PhpObject && b instanceof PhpObject) {
    const native = a.cls.compare && a.cls.compare === b.cls.compare ? a.cls.compare(a, b) : undefined;
    if (typeof native === 'number') return native;
    if (native === undefined && a.cls !== b.cls) return 1;
    return { owner: a, pairs: objectComparisonPairs(a, b, native) };
  }
  return compareScalar(left, right, tryString);
}

function* arrayComparisonPairs(a: PhpArray, b: PhpArray, mode: ComparisonMode): Generator<ComparisonPair, number> {
  const right = mode === 'strict' ? b.map.physicalEntries() : undefined;
  for (const [key, value] of a.map.physicalEntries()) {
    if (right) {
      const item = right.next();
      if (item.done || item.value[0] !== key) return 1;
      yield [comparedBucket(value), comparedBucket(item.value[1]), mode];
    } else {
      const other = b.map.get(key);
      if (other === undefined) return 1;
      yield [comparedBucket(value), comparedBucket(other), mode];
    }
  }
  return 0;
}

function comparedBucket(slot: Value | Ref): Value | Ref {
  // oxlint-disable-next-line unicorn/no-null -- Zend compares raw undefined buckets as PHP null.
  return slot === UNDEFINED_RESULT ? null : slot;
}

function* objectComparisonPairs(
  a: PhpObject,
  b: PhpObject,
  native?: Generator<[Value, Value, 'order'], number | undefined>
): Generator<ComparisonPair, number> {
  if (native !== undefined) {
    const result = yield* native;
    if (result !== undefined) return result;
  }
  if (a.cls !== b.cls) return 1;
  return yield* propertyComparisonPairs(a, b);
}

function* propertyComparisonPairs(a: PhpObject, b: PhpObject): Generator<ComparisonPair, number> {
  const dynamic = hasDynamicProps(a) || hasDynamicProps(b);
  if (dynamic && a.props.size !== b.props.size) return Math.sign(a.props.size - b.props.size);
  const names = dynamic ? a.props.keys() : new Set([...a.props.keys(), ...b.props.keys()]);
  for (const name of names) {
    if (dynamic && !b.props.has(name)) return 1;
    const left = comparisonProperty(a, name);
    const right = comparisonProperty(b, name);
    if (left === undefined) {
      if (right !== undefined) return 1;
      continue;
    }
    if (right === undefined) return 1;
    yield [left, right, 'order'];
  }
  return 0;
}

function comparisonProperty(object: PhpObject, name: string): ComparisonOperand | undefined {
  const slot = object.props.get(name);
  return slot === UNINIT ? undefined : slot;
}

function hasDynamicProps(object: PhpObject): boolean {
  return [...object.props.keys()].some((key) => !key.startsWith('\0') && !object.cls.propByName.has(key));
}

// code-gauge-allow functionNcss 41 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function compareScalar(left: ComparisonOperand, right: ComparisonOperand, tryString?: ObjectString): number {
  const a = deref(left);
  const b = deref(right);
  if (a === UNDEFINED_RESULT || b === UNDEFINED_RESULT) {
    warn('Undefined variable $');
    // oxlint-disable-next-line unicorn/no-null -- The comparison reads an undefined operand as PHP null.
    return compareScalar(a === UNDEFINED_RESULT ? null : left, b === UNDEFINED_RESULT ? null : right, tryString);
  }
  if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) {
    return compareNumbers(a, b);
  }
  if (typeof a === 'string' && typeof b === 'string') return compareStrings(a, b);
  if (typeof a === 'boolean' || typeof b === 'boolean' || a === null || b === null) {
    if (a === null && typeof b === 'string') return b === '' ? 0 : -1;
    if (b === null && typeof a === 'string') return a === '' ? 0 : 1;
    if (a === null && b instanceof PhpObject) return -1;
    if (b === null && a instanceof PhpObject) return 1;
    const x = boolValue(a);
    const y = boolValue(b);
    return x === y ? 0 : x ? 1 : -1;
  }
  if (a instanceof PhpObject && a.isResource) return compareResource(a, b, true);
  if (b instanceof PhpObject && b.isResource) return compareResource(b, a, false);
  if (
    (typeof a === 'number' &&
      Number.isNaN(a) &&
      (typeof b === 'string' || typeof b === 'bigint' || typeof b === 'number')) ||
    (typeof b === 'number' &&
      Number.isNaN(b) &&
      (typeof a === 'string' || typeof a === 'bigint' || typeof a === 'number'))
  )
    return 1;
  if (typeof a === 'string' && (typeof b === 'bigint' || typeof b === 'number')) return compareStringNumber(a, b);
  if (typeof b === 'string' && (typeof a === 'bigint' || typeof a === 'number')) return -compareStringNumber(b, a);
  if (a instanceof PhpObject) return compareObjectScalar(a, right, true, tryString);
  if (b instanceof PhpObject) return compareObjectScalar(b, left, false, tryString);
  if (a instanceof PhpArray) return 1;
  if (b instanceof PhpArray) return -1;
  return 1;
}

function compareResource(resource: PhpObject, value: Value, resourceOnLeft: boolean): number {
  const id = BigInt(resource.id);
  if (value instanceof PhpArray || (value instanceof PhpObject && !value.isResource)) return resourceOnLeft ? -1 : 1;
  let number: bigint | number;
  if (value instanceof PhpObject) number = BigInt(value.id);
  else if (typeof value === 'string') number = numericPrefix(value)?.value ?? 0n;
  else number = typeof value === 'number' ? value : toInt(value);
  return resourceOnLeft ? compareNumbers(id, number) : compareNumbers(number, id);
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
function compareObjectScalar(
  object: PhpObject,
  slot: ComparisonOperand,
  objectOnLeft: boolean,
  tryString: ObjectString = objectToString
): number {
  const other = deref(slot);
  const uncast = objectOnLeft ? 1 : -1;
  let cast: Value;
  if (typeof other === 'string' && object.cls.findMethod('__tostring')) {
    const text = tryString(object);
    if (text === undefined) return uncast;
    cast = text;
  } else if (typeof other === 'bigint' || typeof other === 'number') {
    const kind = typeof other === 'bigint' ? 'int' : 'float';
    notice(`Object of class ${object.cls.name} could not be converted to ${kind}`);
    cast = typeof other === 'bigint' ? 1n : 1;
  } else return uncast;
  return objectOnLeft ? compare(cast, slot, tryString) : compare(slot, cast, tryString);
}

/** Whether a numeric string is written as an integer, which a float holds only when the integer overflows. */
function isIntegerText(text: string): boolean {
  return /^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/.test(text);
}

// Keys -----------------------------------------------------------------------------------------------------------------

/** What an array key is used for, which PHP names in the error for a key of an invalid type. */
export type KeyUse = 'access' | 'isset' | 'unset';

/** Converts a value to an array key, as `$a[$key]` does, throwing for keys PHP rejects. */
export function toKey(value: Value, use: KeyUse = 'access', container = 'array', warning?: UpdateWarning): Key {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return normalizeKeyString(value);
  if (value === null) {
    operatorDiagnostic(
      undefined,
      deprecated,
      'Using null as an array offset is deprecated, use an empty string instead',
      warning
    );
    return '';
  }
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return toIntForOperator(value, undefined, warning);
  const type = debugType(value);
  if (use === 'isset') throwError('TypeError', `Cannot access offset of type ${type} in isset or empty`);
  throwError('TypeError', `Cannot ${use === 'unset' ? 'unset' : 'access'} offset of type ${type} on ${container}`);
}
