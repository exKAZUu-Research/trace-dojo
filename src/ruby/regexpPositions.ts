import { LIMITS } from '../interpreter/limits';
import { rt, type Runtime } from './runtime';

interface Positions {
  characters?: Uint32Array;
  units?: Uint32Array;
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
