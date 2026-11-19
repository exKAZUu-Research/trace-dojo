import { LIMITS } from '../interpreter/limits';
import type { RString } from './objects';
import { rt, type Runtime } from './runtime';
import { isAsciiText } from './unicodeText';

interface Positions {
  characters?: Uint32Array;
  units?: Uint32Array;
  bytes?: Uint32Array | false;
}
interface PositionCache {
  entries: Map<string, Positions>;
  length: number;
}
const caches = new WeakMap<Runtime, PositionCache>();

export function charIndex(text: string, unit: number): number {
  return positionsOf(text).characters?.[unit] ?? unit;
}

export function unitIndex(text: string, character: number): number {
  const units = positionsOf(text).units;
  return units ? units[Math.min(character, units.length - 1)] : character;
}

export function regexpByteIndex(value: RString, unit: number): number {
  if (value.binary) return unit;
  return bytePositions(value.s)?.[unit] ?? unit;
}

export function regexpByteUnit(value: RString, byte: number): number {
  if (value.binary) return Math.min(byte, value.s.length);
  const offsets = bytePositions(value.s);
  if (!offsets) return Math.min(byte, value.s.length);
  let from = 0;
  let to = value.s.length;
  while (from < to) {
    const middle = Math.floor((from + to) / 2);
    if (offsets[middle] < byte) from = middle + 1;
    else to = middle;
  }
  return from;
}

function bytePositions(text: string): Uint32Array | undefined {
  const positions = positionsOf(text);
  if (positions.bytes !== undefined) return positions.bytes || undefined;
  if (isAsciiText(text)) {
    positions.bytes = false;
    return undefined;
  }
  rt().spend(Math.ceil(text.length / 256));
  const offsets = new Uint32Array(text.length + 1);
  let byte = 0;
  for (let unit = 0; unit < text.length;) {
    const point = text.codePointAt(unit)!;
    offsets[unit++] = byte;
    if (point > 0xff_ff) offsets[unit++] = byte;
    byte += utf8ByteWidth(point);
  }
  offsets[text.length] = byte;
  positions.bytes = offsets;
  return offsets;
}

function utf8ByteWidth(point: number): number {
  if (point < 0x80 || (point >= 0xdc_80 && point <= 0xdc_ff)) return 1;
  if (point < 0x8_00) return 2;
  return point < 0x1_00_00 ? 3 : 4;
}

function positionsOf(text: string): Positions {
  const runtime = rt();
  let cache = caches.get(runtime);
  if (!cache) {
    cache = { entries: new Map(), length: 0 };
    caches.set(runtime, cache);
  }
  const existing = cache.entries.get(text);
  if (existing) return existing;
  while (cache.entries.size >= LIMITS.maxCallDepth || cache.length + text.length > LIMITS.maxStringLength) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.entries.delete(oldest);
    cache.length -= oldest.length;
  }
  runtime.spend(Math.ceil(text.length / 256));
  const positions = buildPositions(text);
  cache.entries.set(text, positions);
  cache.length += text.length;
  return positions;
}

function buildPositions(text: string): Positions {
  if (!/[\uD800-\uDFFF]/.test(text)) return {};
  const characters = new Uint32Array(text.length + 1);
  const units: number[] = [];
  let character = 0;
  for (let unit = 0; unit < text.length;) {
    units.push(unit);
    characters[unit++] = character;
    if (text.codePointAt(unit - 1)! > 0xff_ff) characters[unit++] = character + 1;
    character++;
  }
  characters[text.length] = character;
  units.push(text.length);
  return { characters, units: Uint32Array.from(units) };
}
