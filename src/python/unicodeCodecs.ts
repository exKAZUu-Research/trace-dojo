import { latin1Text } from './bytesValues';
import { type ErrorHandling, registerCodec, type TextCodec } from './codecs';

/** Puts a code point's bytes into `out`, or returns false when the codec cannot encode it. */
export type PointEncoder = (point: number, out: number[]) => boolean;

/**
 * Encodes code points one at a time, giving the characters `encodePoint` refuses to the error handler: each run of
 * them at once when `groupErrors` is set, as CPython's single-byte and UTF-8 encoders do, or one by one.
 */
// code-gauge-allow functionCognitiveComplexity 25 -- Follows how CPython's encoders hand errors to the handler.
export function encodePoints(
  points: readonly number[],
  errors: ErrorHandling,
  reason: string,
  encodePoint: PointEncoder,
  options: {
    groupErrors: boolean;
    passSurrogate?: (point: number) => readonly number[];
    prefix?: number[];
    /** The code unit size of UTF-16 and UTF-32, whose error handlers must give whole code units of bytes. */
    unitSize?: number;
  }
): Uint8Array {
  const out: number[] = [...(options.prefix ?? [])];
  let index = 0;
  while (index < points.length) {
    if (encodePoint(points[index], out)) {
      index++;
      continue;
    }
    let end = index + 1;
    if (options.groupErrors) while (end < points.length && !encodePoint(points[end], [])) end++;
    const replacement = errors.encodeError(index, end, reason, options.passSurrogate);
    if ('bytes' in replacement && replacement.bytes.length % (options.unitSize ?? 1) !== 0) {
      throw errors.encodeException(index, end, reason);
    }
    if ('bytes' in replacement) {
      for (const byte of replacement.bytes) out.push(byte);
    } else {
      for (const char of replacement.text) {
        if (!encodePoint(char.codePointAt(0) as number, out)) throw errors.encodeException(index, end, reason);
      }
    }
    index = end;
  }
  return Uint8Array.from(out);
}

const isSurrogate = (point: number): boolean => point >= 0xd8_00 && point <= 0xdf_ff;

const SINGLE_BYTE_INLINE_HANDLERS = {
  encode: new Set(['ignore', 'replace', 'backslashreplace', 'xmlcharrefreplace', 'surrogateescape']),
  decode: new Set(['ignore', 'replace', 'surrogateescape']),
};
const UTF8_INLINE_HANDLERS = {
  encode: new Set([...SINGLE_BYTE_INLINE_HANDLERS.encode, 'surrogatepass']),
  decode: SINGLE_BYTE_INLINE_HANDLERS.decode,
};

// ASCII and Latin-1 -------------------------------------------------------------------------------------------------

function singleByteCodec(name: string, limit: number): TextCodec {
  const reason = `ordinal not in range(${limit})`;
  return {
    name,
    inlineHandlers: SINGLE_BYTE_INLINE_HANDLERS,
    encode: (points, errors) =>
      encodePoints(points, errors, reason, (point, out) => point < limit && out.push(point) > 0, {
        groupErrors: true,
      }),
    decode: (data, errors) => {
      let text = '';
      let index = 0;
      while (index < data.length) {
        const byte = data[index];
        if (byte < limit) {
          text += String.fromCodePoint(byte);
          index++;
          continue;
        }
        const { text: replacement, resume } = errors.decodeError(index, index + 1, reason);
        text += replacement;
        index = resume;
      }
      return text;
    },
  };
}

registerCodec('ascii', () => singleByteCodec('ascii', 0x80));
registerCodec('latin_1', () => singleByteCodec('latin-1', 0x1_00));

// UTF-8 -------------------------------------------------------------------------------------------------------------

function encodeUtf8Point(point: number, out: number[]): boolean {
  if (point < 0x80) out.push(point);
  else if (point < 0x8_00) out.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
  else if (isSurrogate(point)) return false;
  else if (point < 0x1_00_00) out.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  else {
    out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  }
  return true;
}

function passUtf8Surrogate(point: number): number[] {
  return [0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f)];
}

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

const invalid = (length: number): { reason: string; length: number } => ({
  reason: 'invalid continuation byte',
  length,
});

