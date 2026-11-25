export function upperCase(text: string): string {
  return charactersOf(text)
    .map((c) => mapCase(c, c.toUpperCase()))
    .join('');
}

export function lowerCase(text: string): string {
  return charactersOf(text)
    .map((c) => mapCase(c, c.toLowerCase()))
    .join('');
}

/** Single-code-point case mapping: keeps `c` unchanged when `toUpperCase`/`toLowerCase` expands to multiple code points. */
function mapCase(c: string, mapped: string): string {
  return charactersOf(mapped).length === 1 ? mapped : c;
}

/** The characters of a text as Bash counts them in a UTF-8 locale: its code points. */
export function charactersOf(text: string): string[] {
  // oxlint-disable-next-line unicorn/prefer-spread -- Spreading a string draws a warning that it splits characters, which is what Bash's characters are here.
  return Array.from(text);
}

/** Parses a signed 64-bit decimal integer surrounded by optional ASCII whitespace, or `undefined` when invalid. */
export function legalNumber(text: string): bigint | undefined {
  const match = /^[ \t\n\v\f\r]*([-+]?\d+)[ \t\n\v\f\r]*$/.exec(text);
  if (!match) return undefined;
  const value = BigInt(match[1]);
  return value === BigInt.asIntN(64, value) ? value : undefined;
}

/** Shared POSIX bracket character-class predicates under macOS `en_US.UTF-8` (`isw*`). */
export const POSIX_CHARACTER_CLASSES: Record<string, (c: string) => boolean> = {
  alnum: (c) => /^[\p{L}\p{Nd}]$/u.test(c),
  alpha: (c) => /^\p{L}$/u.test(c),
  blank: (c) => c === ' ' || c === '\t',
  cntrl: (c) => c !== '\uFEFF' && /^[\p{Cc}\p{Cf}]$/u.test(c),
  digit: (c) => /^\p{Nd}$/u.test(c),
  graph: (c) => /^[^\p{C}\p{Z}]$/u.test(c),
  lower: (c) => /^\p{Ll}$/u.test(c),
  print: (c) => /^[^\p{C}]$/u.test(c),
  punct: (c) => /^(?:[!-/:-@[-`{-~]|\p{P})$/u.test(c),
  space: (c) => /^[ \t\n\v\f\r\p{Z}]$/u.test(c),
  upper: (c) => /^\p{Lu}$/u.test(c),
  xdigit: (c) => /^[\p{Nd}A-Fa-f]$/u.test(c),
};
