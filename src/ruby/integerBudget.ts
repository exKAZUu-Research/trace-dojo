import { rt } from './runtime';

export function integerBits(value: bigint): number {
  return (value < 0n ? -value : value).toString(2).length;
}

export function chargeIntegerResult(bits: number, cost: number): void {
  rt().spend(Math.ceil(bits / 256) + Math.ceil(cost / 4096));
}
