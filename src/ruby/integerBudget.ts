import { rt } from './runtime';

export function integerGcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  const cost = 1 + Math.ceil(Math.max(integerBits(x), integerBits(y)) / 4096);
  while (y !== 0n) {
    rt().spend(cost);
    [x, y] = [y, x % y];
  }
  return x;
}

export function integerBits(value: bigint): number {
  return (value < 0n ? -value : value).toString(2).length;
}

export function chargeIntegerResult(bits: number, cost: number): void {
  rt().spend(Math.ceil(bits / 256) + Math.ceil(cost / 4096));
}
