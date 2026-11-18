import koffi from 'koffi';

const libraryPath =
  process.platform === 'darwin'
    ? '/usr/lib/libSystem.B.dylib'
    : process.platform === 'win32'
      ? 'ucrtbase.dll'
      : 'libm.so.6';
let library: ReturnType<typeof koffi.load> | undefined;
const unary = new Map<string, (value: number) => number>();
let powers:
  | { double: (base: number, exponent: number) => number; float: (base: number, exponent: number) => number }
  | undefined;

export function platformUnary(name: string, value: number, isFloat: boolean): number {
  const symbol = `${name.toLowerCase()}${isFloat ? 'f' : ''}`;
  let operation = unary.get(symbol);
  if (!operation) {
    library ??= koffi.load(libraryPath);
    const type = isFloat ? 'float' : 'double';
    operation = library.func(`${type} ${symbol}(${type})`) as (value: number) => number;
    unary.set(symbol, operation);
  }
  return operation(value);
}

export function platformPower(base: number, exponent: number, isFloat: boolean): number {
  library ??= koffi.load(libraryPath);
  powers ??= {
    double: library.func('double pow(double, double)') as (base: number, exponent: number) => number,
    float: library.func('float powf(float, float)') as (base: number, exponent: number) => number,
  };
  return (isFloat ? powers.float : powers.double)(base, exponent);
}
