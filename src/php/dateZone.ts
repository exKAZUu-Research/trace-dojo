import { epochDays, SECONDS_PER_DAY } from './dateCalendar';
import { UnsupportedFeatureError } from './unsupported';

/**
 * A time zone as PHP's DateTimeZone keeps it: a UTC offset (type 1), an abbreviation with its offset (type 2), or an
 * IANA identifier (type 3), whose rules come from the host's `Intl` time zone data.
 */
export type Zone =
  | { type: 1; offset: number }
  | { type: 2; abbr: string; offset: number; dst: boolean }
  | { type: 3; id: string };

export const UTC_ZONE: Zone = { type: 3, id: 'UTC' };

export interface ZoneInfo {
  /** Seconds east of UTC. */
  offset: number;
  dst: boolean;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Instants JavaScript dates can represent, in seconds; zone rules outside them are read at the nearest end. */
const MAX_INSTANT = 8.64e12 - SECONDS_PER_DAY;

/**
 * Whether `name` identifies a zone, compared without case as PHP's time zone database does. `Intl` also accepts
 * legacy names such as JST that PHP's database lacks, so a name without a region other than UTC and GMT is rejected
 * as unsupported when `Intl` knows it.
 */
export function knownZoneId(name: string): boolean {
  if (!/^[A-Za-z][\w+/-]*$/.test(name)) return false;
  try {
    formatterFor(name);
  } catch {
    return false;
  }
  if (!name.includes('/') && !['UTC', 'GMT'].includes(name.toUpperCase()))
    throw new UnsupportedFeatureError(`タイムゾーン ${name}`);
  return true;
}

function formatterFor(id: string): Intl.DateTimeFormat {
  const key = id.toLowerCase();
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** The UTC offset of an identified zone at an instant. */
function idOffset(id: string, seconds: number): number {
  if (id.toUpperCase() === 'UTC') return 0;
  const instant = Math.max(-MAX_INSTANT, Math.min(MAX_INSTANT, Math.floor(seconds)));
  const parts: Record<string, string> = {};
  for (const part of formatterFor(id).formatToParts(instant * 1000)) parts[part.type] = part.value;
  const year = parts.era === 'BC' || parts.era === 'B' ? 1 - Number(parts.year) : Number(parts.year);
  const local =
    epochDays(year, Number(parts.month), Number(parts.day)) * SECONDS_PER_DAY +
    Number(parts.hour) * 3600 +
    Number(parts.minute) * 60 +
    Number(parts.second);
  return local - instant;
}

export function zoneInfo(zone: Zone, seconds: number): ZoneInfo {
  if (zone.type === 1) return { offset: zone.offset, dst: false };
  if (zone.type === 2) return { offset: zone.offset + (zone.dst ? 3600 : 0), dst: zone.dst };
  const offset = idOffset(zone.id, seconds);
  const year = new Date(Math.max(-MAX_INSTANT, Math.min(MAX_INSTANT, seconds)) * 1000).getUTCFullYear();
  const standard = Math.min(
    idOffset(zone.id, epochDays(year, 1, 1) * SECONDS_PER_DAY),
    idOffset(zone.id, epochDays(year, 7, 1) * SECONDS_PER_DAY)
  );
  return { offset, dst: offset > standard };
}

/**
 * The instant of a wall-clock time (seconds since the epoch read as UTC) in a zone. A time a DST gap skips moves
 * forward by the gap, and a time a fall-back repeats takes its first occurrence, as timelib's do_adjust_timezone does.
 */
export function localToInstant(zone: Zone, local: number): number {
  if (zone.type !== 3) return local - zoneInfo(zone, local).offset;
  const before = idOffset(zone.id, local - SECONDS_PER_DAY);
  const after = idOffset(zone.id, local + SECONDS_PER_DAY);
  const candidates = [local - before, local - after].filter(
    (instant) => local - idOffset(zone.id, instant) === instant
  );
  return candidates.length > 0 ? Math.min(...candidates) : local - before;
}

export function formatOffset(offset: number, colon: boolean): string {
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((absolute % 3600) / 60)).padStart(2, '0');
  return `${sign}${hours}${colon ? ':' : ''}${minutes}`;
}

/** The name `timezone` shows for a zone in var_dump and that DateTimeZone::getName returns. */
export function zoneName(zone: Zone): string {
  if (zone.type === 1) return formatOffset(zone.offset, true);
  return zone.type === 2 ? zone.abbr : zone.id;
}

/** Locales whose short zone names, between them, give the abbreviations tzdata uses for common zones. */
const ABBREVIATION_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-IN', 'ja-JP'];
const abbreviationFormatters = new Map<string, Intl.DateTimeFormat>();

/** The abbreviation the `T` format shows, such as JST or CEST. */
export function zoneAbbreviation(zone: Zone, seconds: number): string {
  if (zone.type === 1) return `GMT${formatOffset(zone.offset, false)}`;
  if (zone.type === 2) return zone.abbr.toUpperCase();
  if (zone.id.toUpperCase() === 'UTC') return 'UTC';
  const found = abbreviationAt(zone.id, seconds);
  if (found) return found;
  // CLDR names a zone's abbreviation only from 1970 on; an earlier time with the same offset shares it.
  const offset = idOffset(zone.id, seconds);
  for (const reference of [946_684_800, 962_409_600]) {
    if (idOffset(zone.id, reference) !== offset) continue;
    const name = abbreviationAt(zone.id, reference);
    if (name) return name;
  }
  throw new UnsupportedFeatureError(`タイムゾーン ${zone.id} の略称`);
}

function abbreviationAt(id: string, seconds: number): string | undefined {
  const instant = Math.max(-MAX_INSTANT, Math.min(MAX_INSTANT, seconds)) * 1000;
  for (const locale of ABBREVIATION_LOCALES) {
    const key = `${locale} ${id.toLowerCase()}`;
    let formatter = abbreviationFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, { timeZone: id, timeZoneName: 'short' });
      abbreviationFormatters.set(key, formatter);
    }
    const name = formatter.formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value ?? '';
    if (/^[A-Z]{3,5}$/.test(name) && name !== 'GMT') return name;
    if ((name === 'GMT' || name === 'GMT+0') && idOffset(id, seconds) === 0) return 'GMT';
  }
  return undefined;
}