/**
 * Classifies the sequence starting at a non-ASCII byte as CPython's UTF-8 decoder does: its length when valid, or
 * the error and how many bytes the error covers.
 */
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes the checks of CPython's UTF-8 decoder.
function utf8Sequence(data: Uint8Array, index: number): { length: number } | { reason: string; length: number } {
  const lead = data[index];
  const available = data.length - index;
  const truncated = { reason: 'unexpected end of data', length: available };
  if (lead < 0xc2 || lead > 0xf4) return { reason: 'invalid start byte', length: 1 };
  const second = data[index + 1];
  if (lead < 0xe0) {
    if (available < 2) return truncated;
    return isContinuation(second) ? { length: 2 } : invalid(1);
  }
  if (lead < 0xf0) {
    if (available >= 2 && (!isContinuation(second) || (second < 0xa0 ? lead === 0xe0 : lead === 0xed))) {
      return invalid(1);
    }
    if (available < 3) return truncated;
    return isContinuation(data[index + 2]) ? { length: 3 } : invalid(2);
  }
  if (available >= 2 && (!isContinuation(second) || (second < 0x90 ? lead === 0xf0 : lead === 0xf4))) {
    return invalid(1);
  }
  if (available >= 3 && !isContinuation(data[index + 2])) return invalid(2);
  if (available < 4) return truncated;
  return isContinuation(data[index + 3]) ? { length: 4 } : invalid(3);
}

function decodeUtf8(data: Uint8Array, errors: ErrorHandling, start = 0): string {
  let text = '';
  let index = start;
  while (index < data.length) {
    const lead = data[index];
    if (lead < 0x80) {
      let end = index + 1;
      while (end < data.length && data[end] < 0x80) end++;
      text += latin1Text(data.subarray(index, end));
      index = end;
      continue;
    }
    const sequence = utf8Sequence(data, index);
    if ('reason' in sequence) {
      const { text: replacement, resume } = errors.decodeError(index, index + sequence.length, sequence.reason, () =>
        utf8Surrogate(data, index)
      );
      text += replacement;
      index = resume;
      continue;
    }
    text += String.fromCodePoint(utf8Point(data, index, sequence.length));
    index += sequence.length;
  }
  return text;
}

function utf8Point(data: Uint8Array, index: number, length: number): number {
  const masks = [0, 0, 0x1f, 0x0f, 0x07];
  let point = data[index] & masks[length];
  for (let offset = 1; offset < length; offset++) point = (point << 6) | (data[index + offset] & 0x3f);
  return point;
}

/** An encoded surrogate at `index`, which the surrogatepass handler decodes. */
function utf8Surrogate(data: Uint8Array, index: number): { point: number; length: number } | undefined {
  if (data[index] !== 0xed || !isContinuation(data[index + 2])) return undefined;
  const second = data[index + 1];
  if (second < 0xa0 || second > 0xbf) return undefined;
  return { point: utf8Point(data, index, 3), length: 3 };
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

registerCodec('utf_8', () => ({
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- CPython's messages name the codec utf-8.
  name: 'utf-8',
  inlineHandlers: UTF8_INLINE_HANDLERS,
  encode: (points, errors) =>
    encodePoints(points, errors, 'surrogates not allowed', encodeUtf8Point, {
      groupErrors: true,
      passSurrogate: passUtf8Surrogate,
    }),
  decode: (data, errors) => decodeUtf8(data, errors),
}));
registerCodec('utf_8_sig', () => ({
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- CPython's messages name the codec utf-8.
  name: 'utf-8',
  inlineHandlers: UTF8_INLINE_HANDLERS,
  encode: (points, errors) =>
    encodePoints(points, errors, 'surrogates not allowed', encodeUtf8Point, {
      groupErrors: true,
      passSurrogate: passUtf8Surrogate,
      prefix: UTF8_BOM,
    }),
  decode: (data, errors) => decodeUtf8(data, errors, UTF8_BOM.every((byte, index) => data[index] === byte) ? 3 : 0),
}));

// UTF-16 and UTF-32 -------------------------------------------------------------------------------------------------

type ByteOrder = 'little' | 'big';

function unitBytes(unit: number, size: 2 | 4, order: ByteOrder): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < size; index++) bytes.push((unit >>> (8 * index)) & 0xff);
  return order === 'little' ? bytes : bytes.toReversed();
}

function readUnit(data: Uint8Array, index: number, size: 2 | 4, order: ByteOrder): number {
  let unit = 0;
  for (let offset = 0; offset < size; offset++) {
    const byte = data[index + (order === 'little' ? size - 1 - offset : offset)];
    unit = unit * 256 + byte;
  }
  return unit;
}

function encodeUtf16Point(order: ByteOrder): PointEncoder {
  return (point, out) => {
    if (isSurrogate(point)) return false;
    if (point < 0x1_00_00) out.push(...unitBytes(point, 2, order));
    else {
      const offset = point - 0x1_00_00;
      out.push(...unitBytes(0xd8_00 | (offset >> 10), 2, order), ...unitBytes(0xdc_00 | (offset & 0x3_ff), 2, order));
    }
    return true;
  };
}

