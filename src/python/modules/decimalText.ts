import { parseIntText } from '../numbers';
import { currentRuntime } from '../runtimeContext';
import { strLength } from '../strings';
import { valueError } from '../types';
import type { DecimalContext } from './decimalContext';
import { copyAbs, type Dec, dec, isFinite, isNonzero, rescale, roundPlaces } from './decimalNumber';

const NUMBER =
  /^([-+])?(?:(?=\p{Nd}|\.\p{Nd})(\p{Nd}*)(?:\.(\p{Nd}*))?(?:E([-+]?\p{Nd}+))?|(Inf(?:inity)?)|(s)?NaN(\p{Nd}*))$/iu;

/** Parses the text of `Decimal(text)`, or returns undefined when it is not a numeric string. */
export function parseDecimal(text: string): Dec | undefined {
  const match = NUMBER.exec(text.trim().replaceAll('_', ''));
  if (!match) return undefined;
  const [, sign, intPart, fracPart, expPart, infinity, signal, diagnostic] = match;
  const negative = sign === '-' ? 1 : 0;
  if (intPart !== undefined) {
    const fraction = fracPart ?? '';
    const exponent = Number(digits(expPart ?? '0'));
    return dec(negative, digits(intPart + fraction).toString(), exponent - strLength(fraction));
  }
  if (infinity) return dec(negative, '0', 'F');
  const payload = diagnostic ? digits(diagnostic).toString() : '';
  return dec(negative, payload === '0' ? '' : payload, signal ? 'N' : 'n');
}

function digits(text: string): bigint {
  return parseIntText(text || '0', 10) as bigint;
}

