import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassInfo, JavaType } from './types';

/** Java `null` is `undefined`; `int`, `char`, and `double` are numbers. */
export type Value = number | boolean | JavaString | JavaObject | JavaArray | undefined;

/** Strings are objects so that `==` compares references as in Java. */
export class JavaString {
  constructor(readonly value: string) {}
}

let nextIdentity = 1;

export class JavaObject {
  readonly fields: Value[];
  readonly identity = nextIdentity++;
  /** Set by the builtin Turtle constructor. */
  turtle?: TurtleState;
  /** Set by the builtin Throwable constructors. */
  message?: JavaString;
  cause?: JavaObject;

  constructor(readonly cls: ClassInfo) {
    this.fields = Array.from({ length: cls.instanceFieldCount });
    for (const field of cls.instanceFields) this.fields[field.slot] = defaultValue(field.type);
  }
}

export class JavaArray {
  readonly identity = nextIdentity++;

  constructor(
    readonly elementType: JavaType,
    readonly values: Value[]
  ) {}
}

export function defaultValue(type: JavaType): Value {
  switch (type.kind) {
    case 'int':
    case 'char':
    case 'double': {
      return 0;
    }
    case 'boolean': {
      return false;
    }
    default: {
      return undefined;
    }
  }
}

/** Formats a double as `Double.toString` does (JDK 19 and later print the shortest round-trip digits). */
export function formatDouble(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (magnitude >= 1e-3 && magnitude < 1e7) {
    const text = String(magnitude);
    return `${sign}${text.includes('.') ? text : `${text}.0`}`;
  }
  const [mantissa, exponent] = magnitude.toExponential().split('e');
  return `${sign}${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}

/** Wraps a number to 32 bits as Java's int arithmetic does. */
export function toInt32(value: number): number {
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps around at 32 bits, which Math.trunc does not.
  return value | 0;
}

/** Java chars are UTF-16 code units, so a char is read as a code unit, not a code point. */
export function charCodeOf(text: string, index: number): number {
  // oxlint-disable-next-line unicorn/prefer-code-point -- Java chars are UTF-16 code units.
  return text.charCodeAt(index);
}

/** Narrows a double to int as Java does: NaN becomes 0 and out-of-range values saturate. */
export function doubleToInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value >= 2_147_483_647) return 2_147_483_647;
  if (value <= -2_147_483_648) return -2_147_483_648;
  return Math.trunc(value);
}

export function charToString(code: number): string {
  return String.fromCodePoint(code);
}
