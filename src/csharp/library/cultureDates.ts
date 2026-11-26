import { type Culture, providerCulture } from '../cultures';
import type { NativeCall } from '../natives';
import type { Value } from '../values';
import { WHITE_SPACE_STYLES } from './nativesTime';
import { unsupportedCall } from './support';

/**
 * What reading and writing a culture's dates needs beyond the patterns that `nativesTime.ts` formats and parses by:
 * the arguments of `DateTime.Parse`, its numeric dates, its error, and the inflected names of months.
 */

/**
 * The name of a month for `MMM` or `MMMM`: the form that goes with a day's number when the pattern has `d` or `dd`
 * before or after the month, in a culture that inflects it (ru-RU's `5 марта` but `март 2024`), as .NET's
 * `IsUseGenitiveForm` looks for it.
 */
export function monthName(month: number, pattern: string, index: number, count: number, culture: Culture): string {
  const isAbbreviated = count === 3;
  const names = isAbbreviated ? culture.abbreviatedMonthNames : culture.monthNames;
  const genitive = isAbbreviated ? culture.abbreviatedMonthGenitiveNames : culture.monthGenitiveNames;
  const inflects =
    culture.monthGenitiveNames.some((name, at) => name !== culture.monthNames[at]) ||
    culture.abbreviatedMonthGenitiveNames.some((name, at) => name !== culture.abbreviatedMonthNames[at]);
  return (inflects && hasDayNumberNear(pattern, index, count) ? genitive : names)[month - 1];
}

/** Whether the nearest run of `d` before a month, or else after it, is `d` or `dd`, a day's number. */
function hasDayNumberNear(pattern: string, index: number, count: number): boolean {
  let before = index - 1;
  while (before >= 0 && pattern[before] !== 'd') before--;
  if (before >= 0 && runBackward(pattern, before) <= 2) return true;
  let after = index + count;
  while (after < pattern.length && pattern[after] !== 'd') after++;
  return after < pattern.length && runForward(pattern, after) <= 2;
}

function runBackward(pattern: string, end: number): number {
  let start = end;
  while (start > 0 && pattern[start - 1] === pattern[end]) start--;
  return end - start + 1;
}

function runForward(pattern: string, start: number): number {
  let end = start;
  while (end + 1 < pattern.length && pattern[end + 1] === pattern[start]) end++;
  return end - start + 1;
}

/**
 * A culture's numeric date as the `yyyy/M/d H:m:s` that `DateTime.Parse` reads: a date in the order of the culture's
 * short date pattern, with `/`, `-`, `.`, or its own separator between the numbers, and a time with `:` or its own
 * separator, with its AM or PM designator before or after.
 */
export function cultureDateText(text: string, culture: Culture): string | undefined {
  const order = culture.datePatterns.d.replaceAll(/[^dMy]/g, '').replaceAll(/(.)\1+/g, '$1');
  const separator = `(?:[/.-]|${escapeRegExp(culture.dateSeparator.trim() || '/')})\\s*`;
  const date = new RegExp(`^\\s*(\\d{1,4})${separator}(\\d{1,2})${separator}(\\d{1,4})\\.?`).exec(text);
  if (!date || order.length !== 3) return undefined;
  const field = (letter: string): string => date[order.indexOf(letter) + 1];
  const rest = text.slice(date[0].length);
  const time = timeOfDay(rest, culture);
  if (time === undefined) return undefined;
  return `${field('y').padStart(4, '0')}/${field('M')}/${field('d')}${time}`;
}

/** A culture's time of day after a date, as `parseDateParts` reads it: ` H:mm:ss`, or empty for none. */
function timeOfDay(text: string, culture: Culture): string | undefined {
  if (text.trim() === '') return '';
  const { text: rest, isPm } = withoutDesignator(text.trim(), culture);
  const separator = `(?:[:.]|${escapeRegExp(culture.timeSeparator)})`;
  const match = new RegExp(`^(\\d{1,2})${separator}(\\d{1,2})(?:${separator}(\\d{1,2}))?$`).exec(rest);
  if (!match) return undefined;
  let hour = Number(match[1]);
  if (isPm !== undefined && hour > 12) return undefined;
  if (isPm === true && hour < 12) hour += 12;
  if (isPm === false && hour === 12) hour = 0;
  return ` ${hour}:${match[2]}${match[3] === undefined ? '' : `:${match[3]}`}`;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[\\^$.*+?()[\]{}|/-]/g, String.raw`\$&`);
}

/** A time without the culture's AM or PM designator before or after it, and which one it had. */
function withoutDesignator(text: string, culture: Culture): { text: string; isPm: boolean | undefined } {
  for (const [designator, isPm] of [
    [culture.amDesignator, false],
    [culture.pmDesignator, true],
  ] as const) {
    if (designator === '') continue;
    if (text.startsWith(designator)) return { text: text.slice(designator.length).trim(), isPm };
    if (text.endsWith(designator)) return { text: text.slice(0, -designator.length).trim(), isPm };
  }
  return { text, isPm: undefined };
}

/** The string and the culture of a `DateTime.Parse` or `TryParse` call, by the parameters' names. */
export function dateParseArguments(call: NativeCall, args: Value[]): { text: string | undefined; culture: Culture } {
  const argument = (name: string): Value =>
    args[call.method.parameters.findIndex((parameter) => parameter.name === name)];
  const styles = (argument('styles') as number | undefined) ?? 0;
  if ((styles & ~WHITE_SPACE_STYLES) !== 0) unsupportedCall(call, 'DateTimeStyles の AllowWhiteSpaces 以外の指定');
  return {
    text: argument('s') as string | undefined,
    culture: providerCulture(call.frame.runtime, argument('provider')),
  };
}

/** .NET's message for a string that DateTime.Parse rejects, which points at the first word it does not know. */
export function dateTimeParseError(text: string): string {
  const word = /\p{L}/u.exec(text);
  if (!word) return `String '${text}' was not recognized as a valid DateTime.`;
  return `The string '${text}' was not recognized as a valid DateTime. There is an unknown word starting at index '${word.index}'.`;
}
