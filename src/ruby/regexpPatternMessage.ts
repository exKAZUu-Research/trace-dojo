import { LIMITS } from '../interpreter/limits';
import type { RString } from './objects';
import { rt } from './runtime';
import { stringBytes, stringFromBytes } from './values';

export interface RegexpOptions {
  ignoreCase?: boolean;
  multiline?: boolean;
  extended?: boolean;
  sourceBinary?: boolean;
  fixedEncoding?: boolean;
}

// code-gauge-allow functionNcss 53 -- The ordered cases for Ruby regexp encoding and match state share state; splitting them solely for the metric would hide their sequencing.
export function invalidPatternMessage(pattern: RString, options: RegexpOptions): RString {
  const source = stringBytes(pattern);
  const result = new Uint8Array(LIMITS.maxStringLength);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let length = 0;
  const appendByte = (byte: number): void => {
    rt().checkStringLength(length + 1);
    result[length++] = byte;
  };
  const appendAscii = (text: string): void => {
    for (const char of text) appendByte(char.codePointAt(0) ?? 0);
  };
  appendAscii('invalid multibyte character: /');
  rt().spend(Math.ceil(source.length / 256));
  for (let index = 0; index < source.length;) {
    const first = source[index];
    if (first === 92) {
      appendByte(first);
      index++;
      if (source[index] === 92) {
        appendByte(92);
        index++;
        continue;
      }
      if ((source[index] ?? 0) < 0x80) continue;
      const escaped = source[index];
      let count = 1;
      if (!pattern.usAscii) {
        const width = escaped < 0xe0 ? 2 : escaped < 0xf0 ? 3 : 4;
        if (index + width <= source.length)
          try {
            decoder.decode(source.subarray(index, index + width));
            count = width;
          } catch {}
      }
      for (let offset = 0; offset < count; offset++) appendByte(source[index + offset]);
      index += count;
      continue;
    }
    if (first < 0x80) {
      appendByte(first);
      index++;
      continue;
    }
    if (!pattern.usAscii) {
      const width = first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      try {
        const character = decoder.decode(source.subarray(index, index + width));
        const point = character.codePointAt(0);
        if (point !== undefined) {
          appendAscii(
            point <= 0xff_ff
              ? `\\u${point.toString(16).toUpperCase().padStart(4, '0')}`
              : `\\u{${point.toString(16).toUpperCase()}}`
          );
          index += width;
          continue;
        }
      } catch {}
    }
    appendAscii(`\\x${first.toString(16).toUpperCase().padStart(2, '0')}`);
    index++;
  }
  appendAscii(`/${regexpSuffix(options)}`);
  return stringFromBytes(result.subarray(0, length), false, pattern.usAscii);
}

export function regexpSuffix(options: RegexpOptions): string {
  return `${options.multiline ? 'm' : ''}${options.ignoreCase ? 'i' : ''}${options.extended ? 'x' : ''}`;
}
