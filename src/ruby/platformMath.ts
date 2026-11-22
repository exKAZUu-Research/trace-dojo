import gamma from '@stdlib/math-base-special-gamma';
import gammaln from '@stdlib/math-base-special-gammaln';

export const platformGamma = (value: number): number => gamma(value);

/** The logarithm of the absolute value of the gamma function, and the sign of the gamma function. */
export const platformLogGamma = (value: number): [number, number] => [
  gammaln(value),
  value < 0 && !Number.isInteger(value) && Math.floor(value) % 2 !== 0 ? -1 : 1,
];
