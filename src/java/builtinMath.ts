import { addConstant, addMethod } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, DOUBLE, FLOAT, INT, type JavaType, LONG } from './types';
import { convertNumber, toInt32, toInt64, type Value } from './values';

export function defineMath(mathClass: ClassInfo): void {
  for (const type of [INT, LONG, FLOAT, DOUBLE]) {
    addMethod(mathClass, 'abs', [type], type, true, (_, __, [value]) => absolute(value, type));
    addMethod(mathClass, 'max', [type, type], type, true, (_, __, [a, b]) => extreme(a, b, 1));
    addMethod(mathClass, 'min', [type, type], type, true, (_, __, [a, b]) => extreme(a, b, -1));
  }
  // Math.round rounds half up: floor(x + 0.5) computed exactly, which JavaScript's Math.round also does.
  addMethod(mathClass, 'round', [DOUBLE], LONG, true, (_, __, [value]) =>
    convertNumber(Math.round(value as number), 'double', 'long')
  );
  addMethod(mathClass, 'round', [FLOAT], INT, true, (_, __, [value]) =>
    convertNumber(Math.round(value as number), 'double', 'int')
  );
  for (const name of [
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'log',
    'log10',
    'exp',
    'cbrt',
    'sqrt',
    'floor',
    'ceil',
  ] as const) {
    addMethod(mathClass, name, [DOUBLE], DOUBLE, true, (_, __, [value]) => Math[name](value as number));
  }
  addMethod(mathClass, 'pow', [DOUBLE, DOUBLE], DOUBLE, true, (_, __, [a, b]) => (a as number) ** (b as number));
  addMethod(mathClass, 'atan2', [DOUBLE, DOUBLE], DOUBLE, true, (_, __, [y, x]) =>
    Math.atan2(y as number, x as number)
  );
  addMethod(mathClass, 'hypot', [DOUBLE, DOUBLE], DOUBLE, true, (_, __, [x, y]) =>
    Math.hypot(x as number, y as number)
  );
  addMethod(mathClass, 'rint', [DOUBLE], DOUBLE, true, (_, __, [value]) => roundHalfEven(value as number));
  for (const type of [FLOAT, DOUBLE]) {
    addMethod(mathClass, 'signum', [type], type, true, (_, __, [value]) => Math.sign(value as number));
  }
  addMethod(mathClass, 'toRadians', [DOUBLE], DOUBLE, true, (_, __, [value]) => ((value as number) / 180) * Math.PI);
  addMethod(mathClass, 'toDegrees', [DOUBLE], DOUBLE, true, (_, __, [value]) => ((value as number) * 180) / Math.PI);
  for (const type of [INT, LONG]) {
    for (const name of ['floorDiv', 'floorMod'] as const) {
      addMethod(mathClass, name, [type, type], type, true, (frame, _, [a, b]) => floorDivision(frame, a, b, name));
    }
  }
  addConstant(mathClass, 'PI', DOUBLE, Math.PI);
  addConstant(mathClass, 'E', DOUBLE, Math.E);
  defineIntegerArithmetic(mathClass);
}

/** `Math.rint`, which rounds to the nearest integer and a tie to the even one, keeping the sign of zero. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The methods that throw `ArithmeticException` instead of overflowing, `ceilDiv`, and `clamp`. */
function defineIntegerArithmetic(mathClass: ClassInfo): void {
  for (const type of [INT, LONG]) {
    const isLong = type === LONG;
    for (const [name, operate] of Object.entries(EXACT_BINARY)) {
      addMethod(mathClass, name, [type, type], type, true, (frame, _, [a, b]) =>
        exactResult(frame, operate(BigInt(a as number | bigint), BigInt(b as number | bigint)), isLong)
      );
    }
    for (const [name, operate] of Object.entries(EXACT_UNARY)) {
      addMethod(mathClass, name, [type], type, true, (frame, _, [a]) =>
        exactResult(frame, operate(BigInt(a as number | bigint)), isLong)
      );
    }
    addMethod(mathClass, 'ceilDiv', [type, type], type, true, (frame, _, [a, b]) =>
      ceilDivision(frame, BigInt(a as number | bigint), BigInt(b as number | bigint), isLong)
    );
  }
  addMethod(mathClass, 'toIntExact', [LONG], INT, true, (frame, _, [value]) => {
    if (value !== BigInt.asIntN(32, value as bigint)) throwBuiltin(frame, 'ArithmeticException', 'integer overflow');
    return Number(value);
  });
  addMethod(mathClass, 'clamp', [LONG, INT, INT], INT, true, (frame, _, [value, min, max]) =>
    Number(clamp(frame, value as bigint, BigInt(min as number), BigInt(max as number)))
  );
  addMethod(mathClass, 'clamp', [DOUBLE, DOUBLE, DOUBLE], DOUBLE, true, (frame, _, [value, min, max]) =>
    clamp(frame, value as number, min as number, max as number)
  );
}