/** The byte order a UTF-16 or UTF-32 decoder reads, from the byte order mark when the codec does not fix it. */
function detectOrder(data: Uint8Array, size: 2 | 4, fixed: ByteOrder | undefined): { order: ByteOrder; start: number } {
  if (fixed) return { order: fixed, start: 0 };
  if (data.length >= size) {
    if (readUnit(data, 0, size, 'little') === 0xfe_ff) return { order: 'little', start: size };
    if (readUnit(data, 0, size, 'big') === 0xfe_ff) return { order: 'big', start: size };
  }
  return { order: 'little', start: 0 };
}

function decodeUtf16(data: Uint8Array, errors: ErrorHandling, order: ByteOrder, start: number): string {
  let text = '';
  let index = start;
  const fail = (from: number, to: number, reason: string, pass?: () => { point: number; length: number }): void => {
    const { text: replacement, resume } = errors.decodeError(from, to, reason, pass);
    text += replacement;
    index = resume;
  };
  while (index < data.length) {
    if (data.length - index < 2) {
      fail(index, data.length, 'truncated data');
      continue;
    }
    const unit = readUnit(data, index, 2, order);
    const single = { point: unit, length: 2 };
    if (unit < 0xd8_00 || unit > 0xdf_ff) {
      text += String.fromCodePoint(unit);
      index += 2;
    } else if (unit >= 0xdc_00) {
      fail(index, index + 2, 'illegal encoding', () => single);
    } else if (data.length - index < 4) {
      fail(index, data.length, 'unexpected end of data', () => single);
    } else {
      const low = readUnit(data, index + 2, 2, order);
      if (low >= 0xdc_00 && low <= 0xdf_ff) {
        text += String.fromCodePoint(0x1_00_00 + ((unit - 0xd8_00) << 10) + (low - 0xdc_00));
        index += 4;
      } else {
        fail(index, index + 2, 'illegal UTF-16 surrogate', () => single);
      }
    }
  }
  return text;
}

function decodeUtf32(data: Uint8Array, errors: ErrorHandling, order: ByteOrder, start: number): string {
  let text = '';
  let index = start;
  while (index < data.length) {
    let reason: string | undefined;
    let end = index + 4;
    if (data.length - index < 4) {
      reason = 'truncated data';
      end = data.length;
    } else {
      const point = readUnit(data, index, 4, order);
      if (point > 0x10_ff_ff) reason = 'code point not in range(0x110000)';
      else if (isSurrogate(point)) reason = 'code point in surrogate code point range(0xd800, 0xe000)';
      else {
        text += String.fromCodePoint(point);
        index += 4;
        continue;
      }
    }
    const surrogate = reason.startsWith('code point in')
      ? { point: readUnit(data, index, 4, order), length: 4 }
      : undefined;
    const { text: replacement, resume } = errors.decodeError(index, end, reason, () => surrogate);
    text += replacement;
    index = resume;
  }
  return text;
}

/** A UTF-16 or UTF-32 codec, whose byte order is fixed or comes from a byte order mark. */
function utfCodec(size: 2 | 4, fixed: ByteOrder | undefined): TextCodec {
  const base = `utf-${size * 8}`;
  const suffix = (order: ByteOrder): string => (order === 'little' ? 'le' : 'be');
  const order = fixed ?? 'little';
  const encodePoint: PointEncoder =
    size === 2
      ? encodeUtf16Point(order)
      : (point, out) => !isSurrogate(point) && out.push(...unitBytes(point, 4, order)) > 0;
  return {
    name: fixed === undefined ? base : `${base}-${suffix(fixed)}`,
    encode: (points, errors) =>
      encodePoints(points, errors, 'surrogates not allowed', encodePoint, {
        groupErrors: false,
        unitSize: size,
        passSurrogate: (point) => unitBytes(point, size, order),
        prefix: fixed === undefined ? unitBytes(0xfe_ff, size, 'little') : [],
      }),
    decode: (data, errors) => {
      const detected = detectOrder(data, size, fixed);
      const decode = size === 2 ? decodeUtf16 : decodeUtf32;
      return decode(data, errors.renamed(`${base}-${suffix(detected.order)}`), detected.order, detected.start);
    },
  };
}

for (const size of [2, 4] as const) {
  registerCodec(`utf_${size * 8}`, () => utfCodec(size, undefined));
  registerCodec(`utf_${size * 8}_le`, () => utfCodec(size, 'little'));
  registerCodec(`utf_${size * 8}_be`, () => utfCodec(size, 'big'));
}
