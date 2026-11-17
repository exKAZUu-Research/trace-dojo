export class RegexpEncodingError extends SyntaxError {}

export function decodeRegexpByteEscape(
  source: string,
  start: number,
  first: { value: number; length: number }
): { value: number; length: number } {
  if (first.value < 0x80) return first;
  if (first.value < 0xc2 || first.value > 0xf4) throw new RegexpEncodingError('invalid multibyte escape');
  const width = first.value < 0xe0 ? 2 : first.value < 0xf0 ? 3 : 4;
  const bytes = [first.value];
  let length = first.length;
  while (bytes.length < width) {
    const next = regexpByteEscape(source, start + length);
    if (!next) throw new RegexpEncodingError('too short escaped multibyte character');
    if (next.value < 0x80 || next.value > 0xbf) throw new RegexpEncodingError('invalid multibyte escape');
    bytes.push(next.value);
    length += next.length;
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
    return { value: decoded.codePointAt(0)!, length };
  } catch {
    throw new RegexpEncodingError('invalid multibyte escape');
  }
}

export function regexpByteEscape(source: string, start: number): { value: number; length: number } | undefined {
  const match = /^\\(?:x([\da-fA-F]{1,2})|([0-7]{1,3}))/.exec(source.slice(start));
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? match[2], match[1] === undefined ? 8 : 16);
  if (value > 0xff) throw new RegexpEncodingError('invalid escape code');
  return { value, length: match[0].length };
}
