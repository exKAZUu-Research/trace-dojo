/** Carries the reason Ruby gives for rejecting the source of an expression. */
export class RegexpSourceError extends SyntaxError {}

export function regexpByteEscape(source: string, start: number): { value: number; length: number } | undefined {
  const match = /^\\(?:x([\da-fA-F]{1,2})|([0-7]{1,3}))/.exec(source.slice(start));
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? match[2], match[1] === undefined ? 8 : 16);
  if (value > 0xff) throw new RegexpSourceError('invalid escape code');
  return { value, length: match[0].length };
}
