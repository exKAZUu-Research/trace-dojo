// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { randomBytes } from 'node:crypto';

import { floatFitsInt, valueName } from './conversions';
import { deprecated, throwError } from './errors';
import { cPow } from './floatPow';
import { defineAlias, defineConstant, defineFunction, markInlined } from './native';
import { arithmetic, compare } from './operators';
import { rt } from './runtime';
import { fixedDigits, phpRound, type RoundMode } from './strings';
import { deref, PhpArray, type Ref, type Value } from './values';

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
defineConstant(
  'MT_RAND_PHP',
  1n,
  'Constant MT_RAND_PHP is deprecated since 8.3, as it uses a biased non-standard variant of Mt19937'
);

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
  'round(int|float $num, int $precision = 0, RoundingMode|int $mode = PHP_ROUND_HALF_UP): float',
  ({ args }) => {
    const value = num(args[0]);
    const places = Number(args[1] ?? 0n);
    const modes: Record<string, RoundMode> = {
      '1': 'halfUp',
      '2': 'halfDown',
      '3': 'halfEven',
      '4': 'halfOdd',
      '5': 'ceiling',
      '6': 'floor',
      '7': 'towardsZero',
      '8': 'awayFromZero',
    };
    const modeArg = args[2] ?? 1n;
    const mode = typeof modeArg === 'bigint' ? modes[modeArg.toString()] : undefined;
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
defineFunction('fpow(float $num, float $exponent): float', ({ args }) => cPow(args[0] as number, args[1] as number));
defineFunction('intdiv(int $num1, int $num2): int', ({ args }) => {
  const [a, b] = args as [bigint, bigint];
  if (b === 0n) throwError('DivisionByZeroError', 'Division by zero');
  if (a === -9_223_372_036_854_775_808n && b === -1n)
    throwError('ArithmeticError', 'Division of PHP_INT_MIN by -1 is not an integer');
  return a / b;
});
defineFunction('fmod(float $num1, float $num2): float', ({ args }) => (args[0] as number) % (args[1] as number));
defineFunction('fdiv(float $num1, float $num2): float', ({ args }) => (args[0] as number) / (args[1] as number));
defineFunction('max(mixed $value, mixed ...$values): mixed', ({ args, row }) =>
  extreme('max', args, 1, row !== undefined)
);
defineFunction('min(mixed $value, mixed ...$values): mixed', ({ args, row }) =>
  extreme('min', args, -1, row !== undefined)
);

markInlined('max');
markInlined('min');

function extreme(name: string, args: Value[], direction: number, compiled: boolean): Value {
  if (args.length === 1) return extremeOfArray(name, args[0], direction);
  const [first, second] = args;
  if (compiled && args.length === 2) {
    if (isNumber(first) && isNumber(second) && bothFastNumbers(first, second))
      return (direction > 0 ? first >= second : first < second) ? first : second;
    const comparison = compare(first, second);
    return (direction > 0 ? comparison >= 0 : comparison < 0) ? first : second;
  }
  let best = first;
  let numeric = isNumber(first);
  let doubles = typeof first === 'number';
  for (const value of args.slice(1)) {
    if (
      numeric &&
      isNumber(best) &&
      isNumber(value) &&
      bothFastNumbers(best, value) &&
      !(doubles && typeof value === 'bigint' && !exactDouble(value))
    ) {
      doubles ||= typeof value === 'number';
      if (direction > 0 ? value > best : value < best) best = value;
    } else {
      numeric = false;
      if (compare(value, best) * direction > 0) best = value;
    }
  }
  return best;
}

function isNumber(value: Value): value is bigint | number {
  return typeof value === 'bigint' || typeof value === 'number';
}

function bothFastNumbers(left: bigint | number, right: bigint | number): boolean {
  if (typeof left === typeof right) return true;
  return exactDouble(typeof left === 'bigint' ? left : (right as bigint));
}

function exactDouble(value: bigint): boolean {
  return BigInt(Number(value)) === value;
}

function extremeOfArray(name: string, array: Value, direction: number): Value {
  if (!(array instanceof PhpArray)) {
    throwError('TypeError', `${name}(): Argument #1 ($value) must be of type array, ${valueName(array)} given`);
  }
  if (array.size === 0) throwError('ValueError', `${name}(): Argument #1 ($value) must contain at least one element`);
  const slots = array.map.values();
  let best: Value | Ref = slots.next().value ?? null;
  for (const slot of slots) {
    rt().spend();
    if (compare(best, slot) * direction < 0) best = slot;
  }
  return deref(best);
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
  if (base === 1) return Number.NaN;
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

/** Parses digits as `_php_math_basetozval` does, which continues in a float once the value would overflow an int. */
function fromBase(text: string, radix: number): bigint | number {
  let body = text.replaceAll(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');
  const prefix = { 16: /^0[xX]/, 8: /^0[oO]/, 2: /^0[bB]/ }[radix];
  if (prefix) body = body.replace(prefix, '');
  const digits = body.split('').map((char) => (/[\dA-Za-z]/.test(char) ? Number.parseInt(char, 36) : radix));
  if (digits.some((digit) => digit >= radix))
    deprecated('Invalid characters passed for attempted conversion, these have been ignored');
  const big = BigInt(radix);
  const cutoff = 9_223_372_036_854_775_807n / big;
  const cutlim = 9_223_372_036_854_775_807n % big;
  let value = 0n;
  let float: number | undefined;
  for (const digit of digits) {
    if (digit >= radix) continue;
    if (float === undefined && (value < cutoff || (value === cutoff && BigInt(digit) <= cutlim)))
      value = value * big + BigInt(digit);
    else float = (float ?? Number(value)) * radix + digit;
  }
  return float ?? value;
}

/** Writes a float's digits as `_php_math_zvaltobase` does, dividing without flooring between the digits. */
function floatToBase(value: number, radix: number): string {
  let rest = Math.floor(value);
  if (!Number.isFinite(rest)) throwError('ValueError', `An infinite value cannot be converted to base ${radix}`);
  let text = '';
  do {
    text = Math.trunc(rest % radix).toString(36) + text;
    rest /= radix;
  } while (Math.abs(rest) >= 1);
  return text;
}

defineFunction('hexdec(string $hex_string): int|float', ({ args }) => fromBase(args[0] as string, 16));
defineFunction('bindec(string $binary_string): int|float', ({ args }) => fromBase(args[0] as string, 2));
defineFunction('octdec(string $octal_string): int|float', ({ args }) => fromBase(args[0] as string, 8));
defineFunction('base_convert(string $num, int $from_base, int $to_base): string', ({ args }) => {
  const [text, from, to] = args as [string, bigint, bigint];
  if (from < 2n || from > 36n)
    throwError('ValueError', 'base_convert(): Argument #2 ($from_base) must be between 2 and 36 (inclusive)');
  if (to < 2n || to > 36n)
    throwError('ValueError', 'base_convert(): Argument #3 ($to_base) must be between 2 and 36 (inclusive)');
  const value = fromBase(text, Number(from));
  return typeof value === 'number' ? floatToBase(value, Number(to)) : toBase(value, Number(to));
});

// Formatting ---------------------------------------------------------------------------------------------------------

defineFunction(
  'number_format(int|float $num, int $decimals = 0, ?string $decimal_separator = ".", ?string $thousands_separator = ","): string',
  ({ args }) => {
    const [value, decimals = 0n, point, separator] = args as [
      bigint | number,
      bigint?,
      (string | null)?,
      (string | null)?,
    ];
    const format = { decimals, point: point ?? '.', separator: separator ?? ',' };
    if (decimals > 0n && (typeof value === 'bigint' || Number.isFinite(value)))
      rt().ensureStringFits(Number(decimals) + format.point.length + 1);
    // Floats from 2^52 on have no fraction, so PHP formats them as ints.
    if (typeof value === 'bigint' || (Math.abs(value) >= 2 ** 52 && floatFitsInt(value)))
      return formatIntNumber(BigInt(value), format);
    return formatFloatNumber(value, format);
  },
  false,
  { 0: 'float' }
);

interface NumberFormat {
  decimals: bigint;
  point: string;
  separator: string;
}

function formatIntNumber(value: bigint, { decimals, point, separator }: NumberFormat): string {
  let magnitude = value < 0n ? -value : value;
  if (decimals < 0n) {
    const power = decimals < -19n ? 0n : 10n ** -decimals;
    magnitude = power === 0n ? 0n : ((magnitude + power / 2n) / power) * power;
  }
  const integer = magnitude.toString();
  const places = decimals > 0n ? Number(decimals) : 0;
  const sign = value < 0n && magnitude !== 0n ? '-' : '';
  checkFormattedLength(integer, places, point, separator, sign);
  const fraction = places > 0 ? `${point}${'0'.repeat(places)}` : '';
  return `${sign}${groupThousands(integer, separator)}${fraction}`;
}

function formatFloatNumber(value: number, { decimals, point, separator }: NumberFormat): string {
  const places = Number(decimals);
  const rounded = phpRound(Math.abs(value), places);
  if (Number.isNaN(rounded)) return 'nan';
  if (!Number.isFinite(rounded)) return 'inf';
  const [integer, fraction] = fixedDigits(rounded, Math.max(places, 0)).split('.');
  const sign = value < 0 && rounded !== 0 ? '-' : '';
  checkFormattedLength(integer, fraction?.length ?? 0, point, separator, sign);
  return `${sign}${groupThousands(integer, separator)}${fraction === undefined ? '' : `${point}${fraction}`}`;
}

function checkFormattedLength(integer: string, places: number, point: string, separator: string, sign: string): void {
  const groups = Math.floor((integer.length - 1) / 3);
  const fraction = places > 0 ? point.length + places : 0;
  const bytes = sign.length + integer.length + groups * separator.length + fraction;
  rt().ensureStringFits(bytes);
  rt().spend(Math.ceil(bytes / 64));
}

function groupThousands(digits: string, separator: string): string {
  return digits.replaceAll(/\B(?=(\d{3})+(?!\d))/g, () => separator);
}

// Random numbers -----------------------------------------------------------------------------------------------------

defineFunction('mt_srand(?int $seed = null, int $mode = MT_RAND_MT19937): void', ({ args }) => {
  const phpMode = args[1] === 1n;
  if (phpMode) deprecated('The MT_RAND_PHP variant of Mt19937 is deprecated');
  const seed = args[0] ?? null;
  rt().mt.seed(
    seed === null ? Math.floor(Math.random() * 2 ** 32) : Number(BigInt.asUintN(32, seed as bigint)),
    phpMode
  );
  return null;
});
defineAlias('srand', 'mt_srand');
defineFunction('mt_rand(int $min = UNKNOWN, int $max = UNKNOWN): int', ({ args }) => {
  if (args.length === 0) return BigInt(rt().mt.next() >>> 1);
  if (args.length === 1) throwError('ArgumentCountError', 'mt_rand() expects exactly 2 arguments, 1 given');
  const [min, max] = args as [bigint, bigint];
  if (max < min)
    throwError('ValueError', 'mt_rand(): Argument #2 ($max) must be greater than or equal to argument #1 ($min)');
  return mtRandCommon(min, max);
});
defineFunction('rand(int $min = UNKNOWN, int $max = UNKNOWN): int', ({ args }) => {
  if (args.length === 0) return BigInt(rt().mt.next() >>> 1);
  if (args.length === 1) throwError('ArgumentCountError', 'rand() expects exactly 2 arguments, 1 given');
  const [min, max] = args as [bigint, bigint];
  return max < min ? mtRandCommon(max, min) : mtRandCommon(min, max);
});

/** Transcribes php_mt_rand_common, whose MT_RAND_PHP mode scales a 31-bit output into the range with floats. */
function mtRandCommon(min: bigint, max: bigint): bigint {
  const mt = rt().mt;
  if (!mt.phpMode) return mt.range(min, max);
  const r = mt.next() >>> 1;
  const offset = Math.trunc((Number(max) - Number(min) + 1) * (r / 2_147_483_648));
  return BigInt.asIntN(64, BigInt(offset) + min);
}
defineFunction('mt_getrandmax(): int', () => 2_147_483_647n);
defineAlias('getrandmax', 'mt_getrandmax');
defineFunction('random_int(int $min, int $max): int', ({ args }) => {
  const [min, max] = args as [bigint, bigint];
  if (min > max)
    throwError('ValueError', 'random_int(): Argument #1 ($min) must be less than or equal to argument #2 ($max)');
  const span = max - min;
  if (span === 0n) return min;
  const mask = (1n << BigInt(span.toString(2).length)) - 1n;
  for (;;) {
    rt().spend();
    const value = randomBytes(8).readBigUInt64LE() & mask;
    if (value <= span) return min + value;
  }
});
defineFunction('lcg_value(): float', () => {
  deprecated(String.raw`Function lcg_value() is deprecated since 8.4, use \Random\Randomizer::getFloat() instead`);
  return Math.random();
});
