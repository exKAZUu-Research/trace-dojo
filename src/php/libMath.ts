// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { randomInt } from 'node:crypto';

import { debugType, formatFloat } from './conversions';
import { deprecated, throwError } from './errors';
import { defineAlias, defineConstant, defineFunction } from './native';
import { arithmetic, compare } from './operators';
import { rt } from './runtime';
import { fixedDigits, phpRound, type RoundMode } from './strings';
import { PhpArray, type Value } from './values';

const MATH_CONSTANTS: [string, number][] = [
  ['M_PI', Math.PI],
  ['M_E', Math.E],
  ['M_LOG2E', Math.LOG2E],
  ['M_LOG10E', Math.LOG10E],
  ['M_LN2', Math.LN2],
  ['M_LN10', Math.LN10],
  ['M_PI_2', Math.PI / 2],
  ['M_PI_4', Math.PI / 4],
  ['M_1_PI', 1 / Math.PI],
  ['M_2_PI', 2 / Math.PI],
  ['M_SQRTPI', Math.sqrt(Math.PI)],
  ['M_2_SQRTPI', 2 / Math.sqrt(Math.PI)],
  ['M_SQRT2', Math.SQRT2],
  ['M_SQRT3', Math.sqrt(3)],
  ['M_SQRT1_2', Math.SQRT1_2],
  ['M_LNPI', Math.log(Math.PI)],
  ['M_EULER', 0.5772156649015329],
];
for (const [name, value] of MATH_CONSTANTS) defineConstant(name, value);
defineConstant('PHP_ROUND_HALF_UP', 1n);
defineConstant('PHP_ROUND_HALF_DOWN', 2n);
defineConstant('PHP_ROUND_HALF_EVEN', 3n);
defineConstant('PHP_ROUND_HALF_ODD', 4n);
defineConstant('MT_RAND_MT19937', 0n);
defineConstant('MT_RAND_PHP', 1n);

/** A number as `int|float` parameters receive it. */
function num(value: Value): bigint | number {
  return typeof value === 'bigint' ? value : (value as number);
}

defineFunction('abs(int|float $num): int|float', ({ args }) => {
  const value = num(args[0]);
  if (typeof value === 'bigint')
    return value === -9_223_372_036_854_775_808n ? -Number(value) : value < 0n ? -value : value;
  return Math.abs(value);
});
defineFunction('ceil(int|float $num): float', ({ args }) => Math.ceil(Number(num(args[0]))));
defineFunction('floor(int|float $num): float', ({ args }) => Math.floor(Number(num(args[0]))));
defineFunction(
  'round(int|float $num, int $precision = 0, int|RoundingMode $mode = PHP_ROUND_HALF_UP): float',
  ({ args }) => {
    const value = num(args[0]);
    const places = Number(args[1] ?? 0n);
    const modes: Record<string, RoundMode> = { '1': 'halfUp', '2': 'halfDown', '3': 'halfEven', '4': 'halfOdd' };
    const mode = modes[String(args[2] ?? 1n)];
    if (!mode) throwError('ValueError', 'round(): Argument #3 ($mode) must be a valid rounding mode (RoundingMode::*)');
    if (typeof value === 'bigint') {
      if (places >= 0) return Number(value);
      return phpRound(Number(value), places, mode);
    }
    return phpRound(value, places, mode);
  }
);
defineFunction('sqrt(float $num): float', ({ args }) => Math.sqrt(args[0] as number));
defineFunction('pow(mixed $num, mixed $exponent): mixed', ({ args }) => {
  return arithmetic('**', args[0], args[1]);
});
defineFunction('intdiv(int $num1, int $num2): int', ({ args }) => {
  const [a, b] = args as [bigint, bigint];
  if (b === 0n) throwError('DivisionByZeroError', 'Division by zero');
  if (a === -9_223_372_036_854_775_808n && b === -1n)
    throwError('ArithmeticError', 'Division of PHP_INT_MIN by -1 is not an integer');
  return a / b;
});
defineFunction('fmod(float $num1, float $num2): float', ({ args }) => (args[0] as number) % (args[1] as number));
defineFunction('fdiv(float $num1, float $num2): float', ({ args }) => (args[0] as number) / (args[1] as number));
defineFunction('max(mixed $value, mixed ...$values): mixed', ({ args }) => extreme('max', args, 1));
defineFunction('min(mixed $value, mixed ...$values): mixed', ({ args }) => extreme('min', args, -1));

