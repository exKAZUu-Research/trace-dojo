/** The byte at `index` of a byte string (a string whose code units are all below 256), or 0 past its end. */
export function byteAt(bytes: string, index = 0): number {
  return bytes.codePointAt(index) ?? 0;
}

export function byteArray(bytes: string): Uint8Array {
  return Uint8Array.from(bytes, (char) => byteAt(char));
}
