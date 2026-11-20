export function decodeUtf8(bytes: readonly number[] | Uint8Array): string {
  return createUtf8Decoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

export function createUtf8Decoder(): TextDecoder {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

export function decodeIdentifierBytes(bytes: readonly number[] | Uint8Array, spend?: (cost?: number) => void): string {
  if (!(bytes instanceof Uint8Array)) spend?.(bytes.length);
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  spend?.(input.length);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try {
    return decoder.decode(input);
  } catch {
    return decodeMalformedIdentifier(input, decoder, spend);
  }
}

function decodeMalformedIdentifier(input: Uint8Array, decoder: TextDecoder, spend?: (cost?: number) => void): string {
  let result = '';
  for (let index = 0; index < input.length;) {
    spend?.();
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

export function identifierTextByteLength(text: string): number {
  let length = 0;
  for (const character of text) {
    const point = character.codePointAt(0) as number;
    if (point >= 0xdc_80 && point <= 0xdc_ff) length++;
    else if (point <= 0x7f) length++;
    else if (point <= 0x7_ff) length += 2;
    else if (point <= 0xff_ff) length += 3;
    else length += 4;
  }
  return length;
}
