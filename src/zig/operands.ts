import type { BinaryOperator } from './ast';
import { type AnyFloat, BigFloat, compareFloats } from './floats';
import type { Type } from './types';
import type { Value } from './values';

export function isIntegerType(type: Type): boolean {
  return type.kind === 'int' || type.kind === 'comptime_int';
}

export function comparisonTest(operator: BinaryOperator): (order: number) => boolean {
  switch (operator) {
    case '==': {
      return (order) => order === 0;
    }
    case '!=': {
      return (order) => order !== 0;
    }
    case '<': {
      return (order) => order < 0;
    }
    case '>': {
      return (order) => order > 0;
    }
    case '<=': {
      return (order) => order <= 0;
    }
    default: {
      return (order) => order >= 0;
    }
  }
}

export function isArithmeticType(type: Type): boolean {
  return type.kind === 'int' || type.kind === 'comptime_int' || type.kind === 'float' || type.kind === 'comptime_float';
}

export function isZero(value: Value): boolean {
  if (typeof value === 'bigint') return value === 0n;
  if (typeof value === 'number') return value === 0;
  return value instanceof BigFloat && value.isZero;
}

/** The sign of a known integer or float: -1, 0, or 1 (NaN counts as negative, which no check accepts). */
export function sign(value: Value): number {
  if (typeof value === 'bigint') return value < 0n ? -1 : value > 0n ? 1 : 0;
  return compareFloats(value as AnyFloat, 0) ?? -1;
}
