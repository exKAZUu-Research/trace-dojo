/** `pow` of C, which the languages' reference implementations call; `Math.pow` returns NaN in these cases. */
export function power(base: number, exponent: number): number {
  if (base === 1 || (base === -1 && Math.abs(exponent) === Number.POSITIVE_INFINITY)) return 1;
  return Math.pow(base, exponent);
}