/** The result of an exact operation, which must fit an int, or a long when `isLong`. */
function exactResult(frame: Frame, result: bigint, isLong: boolean): Value {
  if (result !== BigInt.asIntN(isLong ? 64 : 32, result)) {
    throwBuiltin(frame, 'ArithmeticException', isLong ? 'long overflow' : 'integer overflow');
  }
  return isLong ? result : Number(result);
}

/** `Math.ceilDiv`, which rounds the quotient toward positive infinity. */
function ceilDivision(frame: Frame, x: bigint, y: bigint, isLong: boolean): Value {
  if (y === 0n) throwBuiltin(frame, 'ArithmeticException', '/ by zero');
  const quotient = x / y + (x % y !== 0n && x < 0n === y < 0n ? 1n : 0n);
  return isLong ? BigInt.asIntN(64, quotient) : toInt32(Number(quotient));
}

const EXACT_BINARY: Record<string, (a: bigint, b: bigint) => bigint> = {
  addExact: (a, b) => a + b,
  subtractExact: (a, b) => a - b,
  multiplyExact: (a, b) => a * b,
};

const EXACT_UNARY: Record<string, (a: bigint) => bigint> = {
  negateExact: (a) => -a,
  incrementExact: (a) => a + 1n,
  decrementExact: (a) => a - 1n,
  absExact: (a) => (a < 0n ? -a : a),
};

function clamp<T extends number | bigint>(frame: Frame, value: T, min: T, max: T): T {
  if (min > max) throwBuiltin(frame, 'IllegalArgumentException', `${String(min)} > ${String(max)}`);
  if (value < min) return min;
  return value > max ? max : value;
}

/** `Math.abs`, which leaves the most negative int and long unchanged, as their negations overflow. */
function absolute(value: Value, type: JavaType): Value {
  if (typeof value === 'bigint') return toInt64(value < 0n ? -value : value);
  return type === INT ? toInt32(Math.abs(value as number)) : Math.abs(value as number);
}

/** `Math.max` (`sign` 1) or `Math.min` (-1), which give NaN for NaN and order -0.0 below 0.0. */
function extreme(a: Value, b: Value, sign: number): Value {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a > b === sign > 0 ? a : b;
  const [x, y] = [a as number, b as number];
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === 0 && y === 0) return Object.is(x, -0) === sign > 0 ? y : x;
  return sign > 0 ? Math.max(x, y) : Math.min(x, y);
}

/** `Math.floorDiv` and `Math.floorMod`, which round the quotient toward negative infinity. */
function floorDivision(frame: Frame, a: Value, b: Value, name: 'floorDiv' | 'floorMod'): Value {
  if (b === 0 || b === 0n) throwBuiltin(frame, 'ArithmeticException', '/ by zero');
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    const quotient = a / b - (a % b !== 0n && a < 0n !== b < 0n ? 1n : 0n);
    return name === 'floorDiv' ? toInt64(quotient) : a - quotient * b;
  }
  const [x, y] = [a as number, b as number];
  const quotient = Math.floor(x / y);
  return name === 'floorDiv' ? toInt32(quotient) : x - quotient * y;
}
