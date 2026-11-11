import { floorDivInt, intToString } from '../numbers';
import { currentRuntime } from '../runtimeContext';
import { strLength, strRepr } from '../strings';
import { valueError } from '../types';

type Ratio = readonly [bigint, bigint];

const GENERAL_FORMAT = /^(?:(.)?([<>=^]))?([-+ ]?)(#)?(0|[1-9]\d*)?([,_])?$/su;
const FLOAT_FORMAT =
  /^(?:(.)?([<>=^]))?([-+ ]?)(z)?(#)?(0(?=\d))?(\d+)?([,_])?(?:\.(?=[,_\d])(\d+)?([,_])?)?([eEfFgG%])$/su;

/** `Fraction.__format__`. */
export function formatFractionValue(ratio: Ratio, spec: string, typeName: string): string {
  const general = GENERAL_FORMAT.exec(spec);
  if (general) return formatGeneral(ratio, general);
  const float = FLOAT_FORMAT.exec(spec);
  if (float && (float[2] === undefined || float[6] === undefined)) return formatFloatStyle(ratio, float);
  throw valueError(`Invalid format specifier ${strRepr(spec)} for object of type ${strRepr(typeName)}`);
}

function formatGeneral([numerator, denominator]: Ratio, match: RegExpExecArray): string {
  const [, fill = ' ', align = '>', signFlag, alternate, width = '0', separator = ''] = match;
  const magnitude = group(intToString(numerator < 0n ? -numerator : numerator), separator);
  const body = denominator > 1n || alternate ? `${magnitude}/${group(intToString(denominator), separator)}` : magnitude;
  const sign = numerator < 0n ? '-' : signFlag === '-' ? '' : signFlag;
  return pad(sign, body, fill, align, Number(width));
}

function group(digits: string, separator: string): string {
  if (!separator) return digits;
  const first = 1 + ((digits.length - 1) % 3);
  let result = digits.slice(0, first);
  for (let index = first; index < digits.length; index += 3) result += separator + digits.slice(index, index + 3);
  return result;
}

function pad(sign: string, body: string, fill: string, align: string, width: number): string {
  const count = Math.max(width - strLength(sign) - strLength(body), 0);
  currentRuntime().buildString(count);
  const padding = fill.repeat(count);
  if (align === '>') return padding + sign + body;
  if (align === '<') return sign + body + padding;
  if (align === '^') {
    const half = Math.floor(count / 2);
    return padding.slice(0, half * fill.length) + sign + body + padding.slice(half * fill.length);
  }
  return sign + padding + body;
}

interface Rounded {
  negative: boolean;
  significand: bigint;
  exponent: number;
}

/** Rounds n/d to a multiple of 10**exponent, halves to even, as `fractions._round_to_exponent` does. */
function roundToExponent(numerator: bigint, denominator: bigint, exponent: number, noNegZero = false): Rounded {
  let n = numerator;
  let d = denominator;
  if (exponent >= 0) d *= tenTo(exponent);
  else n *= tenTo(-exponent);
  let quotient = floorDivInt(n + (d >> 1n), d);
  const remainder = n + (d >> 1n) - quotient * d;
  if (remainder === 0n && (d & 1n) === 0n) quotient &= -2n;
  const negative = noNegZero ? quotient < 0n : n < 0n;
  return { negative, significand: quotient < 0n ? -quotient : quotient, exponent };
}

function tenTo(exponent: number): bigint {
  currentRuntime().chargeBits(BigInt(exponent) * 4n);
  return 10n ** BigInt(exponent);
}

/** Rounds n/d to `figures` significant digits, as `fractions._round_to_figures` does. */
function roundToFigures(numerator: bigint, denominator: bigint, figures: number): Rounded {
  if (numerator === 0n) return { negative: false, significand: 0n, exponent: 1 - figures };
  const textN = intToString(numerator < 0n ? -numerator : numerator);
  const textD = intToString(denominator);
  const m = textN.length - textD.length + (textD <= textN ? 1 : 0);
  const rounded = roundToExponent(numerator, denominator, m - figures);
  if (intToString(rounded.significand).length === figures + 1) {
    return { ...rounded, significand: rounded.significand / 10n, exponent: rounded.exponent + 1 };
  }
  return rounded;
}

// code-gauge-allow functionCognitiveComplexity 28 -- Transcribes fractions.py.
// code-gauge-allow functionNcss 45 -- Transcribes fractions.py.
function formatFloatStyle([numerator, denominator]: Ratio, match: RegExpExecArray): string {
  const [, fill = ' ', align = '>', signFlag, noNegZero, alternate, zeroPadFlag, width = '0', thousands] = match;
  const precision = Number(match[9] ?? '6');
  const fractionSeparator = match[10] ?? '';
  const type = match[11];
  const trimZeros = 'gG'.includes(type) && !alternate;
  const trimPoint = !alternate;
  const exponentIndicator = 'EFG'.includes(type) ? 'E' : 'e';
  const minimumWidth = Number(width);
  const zeroPad = Boolean(zeroPadFlag) || (align === '=' && fill === '0');
  let rounded: Rounded;
  let scientific = false;
  let pointPosition: number;
  if ('fF%'.includes(type)) {
    rounded = roundToExponent(numerator, denominator, -precision - (type === '%' ? 2 : 0), Boolean(noNegZero));
    pointPosition = precision;
  } else {
    const figures = 'gG'.includes(type) ? Math.max(precision, 1) : precision + 1;
    rounded = roundToFigures(numerator, denominator, figures);
    scientific = 'eE'.includes(type) || rounded.exponent > 0 || rounded.exponent + figures <= -4;
    pointPosition = scientific ? figures - 1 : -rounded.exponent;
  }
  let suffix = '';
  if (type === '%') suffix = '%';
  else if (scientific) {
    const shown = rounded.exponent + pointPosition;
    suffix = `${exponentIndicator}${shown < 0 ? '-' : '+'}${String(Math.abs(shown)).padStart(2, '0')}`;
  }
  const digits = intToString(rounded.significand).padStart(pointPosition + 1, '0');
  const sign = rounded.negative ? '-' : signFlag === '-' ? '' : signFlag;
  let leading = digits.slice(0, digits.length - pointPosition);
  let fraction = digits.slice(digits.length - pointPosition);
  if (trimZeros) fraction = fraction.replace(/0+$/, '');
  const point = trimPoint && !fraction ? '' : '.';
  if (fractionSeparator) fraction = (fraction.match(/.{1,3}/g) ?? []).join(fractionSeparator);
  const trailing = point + fraction + suffix;
  if (zeroPad) {
    const minLeading = minimumWidth - strLength(sign) - strLength(trailing);
    const target = thousands ? Math.floor((3 * minLeading) / 4) + 1 : minLeading;
    leading = leading.padStart(target, '0');
  }
  if (thousands) leading = group(leading, thousands);
  return pad(sign, leading + trailing, fill, align, minimumWidth);
}
