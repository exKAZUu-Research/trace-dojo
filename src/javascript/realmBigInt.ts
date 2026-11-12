import { bitLength, chargeBigInt } from './expressionEvaluator';
import type { RealmBuilder } from './realm';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import type { Value } from './values';

/** Defines BigInt and BigInt.prototype, which convert as JavaScript's BigInt does and print without the `n`. */
export function defineBigIntBuiltins(builder: RealmBuilder): void {
  const { bigintPrototype } = builder.realm;
  const bigintConstructor = builder.defineClass(
    'BigInt',
    1,
    bigintPrototype,
    ({ runtime, args }) => toBigInt(runtime, runtime.toPrimitive(args[0], 'number')),
    false
  );
  for (const [name, narrow] of [
    ['asIntN', (bits: number, value: bigint) => BigInt.asIntN(bits, value)],
    ['asUintN', (bits: number, value: bigint) => BigInt.asUintN(bits, value)],
  ] as const) {
    builder.method(bigintConstructor, name, 2, ({ runtime, args }) => {
      const bits = bitCount(runtime, args[0]);
      const value = toBigIntStrictly(runtime, args[1]);
      // The result has up to `bits` bits, which a negative value fills for asUintN, so it is charged as `*` is.
      chargeBigInt(runtime, Math.min(bits, value < 0n ? bits : bitLength(value)));
      return narrow(bits, value);
    });
  }
  builder.method(bigintPrototype, 'toString', 0, ({ runtime, thisValue, args }) => {
    const radix = args[0] === undefined ? 10 : Math.trunc(runtime.toNumber(args[0]));
    if (!(radix >= 2 && radix <= 36)) runtime.throwError('RangeError', 'toString() radix must be between 2 and 36');
    return thisBigInt(runtime, thisValue, 'toString').toString(radix);
  });
  builder.method(bigintPrototype, 'toLocaleString', 0, ({ runtime, thisValue }) =>
    thisBigInt(runtime, thisValue, 'toLocaleString').toLocaleString('en-US')
  );
  builder.method(bigintPrototype, 'valueOf', 0, ({ runtime, thisValue }) => thisBigInt(runtime, thisValue, 'valueOf'));
  builder.constant(bigintPrototype, WELL_KNOWN_SYMBOLS.toStringTag, 'BigInt');
}

/** Converts a value to a BigInt as the spec's ToBigInt does, which rejects numbers. */
function toBigIntStrictly(runtime: Runtime, value: Value): bigint {
  const primitive = runtime.toPrimitive(value, 'number');
  if (typeof primitive === 'number') {
    return runtime.throwError('TypeError', `Cannot convert ${runtime.toString(primitive)} to a BigInt`);
  }
  return toBigInt(runtime, primitive);
}

/** Converts a primitive to a BigInt as `BigInt(value)` does, where a number must be an integer. */
function toBigInt(runtime: Runtime, value: Value): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return runtime.throwError(
        'RangeError',
        `The number ${runtime.toString(value)} cannot be converted to a BigInt because it is not an integer`
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') {
    runtime.scan(value.length);
    let result: bigint;
    try {
      result = BigInt(value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return runtime.throwError('SyntaxError', `Cannot convert ${value} to a BigInt`);
    }
    chargeBigInt(runtime, bitLength(result));
    return result;
  }
  return runtime.throwError('TypeError', `Cannot convert ${runtime.describe(value)} to a BigInt`);
}

function bitCount(runtime: Runtime, value: Value): number {
  const bits = Math.trunc(runtime.toNumber(value)) || 0;
  if (bits < 0 || bits > 2 ** 53 - 1)
    runtime.throwError('RangeError', 'Invalid value: not (convertible to) a safe integer');
  return bits;
}

function thisBigInt(runtime: Runtime, value: Value, name: string): bigint {
  if (typeof value === 'bigint') return value;
  return runtime.throwError('TypeError', `BigInt.prototype.${name} requires that 'this' be a BigInt`);
}
