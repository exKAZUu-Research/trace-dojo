import type { Frame } from '../runtime';
import { foldJdkCodePoint } from './jdkUnicode';

export interface TextSearch {
  readonly matchesAt: (index: number) => boolean;
  readonly includes: () => boolean;
  readonly indexOf: (start: number) => number;
  readonly lastIndexOf: (start: number) => number;
}

// code-gauge-allow functionCognitiveComplexity -- forward and reverse searches apply different JVM bounds to the same matcher.
export function textSearch(
  frame: Frame,
  value: string,
  target: string,
  ignoreCase: boolean,
  codeUnitsOnly = false
): TextSearch {
  const end = value.length - target.length;
  const regionMatches = ignoreCase ? caseInsensitiveRegion(frame, value, target, codeUnitsOnly) : undefined;
  const indexOf = (start: number): number => {
    if (codeUnitsOnly && start > value.length) return -1;
    return regionMatches ? findRegion(regionMatches, Math.max(0, start), end, 1) : value.indexOf(target, start);
  };
  return {
    matchesAt: (index: number): boolean => {
      if (index < 0 || index > end) return false;
      if (regionMatches) return regionMatches(index);
      frame.runtime.spend(1 + Math.floor(target.length / 64));
      return value.startsWith(target, index);
    },
    includes: () => indexOf(0) !== -1,
    indexOf,
    lastIndexOf: (start: number): number => {
      const position = ignoreCase || codeUnitsOnly ? Math.min(start, value.length - 1) : start;
      if (position < 0) return -1;
      return regionMatches
        ? findRegion(regionMatches, Math.min(position, end), 0, -1)
        : value.lastIndexOf(target, position);
    },
  };
}

function findRegion(matches: (index: number) => boolean, from: number, to: number, step: 1 | -1): number {
  for (let index = from; (to - index) * step >= 0; index += step) {
    if (matches(index)) return index;
  }
  return -1;
}

function caseInsensitiveRegion(
  frame: Frame,
  value: string,
  target: string,
  codeUnitsOnly: boolean
): (index: number) => boolean {
  frame.runtime.spend();
  let work = 0;
  return (index) => {
    const end = index + target.length;
    let offset = 0;
    while (offset < target.length) {
      if (++work === 64) {
        frame.runtime.spend();
        work = 0;
      }
      const left = regionPoint(value, index + offset, end, codeUnitsOnly);
      const right = regionPoint(target, offset, target.length, codeUnitsOnly);
      if (left !== right && foldJdkCodePoint(left) !== foldJdkCodePoint(right)) return false;
      offset += left > 0xff_ff ? 2 : 1;
    }
    return true;
  };
}

function regionPoint(value: string, index: number, end: number, codeUnitsOnly: boolean): number {
  if (!codeUnitsOnly && index + 1 < end) return value.codePointAt(index) as number;
  // oxlint-disable-next-line unicorn/prefer-code-point -- a region can end halfway through a surrogate pair.
  return value.charCodeAt(index);
}
