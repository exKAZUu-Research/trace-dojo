/** `repr()` of the bytes of a bytes or bytearray object, as CPython writes a bytes literal. */
export function bytesLiteral(data: Uint8Array, alwaysEscapeSingleQuotes = false): string {
  const quote = data.includes(0x27) && !data.includes(0x22) ? '"' : "'";
  let result = quote;
  for (const byte of data) {
    if (byte === 0x27 && (quote === "'" || alwaysEscapeSingleQuotes)) result += String.raw`\'`;
    else if (byte === 0x5c) result += String.raw`\\`;
    else if (byte === 0x09) result += String.raw`\t`;
    else if (byte === 0x0a) result += String.raw`\n`;
    else if (byte === 0x0d) result += String.raw`\r`;
    else if (byte < 0x20 || byte >= 0x7f) result += `\\x${byte.toString(16).padStart(2, '0')}`;
    else result += String.fromCodePoint(byte);
  }
  return result + quote;
}