function extreme(name: string, args: Value[], direction: number): Value {
  let values: Value[];
  if (args.length === 1) {
    const [array] = args;
    if (!(array instanceof PhpArray)) {
      throwError('TypeError', `${name}(): Argument #1 ($value) must be of type array, ${debugType(array)} given`);
    }
    if (array.size === 0) throwError('ValueError', `${name}(): Argument #1 ($value) must contain at least one element`);
    values = array.values();
  } else values = args;
  let best = values[0];
  for (const value of values.slice(1)) {
    const result = compare(value, best);
    if (direction > 0 ? result > 0 : result < 0) best = value;
  }
  return best;
}

defineFunction('pi(): float', () => Math.PI);
for (const name of [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'exp',
  'log10',
  'log2',
  'expm1',
  'log1p',
] as const) {
  defineFunction(`${name}(float $num): float`, ({ args }) => Math[name](args[0] as number));
}
defineFunction('atan2(float $y, float $x): float', ({ args }) => Math.atan2(args[0] as number, args[1] as number));
defineFunction('log(float $num, float $base = M_E): float', ({ args }) => {
  const [value, base] = args as [number, number?];
  if (base === undefined) return Math.log(value);
  if (base <= 0) throwError('ValueError', 'log(): Argument #2 ($base) must be greater than 0');
  if (base === 1) throwError('ValueError', 'log(): Argument #2 ($base) must not be equal to 1');
  if (base === 2) return Math.log2(value);
  if (base === 10) return Math.log10(value);
  return Math.log(value) / Math.log(base);
});
defineFunction('hypot(float $x, float $y): float', ({ args }) => Math.hypot(args[0] as number, args[1] as number));
defineFunction('deg2rad(float $num): float', ({ args }) => ((args[0] as number) / 180) * Math.PI);
defineFunction('rad2deg(float $num): float', ({ args }) => ((args[0] as number) / Math.PI) * 180);
defineFunction('is_nan(float $num): bool', ({ args }) => Number.isNaN(args[0]));
defineFunction('is_infinite(float $num): bool', ({ args }) => !Number.isFinite(args[0]) && !Number.isNaN(args[0]));
defineFunction('is_finite(float $num): bool', ({ args }) => Number.isFinite(args[0]));

// Bases --------------------------------------------------------------------------------------------------------------

function toBase(value: bigint, radix: number): string {
  return BigInt.asUintN(64, value).toString(radix);
}

defineFunction('dechex(int $num): string', ({ args }) => toBase(args[0] as bigint, 16));
defineFunction('decbin(int $num): string', ({ args }) => toBase(args[0] as bigint, 2));
defineFunction('decoct(int $num): string', ({ args }) => toBase(args[0] as bigint, 8));

function fromBase(text: string, radix: number): Value {
  let value = 0n;
  let float = 0;
  let isFloat = false;
  let invalid = false;
  const big = BigInt(radix);
  const prefix = radix === 16 ? /^0[xX]/ : radix === 8 ? /^0[oO]/ : radix === 2 ? /^0[bB]/ : undefined;
  const body = prefix ? text.replace(prefix, '') : text;
  for (const char of body) {
    const digit = Number.parseInt(char, 36);
    if (Number.isNaN(digit) || digit >= radix) {
      invalid = true;
      continue;
    }
    if (isFloat) float = float * radix + digit;
    else {
      value = value * big + BigInt(digit);
      if (value > 9_223_372_036_854_775_807n) {
        isFloat = true;
        float = Number(value);
      }
    }
  }
  if (invalid) deprecated('Invalid characters passed for attempted conversion, these have been ignored');
  return isFloat ? float : value;
}

