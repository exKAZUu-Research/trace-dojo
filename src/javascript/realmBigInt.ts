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
  builder.method(bigintConstructor, 'asIntN', 2, ({ runtime, args }) =>
    BigInt.asIntN(bitCount(runtime, args[0]), toBigInt(runtime, args[1]))
  );
  builder.method(bigintConstructor, 'asUintN', 2, ({ runtime, args }) =>
    BigInt.asUintN(bitCount(runtime, args[0]), toBigInt(runtime, args[1]))
  );
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
    try {
      return BigInt(value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return runtime.throwError('SyntaxError', `Cannot convert ${value} to a BigInt`);
    }
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
