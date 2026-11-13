import koffi from 'koffi';

import { UnsupportedFeatureError } from './runtime';

let functions: { gamma: (value: number) => number; logGamma: (value: number, sign: number[]) => number } | undefined;

const nativeMath = (): NonNullable<typeof functions> => {
  if (functions) return functions;
  const name =
    process.platform === 'darwin'
      ? '/usr/lib/libSystem.B.dylib'
      : process.platform === 'linux'
        ? 'libm.so.6'
        : undefined;
  if (!name) throw new UnsupportedFeatureError('Math.gamma / Math.lgamma');
  const library = koffi.load(name);
  functions = {
    gamma: library.func('double tgamma(double)') as (value: number) => number,
    logGamma: library.func('double lgamma_r(double, _Out_ int *)') as (value: number, sign: number[]) => number,
  };
  return functions;
};

export const platformGamma = (value: number): number => nativeMath().gamma(value);

export const platformLogGamma = (value: number): [number, number] => {
  const sign = [1];
  return [nativeMath().logGamma(value, sign), sign[0]];
};
