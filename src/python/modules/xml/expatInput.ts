// The input of an expat parser: the characters decoded so far with the byte offset of each, and the bytes not yet
// decoded. A character that does not decode is U+FFFF, which the tokenizer rejects as expat rejects a malformed byte.

/** The encodings expat decodes itself, and those an unknown-encoding handler maps byte by byte. */
export type InputEncoding = 'utf8' | 'utf-16le' | 'utf-16be' | 'iso-8859-1' | 'us-ascii' | { table: number[] };

export const INVALID_CHAR = 0xff_ff;

export class ExpatInput {
  /** The decoded characters. */
  readonly cs: number[] = [];
  /** The byte offset of each character, and after the last, the offset of the bytes not yet decoded. */
  readonly offsets: number[] = [0];
  /** The bytes received, kept so that a change of encoding can decode them again. */
  private raw: number[] = [];
  encoding: InputEncoding | undefined;

  /** Adds text, which pyexpat passes to expat as UTF-8. */
  // code-gauge-allow functionCognitiveComplexity 17 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  addText(text: string): void {
    for (const char of text) {
      const code = char.codePointAt(0) as number;
      this.cs.push(code);
      const length = code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
      const last = this.offsets.at(-1) as number;
      this.offsets.push(last + length);
      if (length === 1) {
        this.raw.push(code);
        continue;
      }
      const marks = [0, 0, 0xc0, 0xe0, 0xf0][length] as number;
      for (let index = length - 1; index >= 0; index--) {
        const bits = (code >> (6 * index)) & 0x3f;
        this.raw.push(index === length - 1 ? marks | (code >> (6 * index)) : 0x80 | bits);
      }
    }
  }

  /** The bytes received from an offset on. */
  rawFrom(offset: number): Uint8Array {
    return Uint8Array.from(this.raw.slice(offset));
  }

  /** Adds bytes, decoding all but an incomplete character at the end unless the input is final. */
  addBytes(bytes: ArrayLike<number>, isFinal: boolean): void {
    for (let index = 0; index < bytes.length; index++) this.raw.push(bytes[index] as number);
    if (this.encoding === undefined) {
      if (this.raw.length < 4 && !isFinal) return;
      this.encoding = detectEncoding(this.raw);
    }
    this.decodeFrom(this.offsets.at(-1) as number, isFinal);
  }

  /** Switches the encoding from character `index` on, decoding the bytes after it again. */
  switchEncoding(encoding: InputEncoding, index: number, isFinal: boolean): void {
    this.encoding = encoding;
    const offset = this.offsets[index] as number;
    this.cs.length = index;
    this.offsets.length = index + 1;
    this.decodeFrom(offset, isFinal);
  }

  /** The number of bytes received. */
  get byteLength(): number {
    return this.raw.length;
  }

  private decodeFrom(offset: number, isFinal: boolean): void {
    const encoding = this.encoding ?? 'utf8';
    let position = offset;
    while (position < this.raw.length) {
      const [code, length] = decodeOne(this.raw, position, encoding);
      if (length === 0) {
        if (!isFinal) break;
        this.push(INVALID_CHAR, this.raw.length);
        position = this.raw.length;
        break;
      }
      position += length;
      this.push(code, position);
    }
  }

  private push(code: number, end: number): void {
    this.cs.push(code);
    this.offsets.push(end);
  }
}

/** expat's initial scan: a byte order mark, or the bytes of `<?` in UTF-16, else UTF-8. */
function detectEncoding(raw: number[]): InputEncoding {
  const [a, b] = raw;
  if (a === 0xfe && b === 0xff) return 'utf-16be';
  if (a === 0xff && b === 0xfe) return 'utf-16le';
  if (a === 0x3c && b === 0x00) return 'utf-16le';
  if (a === 0x00 && b === 0x3c) return 'utf-16be';
  return 'utf8';
}

/** One character at `position`: its code point and length in bytes, or a length of 0 when it is incomplete. */
function decodeOne(raw: number[], position: number, encoding: InputEncoding): [number, number] {
  const byte = raw[position] as number;
  if (typeof encoding === 'object') return [encoding.table[byte] ?? INVALID_CHAR, 1];
  switch (encoding) {
    case 'iso-8859-1': {
      return [byte, 1];
    }
    case 'us-ascii': {
      return [byte < 0x80 ? byte : INVALID_CHAR, 1];
    }
    case 'utf-16le':
    case 'utf-16be': {
      return decodeUtf16(raw, position, encoding === 'utf-16le');
    }
    default: {
      return decodeUtf8(raw, position);
    }
  }
}

function decodeUtf16(raw: number[], position: number, little: boolean): [number, number] {
  const unit = (at: number): number | undefined => {
    if (at + 1 >= raw.length) return undefined;
    const [low, high] = little ? [raw[at], raw[at + 1]] : [raw[at + 1], raw[at]];
    return ((high as number) << 8) | (low as number);
  };
  const first = unit(position);
  if (first === undefined) return [0, 0];
  if (first < 0xd8_00 || first > 0xdf_ff) return [first, 2];
  if (first > 0xdb_ff) return [INVALID_CHAR, 2];
  const second = unit(position + 2);
  if (second === undefined) return [0, 0];
  if (second < 0xdc_00 || second > 0xdf_ff) return [INVALID_CHAR, 2];
  return [0x1_00_00 + ((first - 0xd8_00) << 10) + (second - 0xdc_00), 4];
}

// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
function decodeUtf8(raw: number[], position: number): [number, number] {
  const byte = raw[position] as number;
  if (byte < 0x80) return [byte, 1];
  const length = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 0;
  if (length === 0 || byte > 0xf4) return [INVALID_CHAR, 1];
  let code = byte & (0xff >> (length + 1));
  for (let index = 1; index < length; index++) {
    if (position + index >= raw.length) return [0, 0];
    const next = raw[position + index] as number;
    if ((next & 0xc0) !== 0x80) return [INVALID_CHAR, 1];
    code = (code << 6) | (next & 0x3f);
  }
  const minimum = [0, 0, 0x80, 0x8_00, 0x1_00_00][length] as number;
  if (code < minimum || code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return [INVALID_CHAR, 1];
  return [code, length];
}

/** The encoding expat itself decodes for a name an XML declaration gives, if it is one of them. */
export function knownEncoding(name: string): InputEncoding | 'utf-16' | undefined {
  switch (name.toUpperCase()) {
    case 'ISO-8859-1': {
      return 'iso-8859-1';
    }
    case 'US-ASCII': {
      return 'us-ascii';
    }
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- The name expat matches, upper-cased.
    case 'UTF-8': {
      return 'utf8';
    }
    case 'UTF-16': {
      return 'utf-16';
    }
    case 'UTF-16BE': {
      return 'utf-16be';
    }
    case 'UTF-16LE': {
      return 'utf-16le';
    }
    default: {
      return undefined;
    }
  }
}
