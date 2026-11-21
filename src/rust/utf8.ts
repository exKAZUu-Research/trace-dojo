import type { Runtime } from './runtime';

const encoder = new TextEncoder();
const lossyDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeUtf8(bytes: Uint8Array, fatal = false): string {
  return (fatal ? strictDecoder : lossyDecoder).decode(bytes);
}

export function utf8Bytes(text: string, runtime: Runtime): bigint[] {
  runtime.allocate(utf8Length(text));
  return Array.from(encoder.encode(text), BigInt);
}

/**
 * The UTF-8 bytes of strings, which callers only read. It keeps those of the last string asked about, since a program
 * that looks at one byte offset after another asks about the same string each time.
 */
export class Utf8Reader {
  private text: string | undefined;
  private bytes = new Uint8Array();

  of(text: string): Uint8Array {
    if (text !== this.text) {
      this.bytes = encoder.encode(text);
      this.text = text;
    }
    return this.bytes;
  }
}

export function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    length += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }
  return length;
}