/** The scientific or engineering string of a decimal, as `Decimal.__str__` writes it. */
// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes _pydecimal's algorithm of the same name.
// code-gauge-allow functionNcss 34 -- Transcribes _pydecimal's algorithm of the same name.
export function decimalString(self: Dec, capitals: number, engineering = false): string {
  const sign = self.sign ? '-' : '';
  if (!isFinite(self)) {
    if (self.exp === 'F') return `${sign}Infinity`;
    return `${sign}${self.exp === 'n' ? 'NaN' : 'sNaN'}${self.int}`;
  }
  const leftDigits = self.exp + self.int.length;
  let dotPlace: number;
  if (self.exp <= 0 && leftDigits > -6) dotPlace = leftDigits;
  else if (!engineering) dotPlace = 1;
  else if (self.int === '0') dotPlace = pythonModulo(leftDigits + 1, 3) - 1;
  else dotPlace = pythonModulo(leftDigits - 1, 3) + 1;
  currentRuntime().buildString(self.int.length + Math.abs(dotPlace));
  let intPart: string;
  let fracPart: string;
  if (dotPlace <= 0) {
    intPart = '0';
    fracPart = `.${'0'.repeat(-dotPlace)}${self.int}`;
  } else if (dotPlace >= self.int.length) {
    intPart = self.int + '0'.repeat(dotPlace - self.int.length);
    fracPart = '';
  } else {
    intPart = self.int.slice(0, dotPlace);
    fracPart = `.${self.int.slice(dotPlace)}`;
  }
  const exponent = leftDigits - dotPlace;
  const exp = leftDigits === dotPlace ? '' : `${capitals ? 'E' : 'e'}${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
  return sign + intPart + fracPart + exp;
}

function pythonModulo(a: number, b: number): number {
  return ((a % b) + b) % b;
}

// format() -----------------------------------------------------------------------------------------------------------

interface FormatSpec {
  fill: string;
  align: string;
  sign: string;
  noNegZero: boolean;
  alternate: boolean;
  zeroPad: boolean;
  width: number;
  thousands: string;
  precision?: number;
  fracSeparator: string;
  type?: string;
}

const SPEC = /^(?:(.)?([<>=^]))?([-+ ])?(z)?(#)?(0)?(\d+)?([,_])?(?:\.(?=[\d,_])(\d+)?([,_])?)?([eEfFgGn%])?$/su;

function parseSpec(text: string): FormatSpec {
  const match = SPEC.exec(text);
  if (!match) throw valueError('invalid format string');
  const [, fill, align, sign, noNegZero, alternate, zeroPad, width, thousands, precision, fracSeparator, type] = match;
  if (zeroPad && (fill !== undefined || align !== undefined)) throw valueError('invalid format string');
  if (type === 'n' && thousands) throw valueError('invalid format string');
  const spec: FormatSpec = {
    fill: fill ?? ' ',
    align: align ?? '>',
    sign: sign ?? '-',
    noNegZero: Boolean(noNegZero),
    alternate: Boolean(alternate),
    zeroPad: Boolean(zeroPad),
    width: Number(width ?? '0'),
    thousands: thousands ?? '',
    precision: precision === undefined ? undefined : Number(precision),
    fracSeparator: fracSeparator ?? '',
    type: type === 'n' ? 'g' : type,
  };
  if (spec.precision === 0 && (type === undefined || 'gGn'.includes(type))) spec.precision = 1;
  return spec;
}

/** `Decimal.__format__`, as `_pydecimal` defines it. */
// code-gauge-allow functionCognitiveComplexity 28 -- Transcribes _pydecimal's algorithm of the same name.
// code-gauge-allow functionNcss 46 -- Transcribes _pydecimal's algorithm of the same name.
export function formatDecimal(value: Dec, text: string, context: DecimalContext): string {
  const spec = parseSpec(text);
  if (!isFinite(value)) {
    const body = decimalString(copyAbs(value), context.capitals) + (spec.type === '%' ? '%' : '');
    return align(signText(value.sign === 1, spec), body, spec);
  }
  let self: Dec = value;
  const type = spec.type ?? (context.capitals ? 'G' : 'g');
  if (type === '%') self = dec(self.sign, self.int, (self.exp as number) + 2);
  const { rounding } = context;
  const { precision } = spec;
  if (precision !== undefined) {
    if ('eE'.includes(type)) self = roundPlaces(self, precision + 1, rounding);
    else if ('fF%'.includes(type)) self = rescale(self, -precision, rounding);
    else if ('gG'.includes(type) && self.int.length > precision) self = roundPlaces(self, precision, rounding);
  }
  if (!isNonzero(self) && (self.exp as number) > 0 && 'fF%'.includes(type)) self = rescale(self, 0, rounding);
  const negative = !isNonzero(self) && spec.noNegZero ? false : self.sign === 1;
  const exp = self.exp as number;
  const leftDigits = exp + self.int.length;
  let dotPlace: number;
  if ('eE'.includes(type)) dotPlace = !isNonzero(self) && precision !== undefined ? 1 - precision : 1;
  else if ('fF%'.includes(type)) dotPlace = leftDigits;
  else dotPlace = exp <= 0 && leftDigits > -6 ? leftDigits : 1;
  let intPart: string;
  let fracPart: string;
  if (dotPlace < 0) {
    intPart = '0';
    fracPart = '0'.repeat(-dotPlace) + self.int;
  } else if (dotPlace > self.int.length) {
    intPart = self.int + '0'.repeat(dotPlace - self.int.length);
    fracPart = '';
  } else {
    intPart = self.int.slice(0, dotPlace) || '0';
    fracPart = self.int.slice(dotPlace);
  }
  return formatNumber(negative, intPart, fracPart, leftDigits - dotPlace, { ...spec, type });
}

function signText(negative: boolean, spec: FormatSpec): string {
  if (negative) return '-';
  return ' +'.includes(spec.sign) ? spec.sign : '';
}

function align(sign: string, body: string, spec: FormatSpec): string {
  const count = Math.max(spec.width - strLength(sign) - strLength(body), 0);
  currentRuntime().buildString(count);
  const padding = spec.fill.repeat(count);
  if (spec.align === '<') return sign + body + padding;
  if (spec.align === '>') return padding + sign + body;
  if (spec.align === '=') return sign + padding + body;
  const half = Math.floor(count / 2) * spec.fill.length;
  return padding.slice(0, half) + sign + body + padding.slice(half);
}

function insertThousands(digitsText: string, separator: string, minimumWidth: number): string {
  let rest = digitsText;
  let minWidth = minimumWidth;
  const groups: string[] = [];
  for (;;) {
    const length = Math.min(Math.max(rest.length, minWidth, 1), 3);
    groups.push('0'.repeat(Math.max(length - rest.length, 0)) + rest.slice(-length));
    rest = rest.slice(0, -length);
    minWidth -= length;
    if (!rest && minWidth <= 0) break;
    minWidth -= separator.length;
    if (!separator && rest === '' && minWidth <= 0) break;
  }
  return groups.toReversed().join(separator);
}

function formatNumber(
  negative: boolean,
  intPart: string,
  fraction: string,
  exp: number,
  spec: FormatSpec & { type: string }
): string {
  const sign = signText(negative, spec);
  let fracPart = fraction;
  if (fracPart && spec.fracSeparator) fracPart = (fracPart.match(/.{1,3}/g) ?? []).join(spec.fracSeparator);
  if (fracPart || spec.alternate) fracPart = `.${fracPart}`;
  if (exp !== 0 || 'eE'.includes(spec.type)) {
    const marker = { E: 'E', e: 'e', G: 'E', g: 'e' }[spec.type] ?? 'e';
    fracPart += `${marker}${exp < 0 ? '-' : '+'}${Math.abs(exp)}`;
  }
  if (spec.type === '%') fracPart += '%';
  const minWidth = spec.zeroPad ? spec.width - strLength(fracPart) - strLength(sign) : 0;
  const integer = spec.thousands || minWidth > 0 ? insertThousands(intPart, spec.thousands, minWidth) : intPart;
  return align(sign, integer + fracPart, spec);
}
