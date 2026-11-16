import koffi from 'koffi';

let powers:
  | { double: (base: number, exponent: number) => number; float: (base: number, exponent: number) => number }
  | undefined;

export function platformPower(base: number, exponent: number, isFloat: boolean): number {
  powers ??= loadPowers();
  return (isFloat ? powers.float : powers.double)(base, exponent);
}

function loadPowers(): NonNullable<typeof powers> {
  const path =
    process.platform === 'darwin'
      ? '/usr/lib/libSystem.B.dylib'
      : process.platform === 'win32'
        ? 'ucrtbase.dll'
        : 'libm.so.6';
  const library = koffi.load(path);
  return {
    double: library.func('double pow(double, double)') as (base: number, exponent: number) => number,
    float: library.func('float powf(float, float)') as (base: number, exponent: number) => number,
  };
}
