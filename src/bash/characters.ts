/** The characters of a text as Bash counts them in a UTF-8 locale: its code points. */
export function charactersOf(text: string): string[] {
  // oxlint-disable-next-line unicorn/prefer-spread -- Spreading a string draws a warning that it splits characters, which is what Bash's characters are here.
  return Array.from(text);
}
