import { LIMITS } from '../interpreter/limits';
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

/** How many bytes of encoded strings are kept: enough for the strings a run can hold at once. */
const KEPT_BYTES = 8 * LIMITS.maxStringLength;
/** Shorter strings are measured again each time, which costs less than keeping them. */
const KEPT_FROM_LENGTH = 256;

/**
 * The UTF-8 bytes of the strings a run asks about, which callers only read: `str::len` and `is_char_boundary` are
 * constant-time in Rust, and programs call them again and again on the same strings. The strings asked about least
 * recently are dropped once the kept bytes exceed a bound.
 */
export class Utf8Reader {
  private readonly kept = new Map<string, Uint8Array>();
  private keptBytes = 0;

  of(text: string): Uint8Array {
    let bytes = this.kept.get(text);
    if (bytes) this.kept.delete(text);
    else {
      bytes = encoder.encode(text);
      this.keptBytes += bytes.length;
    }
    this.kept.set(text, bytes);
    for (const [oldest, dropped] of this.kept) {
      if (this.keptBytes <= KEPT_BYTES || oldest === text) break;
      this.kept.delete(oldest);
      this.keptBytes -= dropped.length;
    }
    return bytes;
  }

  /** The UTF-8 length of a string, kept for long strings. */
  length(text: string): number {
    return text.length < KEPT_FROM_LENGTH ? utf8Length(text) : this.of(text).length;
  }

  clear(): void {
    this.kept.clear();
    this.keptBytes = 0;
  }
}

/** The reader of the run in progress, which each run starts empty. */
export const utf8Reader = new Utf8Reader();

export function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    length += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }
  return length;
}
