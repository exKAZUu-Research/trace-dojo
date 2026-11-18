import koffi from 'koffi';

const libraryPath =
  process.platform === 'darwin'
    ? '/usr/lib/libSystem.B.dylib'
    : process.platform === 'win32'
      ? 'ucrtbase.dll'
      : 'libm.so.6';
let library: ReturnType<typeof koffi.load> | undefined;
const unary = new Map<string, (value: number) => number>();
const binary = new Map<string, (left: number, right: number) => number>();

export function platformUnary(name: string, value: number, isFloat = false): number {
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
  return platformBinary('pow', base, exponent, isFloat);
}

export function platformBinary(name: 'pow' | 'atan2' | 'hypot', left: number, right: number, isFloat = false): number {
  const symbol = isFloat ? `${name}f` : name;
  let operation = binary.get(symbol);
  if (!operation) {
    library ??= koffi.load(libraryPath);
    const type = isFloat ? 'float' : 'double';
    operation = library.func(`${type} ${symbol}(${type}, ${type})`) as (left: number, right: number) => number;
    binary.set(symbol, operation);
  }
  return operation(left, right);
}