defineFunction('hexdec(string $hex_string): int|float', ({ args }) => fromBase(args[0] as string, 16));
defineFunction('bindec(string $binary_string): int|float', ({ args }) => fromBase(args[0] as string, 2));
defineFunction('octdec(string $octal_string): int|float', ({ args }) => fromBase(args[0] as string, 8));
defineFunction('base_convert(string $num, int $frombase, int $tobase): string', ({ args }) => {
  const [text, from, to] = args as [string, bigint, bigint];
  if (from < 2n || from > 36n)
    throwError('ValueError', 'base_convert(): Argument #2 ($from_base) must be between 2 and 36 (inclusive)');
  if (to < 2n || to > 36n)
    throwError('ValueError', 'base_convert(): Argument #3 ($to_base) must be between 2 and 36 (inclusive)');
  const value = fromBase(text.toLowerCase(), Number(from));
  if (typeof value === 'number') return Math.trunc(value).toString(Number(to));
  return (value as bigint).toString(Number(to));
});

// Formatting ---------------------------------------------------------------------------------------------------------

defineFunction(
  'number_format(float $num, int $decimals = 0, ?string $decimal_separator = ".", ?string $thousands_separator = ","): string',
  ({ args }) => {
    const [value, decimalsArg = 0n, point = '.', separator = ','] = args as [
      number,
      bigint?,
      (string | null)?,
      (string | null)?,
    ];
    const decimals = Math.max(Number(decimalsArg), 0);
    const rounded = phpRound(value, Number(decimalsArg));
    if (!Number.isFinite(rounded)) return formatFloat(rounded);
    const text = fixedDigits(Math.abs(rounded), decimals);
    const [integer, fraction] = text.split('.');
    const grouped = integer.replaceAll(/\B(?=(\d{3})+(?!\d))/g, separator ?? '');
    const negative = rounded < 0 && /[1-9]/.test(text);
    return `${negative ? '-' : ''}${grouped}${fraction !== undefined ? `${point ?? ''}${fraction}` : ''}`;
  }
);

// Random numbers -----------------------------------------------------------------------------------------------------

defineFunction('mt_srand(int $seed = 0, int $mode = MT_RAND_MT19937): void', ({ args }) => {
  if (args[1] === 1n) deprecated('The MT_RAND_PHP variant of Mt19937 is deprecated');
  if (args.length === 0) rt().mt.seed(Math.floor(Math.random() * 2 ** 32));
  else rt().mt.seed(Number(BigInt.asUintN(32, args[0] as bigint)));
  return null;
});
defineAlias('srand', 'mt_srand');
defineFunction('mt_rand(int $min = UNKNOWN, int $max = UNKNOWN): int', ({ args }) => {
  if (args.length === 0) return BigInt(rt().mt.next() >>> 1);
  if (args.length === 1) throwError('ArgumentCountError', 'mt_rand() expects exactly 2 arguments, 1 given');
  const [min, max] = args as [bigint, bigint];
  if (max < min)
    throwError('ValueError', 'mt_rand(): Argument #2 ($max) must be greater than or equal to argument #1 ($min)');
  return rt().mt.range(min, max);
});
defineFunction('rand(int $min = UNKNOWN, int $max = UNKNOWN): int', ({ args }) => {
  if (args.length === 0) return BigInt(rt().mt.next() >>> 1);
  if (args.length === 1) throwError('ArgumentCountError', 'rand() expects exactly 2 arguments, 1 given');
  const [min, max] = args as [bigint, bigint];
  if (max < min) return rt().mt.range(max, min);
  return rt().mt.range(min, max);
});
defineFunction('mt_getrandmax(): int', () => 2_147_483_647n);
defineAlias('getrandmax', 'mt_getrandmax');
defineFunction('random_int(int $min, int $max): int', ({ args }) => {
  const [min, max] = args as [bigint, bigint];
  if (min > max)
    throwError('ValueError', 'random_int(): Argument #1 ($min) must be less than or equal to argument #2 ($max)');
  const span = max - min;
  if (span < 2n ** 48n - 1n) return min + BigInt(randomInt(0, Number(span) + 1));
  return min + (BigInt(randomInt(0, 2 ** 47)) * span) / 2n ** 47n;
});
defineFunction('lcg_value(): float', () => {
  deprecated(String.raw`Function lcg_value() is deprecated since 8.4, use \Random\Randomizer::getFloat() instead`);
  return Math.random();
});

