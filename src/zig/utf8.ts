export function decodeUtf8(bytes: readonly number[]): string {
  return createUtf8Decoder().decode(new Uint8Array(bytes));
}

export function createUtf8Decoder(): TextDecoder {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps strict decoding and the lossless malformed-byte fallback together.
export function decodeIdentifierBytes(bytes: readonly number[]): string {
  const input = new Uint8Array(bytes);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try {
    return decoder.decode(input);
  } catch {
    let result = '';
    for (let index = 0; index < input.length;) {
      const byte = input[index];
      const length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      try {
        result += decoder.decode(input.subarray(index, index + length));
        index += length;
      } catch {
        result += String.fromCodePoint(0xdc_00 + byte);
        index++;
      }
    }
    return result;
  }
}

export function encodeIdentifierText(text: string): number[] {
  const encoder = new TextEncoder();
  if (!/[\uDC80-\uDCFF]/.test(text)) return [...encoder.encode(text)];
  const bytes: number[] = [];
  for (const character of text) {
    const point = character.codePointAt(0) as number;
    if (point >= 0xdc_80 && point <= 0xdc_ff) bytes.push(point - 0xdc_00);
    else for (const byte of encoder.encode(character)) bytes.push(byte);
  }
  return bytes;
}
