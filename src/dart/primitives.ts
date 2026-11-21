import { formatDouble } from './format';
import type { Value } from './values';

export function isPrimitive(value: Value): value is undefined | boolean | bigint | number | string {
  return value === undefined || typeof value !== 'object';
}

export function primitiveEquals(a: Value, b: Value): boolean {
  if (typeof a === 'bigint' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'number' && typeof b === 'bigint') return a === Number(b);
  return a === b;
}

export function primitiveText(value: undefined | boolean | bigint | number | string): string {
  if (value === undefined) return 'null';
  if (typeof value === 'number') return formatDouble(value);
  return String(value);
}
