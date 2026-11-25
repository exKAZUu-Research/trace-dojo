import { type Moment, resolveParsed } from './dateMoment';
import { parseDateString, type ParsedTime, UnsupportedDateString } from './dateParse';
import { UTC_ZONE, type Zone } from './dateZone';
import { rt, type Runtime } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray, type Value } from './values';

const defaultZones = new WeakMap<Runtime, Zone>();
const lastErrors = new WeakMap<Runtime, PhpArray | false>();
const sleptMicroseconds = new WeakMap<Runtime, number>();

export function defaultZone(): Zone {
  return defaultZones.get(rt()) ?? UTC_ZONE;
}

export function setDefaultZone(zone: Zone): void {
  defaultZones.set(rt(), zone);
}

/**
 * Microseconds since the epoch on the host clock, which stands in for the system time PHP reads, plus the time
 * `sleep` and `usleep` would have waited, since they return at once here.
 */
export function clockMicroseconds(): number {
  return Date.now() * 1000 + (sleptMicroseconds.get(rt()) ?? 0);
}

/** The time `sleep` and `usleep` add to the clock, in microseconds. */
export function sleptTime(): number {
  return sleptMicroseconds.get(rt()) ?? 0;
}

export function advanceClock(microseconds: number): void {
  sleptMicroseconds.set(rt(), sleptTime() + microseconds);
}

export function currentInstant(): { sse: number; us: number } {
  const us = clockMicroseconds();
  return { sse: Math.floor(us / 1_000_000), us: us % 1_000_000 };
}

export function nowIn(zone: Zone): Moment {
  return { ...currentInstant(), zone };
}

/** A timestamp argument as seconds, rejecting the ones beyond the range this grader computes exactly. */
export function timestampSeconds(value: Value): number {
  const seconds = Number(value as bigint);
  if (!Number.isSafeInteger(seconds) || Math.abs(seconds) > 8e15) throw new UnsupportedFeatureError('この範囲の時刻');
  return seconds;
}

const UNSUPPORTED_DATE_STRING = 'この形式の日付と時刻の文字列';

/** Parses a date string, rejecting what PHP may read differently from this grader. */
export function parseOrReject(text: string): ParsedTime {
  let parsed: ParsedTime;
  try {
    parsed = parseDateString(text);
  } catch (error) {
    if (error instanceof UnsupportedDateString) throw new UnsupportedFeatureError(UNSUPPORTED_DATE_STRING);
    throw error;
  }
  const unknown = parsed.unknownAbbreviation;
  if (unknown !== undefined && (parsed.errors.length === 0 || parsed.errors[0].position > unknown))
    throw new UnsupportedFeatureError(`タイムゾーンの略称を含む日付と時刻の文字列（${text}）`);
  return parsed;
}

/** The moment a string means relative to now in a zone, or the parse result when it has errors. */
export function momentFromString(text: string, zone: Zone): Moment | ParsedTime {
  const parsed = parseOrReject(text);
  setLastErrors(parsed);
  if (parsed.errors.length > 0) return parsed;
  return resolveParsed(parsed, nowIn(zone));
}

export function parseFailure(text: string, parsed: ParsedTime): string {
  const [first] = parsed.errors;
  return `Failed to parse time string (${text}) at position ${first.position} (${first.character}): ${first.message}`;
}

/** Records the errors and warnings DateTime::getLastErrors reports, which is false after a clean parse. */
export function setLastErrors(parsed: Pick<ParsedTime, 'errors' | 'warnings'> | undefined): void {
  if (!parsed || (parsed.errors.length === 0 && parsed.warnings.length === 0)) {
    lastErrors.set(rt(), false);
    return;
  }
  const result = new PhpArray();
  result.set('warning_count', BigInt(parsed.warnings.length));
  result.set('warnings', messages(parsed.warnings));
  result.set('error_count', BigInt(parsed.errors.length));
  result.set('errors', messages(parsed.errors));
  lastErrors.set(rt(), result);
}

function messages(list: ParsedTime['errors']): PhpArray {
  const array = new PhpArray();
  for (const message of list) array.set(BigInt(message.position), message.message);
  return array;
}

export function getLastErrors(): PhpArray | false {
  const errors = lastErrors.get(rt()) ?? false;
  return errors === false ? false : errors.copy();
}
