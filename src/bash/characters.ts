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
