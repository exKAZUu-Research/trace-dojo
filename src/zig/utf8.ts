export function decodeUtf8(bytes: readonly number[]): string {
  return createUtf8Decoder().decode(new Uint8Array(bytes));
}

export function createUtf8Decoder(): TextDecoder {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}
