// The raw_unicode_escape codec, which pickles of str for protocol 0 use.
import { registerCodec } from './codecs';

function hexDigits(data: Uint8Array, start: number, count: number): number | undefined {
  let value = 0;
  for (let index = start; index < start + count; index++) {
    const digit = Number.parseInt(String.fromCodePoint(data[index] ?? 0x20), 16);
    if (Number.isNaN(digit) || index >= data.length) return undefined;
    value = value * 16 + digit;
  }
  return value;
}

registerCodec('raw_unicode_escape', () => ({
  name: 'rawunicodeescape',
  encode: (points) => {
    const out: number[] = [];
    for (const point of points) {
      if (point < 0x1_00) {
        out.push(point);
        continue;
      }
      const text =
        point < 0x1_00_00 ? `\\u${point.toString(16).padStart(4, '0')}` : `\\U${point.toString(16).padStart(8, '0')}`;
      for (const char of text) out.push(char.codePointAt(0) as number);
    }
    return Uint8Array.from(out);
  },
  decode: (data, errors) => {
    let text = '';
    let index = 0;
    while (index < data.length) {
      const byte = data[index++];
      if (byte !== 0x5c || index >= data.length) {
        text += String.fromCodePoint(byte);
        continue;
      }
      const marker = data[index++];
      if (marker !== 0x75 && marker !== 0x55) {
        text += `\\${String.fromCodePoint(marker)}`;
        continue;
      }
      const count = marker === 0x75 ? 4 : 8;
      const value = hexDigits(data, index, count);
      if (value === undefined || value > 0x10_ff_ff) {
        let end = index;
        while (end < Math.min(data.length, index + count) && /[\da-f]/i.test(String.fromCodePoint(data[end]))) end++;
        const reason =
          value === undefined
            ? marker === 0x75
              ? String.raw`truncated \uXXXX escape`
              : String.raw`truncated \UXXXXXXXX escape`
            : String.raw`\Uxxxxxxxx out of range`;
        const { text: replacement, resume } = errors.decodeError(
          index - 2,
          value === undefined ? end : index + count,
          reason
        );
        text += replacement;
        index = resume;
        continue;
      }
      text += String.fromCodePoint(value);
      index += count;
    }
    return text;
  },
}));
