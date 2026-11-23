import { assert } from 'es-toolkit';

import { decodeFloat, encodeFloat } from './floatEncoding';
import { type AnyFloat, type FloatBits, toNumber } from './floats';
import { referenceMathBytes } from './referenceMathBytes';
import type { BinaryOperation, UnaryOperation } from './referenceMathOperations';

const bytes = Uint8Array.from(atob(referenceMathBytes), (character) => character.codePointAt(0)!);
const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;

export function referenceUnary(name: UnaryOperation, bits: FloatBits, value: AnyFloat): AnyFloat {
  return calculate(name, bits, [value]);
}

export function referenceBinary(name: BinaryOperation, bits: FloatBits, left: AnyFloat, right: AnyFloat): AnyFloat {
  return calculate(name, bits, [left, right]);
}

function calculate(name: string, bits: FloatBits, values: readonly AnyFloat[]): AnyFloat {
  const args: (number | bigint)[] = [];
  for (const value of values) {
    if (bits <= 64) args.push(typeof value === 'number' ? value : toNumber(value, bits as 16 | 32 | 64));
    else {
      const pattern = encodeFloat(value, bits);
      args.push(BigInt.asUintN(64, pattern), pattern >> 64n);
    }
  }
  const result = invoke(`${name}${bits}`, args);
  if (bits <= 64) {
    assert(typeof result === 'number', 'A float of at most 64 bits must come back as a number');
    return result;
  }
  const low = invoke('resultLow', []);
  const high = invoke('resultHigh', []);
  assert(typeof low === 'bigint' && typeof high === 'bigint', 'The result halves must be bigints');
  return decodeFloat(BigInt.asUintN(64, low) | (BigInt.asUintN(64, high) << 64n), bits);
}

function invoke(name: string, args: readonly (number | bigint)[]): unknown {
  const callable = exports[name];
  assert(typeof callable === 'function', name);
  return callable(...args);
}
