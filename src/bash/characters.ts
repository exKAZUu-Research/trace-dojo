export function capitalize(text: string): string {
  const [first = '', ...rest] = charactersOf(text);
  return upperCase(first) + lowerCase(rest.join(''));
}

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

/** Shared POSIX bracket character-class predicates under macOS `en_US.UTF-8` (`isw*`). */
export const POSIX_CHARACTER_CLASSES: Record<string, (c: string) => boolean> = {
  alnum: (c) => /^[\p{L}\p{N}]$/u.test(c),
  alpha: (c) => /^\p{L}$/u.test(c),
  blank: (c) => c === ' ' || c === '\t',
  cntrl: (c) => /^\p{Cc}$/u.test(c),
  digit: (c) => /^[0-9]$/.test(c),
  graph: (c) => /^[^\p{C}\p{Z}]$/u.test(c),
  lower: (c) => /^\p{Ll}$/u.test(c),
  print: (c) => /^[^\p{C}]$/u.test(c) && c !== '\u2028' && c !== '\u2029',
  punct: (c) => /^(?:[!-/:-@[-`{-~]|\p{P})$/u.test(c),
  space: (c) => /^[ \t\n\v\f\r]$/.test(c),
  upper: (c) => /^\p{Lu}$/u.test(c),
  xdigit: (c) => /^[0-9A-Fa-f]$/.test(c),
};
