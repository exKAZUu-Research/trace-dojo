/**
 * String order by `strcoll` in macOS's `en_US.UTF-8` locale, which `[[ a < b ]]` uses: three levels compared from
 * the left, first by base characters (punctuation, then digits, then letters regardless of case and accents), then by
 * accents, then by case (lowercase first). Characters outside the locale's table count for nothing, as macOS ignores
 * them.
 */

import { charactersOf } from './characters';

/** The control characters, which come first in code order. */
const CONTROL_CHARACTERS = String.fromCodePoint(...Array.from({ length: 31 }, (_, index) => index + 1), 0x7f);

/** The base characters in macOS's order, which the probes of Bash 5.3 on macOS showed. */
const PRIMARY_ORDER = charactersOf(
  `${CONTROL_CHARACTERS} _-,;:!?.'"()[]{}@*/\\&#%\`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz`
);

const ACCENTED: Record<string, [string, number]> = Object.fromEntries(
  (
    [
      ['àáâãäå', 'a'],
      ['ç', 'c'],
      ['èéêë', 'e'],
      ['ìíîï', 'i'],
      ['ñ', 'n'],
      ['òóôõöø', 'o'],
      ['ùúûü', 'u'],
      ['ýÿ', 'y'],
    ] as const
  ).flatMap(([accented, base]) =>
    charactersOf(accented).flatMap((c, index) => [
      [c, [base, index + 1]],
      [c.toUpperCase(), [base, index + 1]],
    ])
  )
);

interface Weight {
  primary: number;
  secondary: number;
  tertiary: number;
}

const PRIMARY_INDEX = new Map(PRIMARY_ORDER.map((c, index) => [c, index]));

function weightOf(c: string): Weight | undefined {
  if (c === 'ß') return { primary: (PRIMARY_INDEX.get('s') as number) + 0.5, secondary: 0, tertiary: 0 };
  const accented = Object.hasOwn(ACCENTED, c) ? ACCENTED[c] : undefined;
  const lower = c.toLowerCase();
  const base = accented ? accented[0] : charactersOf(lower).length === 1 && /^[a-z]$/.test(lower) ? lower : c;
  const primary = PRIMARY_INDEX.get(base);
  if (primary === undefined) return undefined;
  return {
    primary,
    secondary: accented ? accented[1] : 0,
    tertiary: c !== lower && /\p{Lu}/u.test(c) ? 1 : 0,
  };
}

/** Compares two strings as `strcoll` does in macOS's `en_US.UTF-8` locale. */
export function compareCollated(a: string, b: string): number {
  const weightsA = charactersOf(a).flatMap((c) => weightOf(c) ?? []);
  const weightsB = charactersOf(b).flatMap((c) => weightOf(c) ?? []);
  for (const level of ['primary', 'secondary', 'tertiary'] as const) {
    const length = Math.min(weightsA.length, weightsB.length);
    for (let i = 0; i < length; i++) {
      const difference = weightsA[i][level] - weightsB[i][level];
      if (difference !== 0) return difference;
    }
    if (weightsA.length !== weightsB.length) return weightsA.length - weightsB.length;
  }
  return 0;
}
