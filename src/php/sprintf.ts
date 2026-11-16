// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { notice, throwError } from './errors';
import { toFloat, toInt, toStr } from './operators';
import { exponentialText, fixedDigits, generalText } from './strings';
import type { Value } from './values';

const MAX_FLOAT_PRECISION = 53;

/** Formats like PHP's `sprintf`, whose `%e` writes the shortest exponent and whose `%f` rounds half to even. */
export function formatPrintf(format: string, args: Value[], fromArray = false): string {
  let result = '';
  let index = 0;
  let currentArg = 0;
  const readNumber = (): number => {
    let digits = '';
    while (index < format.length && /\d/.test(format[index])) digits += format[index++];
    const value = Number(digits);
    if (value > 2_147_483_646) throwError('ValueError', 'Width must be greater than zero and less than 2147483647');
    return value;
  };
  while (index < format.length) {
    const char = format[index];
    if (char !== '%') {
      result += char;
      index++;
      continue;
    }
    if (format[index + 1] === '%') {
      result += '%';
      index += 2;
      continue;
    }
    index++;
    let alignLeft = false;
    let padding = ' ';
    let alwaysSign = false;
    let width = 0;
    let precision = 0;
    let hasPrecision = false;
    let argIndex: number;
    if (!/[A-Za-z]/.test(format[index] ?? '')) {
      let lookahead = index;
      while (/\d/.test(format[lookahead] ?? '')) lookahead++;
      if (format[lookahead] === '$') {
        const number = readNumber();
        if (number <= 0)
          throwError('ValueError', 'Argument number specifier must be greater than zero and less than 2147483647');
        argIndex = number - 1;
        index++;
      } else argIndex = currentArg++;
      for (; ; index++) {
        const modifier = format[index];
        if (modifier === ' ' || modifier === '0') padding = modifier;
        else if (modifier === '-') alignLeft = true;
        else if (modifier === '+') alwaysSign = true;
        else if (modifier === "'") {
          if (index + 1 < format.length) padding = format[++index];
          else throwError('ValueError', 'Missing padding character');
        } else break;
      }
      if (format[index] === '*') {
        index++;
        const widthArg = args[currentArg++];
        if (widthArg === undefined)
          throwError('ArgumentCountError', `${args.length + 1} arguments are required, ${args.length + 1} given`);
        if (typeof widthArg !== 'bigint') throwError('ValueError', 'Width must be an integer');
        width = Number(widthArg);
        if (format[index] !== '.' && argIndex === currentArg - 2) argIndex = currentArg++;
      } else if (/\d/.test(format[index] ?? '')) width = readNumber();
      if (format[index] === '.') {
        index++;
        if (format[index] === '*') {
          index++;
          const precisionArg = args[currentArg++];
          if (typeof precisionArg !== 'bigint') throwError('ValueError', 'Precision must be an integer');
          precision = Number(precisionArg);
          hasPrecision = true;
        } else if (/\d/.test(format[index] ?? '')) {
          precision = readNumber();
          hasPrecision = true;
        } else {
          precision = 0;
          hasPrecision = true;
        }
      }
    } else argIndex = currentArg++;
    if (format[index] === 'l') index++;
    const specifier = format[index];
    if (specifier === undefined) throwError('ValueError', 'Missing format specifier at end of string');
    if (specifier !== '%' && argIndex >= args.length) {
      if (fromArray)
        throwError('ValueError', `The arguments array must contain ${argIndex + 1} items, ${args.length} given`);
      throwError('ArgumentCountError', `${argIndex + 2} arguments are required, ${args.length + 1} given`);
    }
    const arg = args[argIndex];
    switch (specifier) {
      case 's': {
        const text = toStr(arg);
        result += pad(hasPrecision ? text.slice(0, precision) : text, width, padding, alignLeft, false, alwaysSign);
        break;
      }
      case 'd': {
        const value = toInt(arg);
        const text = value < 0n ? `-${-value}` : alwaysSign ? `+${value}` : `${value}`;
        result += pad(text, width, alignLeft && padding === '0' ? ' ' : padding, alignLeft, value < 0n, alwaysSign);
        break;
      }
      case 'u': {
        const value = BigInt.asUintN(64, toInt(arg));
        result += pad(value.toString(), width, alignLeft && padding === '0' ? ' ' : padding, alignLeft, false, false);
        break;
      }
      case 'e':
      case 'E':
      case 'f':
      case 'F':
      case 'g':
      case 'G':
      case 'h':
      case 'H': {
        result += formatFloatSpec(
          toFloat(arg),
          specifier,
          width,
          padding,
          alignLeft,
          hasPrecision ? precision : undefined,
          alwaysSign
        );
        break;
      }
      case 'c': {
        result += String.fromCharCode(Number(BigInt.asUintN(8, toInt(arg))));
        break;
      }
      case 'o':
      case 'x':
      case 'X':
      case 'b': {
        const value = BigInt.asUintN(64, toInt(arg));
        const radix = specifier === 'o' ? 8 : specifier === 'b' ? 2 : 16;
        let text = value.toString(radix);
        if (specifier === 'X') text = text.toUpperCase();
        result += pad(text, width, padding, alignLeft, false, false);
        break;
      }
      case '%': {
        result += '%';
        break;
      }
      default: {
        throwError('ValueError', `Unknown format specifier "${specifier}"`);
      }
    }
    index++;
  }
  return result;
}

function pad(
  text: string,
  width: number,
  padding: string,
  alignLeft: boolean,
  negative: boolean,
  alwaysSign: boolean
): string {
  const count = Math.max(width - text.length, 0);
  if (count === 0) return text;
  if (alignLeft) return text + padding.repeat(count);
  if ((negative || alwaysSign) && padding === '0' && /^[+-]/.test(text))
    return text[0] + '0'.repeat(count) + text.slice(1);
  return padding.repeat(count) + text;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionParameterCount 7 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function formatFloatSpec(
  value: number,
  specifier: string,
  width: number,
  padding: string,
  alignLeft: boolean,
  requested: number | undefined,
  alwaysSign: boolean
): string {
  let precision = requested ?? 6;
  if (precision > MAX_FLOAT_PRECISION) {
    notice(`Requested precision of ${precision} digits was truncated to PHP maximum of ${MAX_FLOAT_PRECISION} digits`);
    precision = MAX_FLOAT_PRECISION;
  }
  if (Number.isNaN(value)) return pad('NaN', width, padding, alignLeft, false, alwaysSign);
  if (!Number.isFinite(value)) {
    const text = value < 0 ? '-Inf' : alwaysSign ? '+Inf' : 'Inf';
    return pad(text, width, padding, alignLeft, value < 0, alwaysSign);
  }
  const negative = value < 0 || Object.is(value, -0);
  let body: string;
  switch (specifier) {
    case 'e':
    case 'E': {
      body = exponentialText(value, precision, specifier === 'E');
      break;
    }
    case 'f':
    case 'F': {
      body = fixedDigits(value, precision);
      break;
    }
    default: {
      body = generalText(Math.abs(value), precision === 0 ? 1 : precision, specifier === 'G' || specifier === 'H');
    }
  }
  const isNegative =
    negative && (specifier === 'g' || specifier === 'G' || specifier === 'h' || specifier === 'H' ? value < 0 : true);
  const text = isNegative ? `-${body}` : alwaysSign ? `+${body}` : body;
  return pad(text, width, padding, alignLeft, isNegative, alwaysSign);
}
