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
  for (const name of ['sin', 'cos', 'tan', 'log', 'log10', 'exp', 'cbrt', 'sqrt', 'floor', 'ceil'] as const) {
    addMethod(mathClass, name, [DOUBLE], DOUBLE, true, (_, __, [value]) => Math[name](value as number));
  }
  addMethod(mathClass, 'pow', [DOUBLE, DOUBLE], DOUBLE, true, (_, __, [a, b]) => (a as number) ** (b as number));
  addMethod(mathClass, 'atan2', [DOUBLE, DOUBLE], DOUBLE, true, (_, __, [y, x]) =>
    Math.atan2(y as number, x as number)
  );
  addMethod(mathClass, 'signum', [DOUBLE], DOUBLE, true, (_, __, [value]) => Math.sign(value as number));
  addMethod(mathClass, 'toRadians', [DOUBLE], DOUBLE, true, (_, __, [value]) => ((value as number) / 180) * Math.PI);
  addMethod(mathClass, 'toDegrees', [DOUBLE], DOUBLE, true, (_, __, [value]) => ((value as number) * 180) / Math.PI);
  for (const type of [INT, LONG]) {
    for (const name of ['floorDiv', 'floorMod'] as const) {
      addMethod(mathClass, name, [type, type], type, true, (frame, _, [a, b]) => floorDivision(frame, a, b, name));
    }
  }
  addConstant(mathClass, 'PI', DOUBLE, Math.PI);
  addConstant(mathClass, 'E', DOUBLE, Math.E);
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
