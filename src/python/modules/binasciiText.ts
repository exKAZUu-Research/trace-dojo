// The uuencode and quoted-printable conversions of `binascii`, transcribed from CPython's binascii.c.

/** The longest line `b2a_qp` writes, beside its soft line break. */
const MAXLINESIZE = 76;

/** `binascii.b2a_uu`: one line of uuencoded data, which holds at most 45 bytes. */
export function encodeUu(data: Uint8Array, backtick: boolean): Uint8Array {
  const out: number[] = [backtick && data.length === 0 ? 0x60 : 0x20 + data.length];
  let leftchar = 0;
  let leftbits = 0;
  for (let index = 0; index < data.length || leftbits !== 0; index++) {
    leftchar = ((leftchar << 8) | (index < data.length ? data[index] : 0)) & 0xff_ff_ff;
    leftbits += 8;
    while (leftbits >= 6) {
      const sixBits = (leftchar >> (leftbits - 6)) & 0x3f;
      leftbits -= 6;
      out.push(backtick && sixBits === 0 ? 0x60 : sixBits + 0x20);
    }
  }
  out.push(0x0a);
  return Uint8Array.from(out);
}

/** `binascii.a2b_uu`: the bytes of one line of uuencoded data, or the message of the binascii.Error it raises. */
export function decodeUu(ascii: Uint8Array): Uint8Array | string {
  if (ascii.length === 0) return 'Missing length byte';
  let binLength = (ascii[0] - 0x20) & 0x3f;
  const out: number[] = [];
  let leftchar = 0;
  let leftbits = 0;
  let index = 1;
  for (; binLength > 0; index++) {
    const char = index < ascii.length ? ascii[index] : 0;
    let value: number;
    if (char === 0x0a || char === 0x0d || index >= ascii.length) value = 0;
    else {
      // 0x60 stands for zero as well, as some encoders write a backtick instead of a space.
      if (char < 0x20 || char > 0x60) return 'Illegal char';
      value = (char - 0x20) & 0x3f;
    }
    leftchar = (leftchar << 6) | value;
    leftbits += 6;
    if (leftbits >= 8) {
      leftbits -= 8;
      out.push((leftchar >> leftbits) & 0xff);
      leftchar &= (1 << leftbits) - 1;
      binLength--;
    }
  }
  for (; index < ascii.length; index++) {
    const char = ascii[index];
    if (char !== 0x20 && char !== 0x60 && char !== 0x0a && char !== 0x0d) return 'Trailing garbage';
  }
  return Uint8Array.from(out);
}

function isHexDigit(char: number | undefined): boolean {
  return char !== undefined && /[0-9A-Fa-f]/.test(String.fromCodePoint(char));
}

/** `binascii.a2b_qp`: decodes quoted-printable data, with `_` for a space in a header. */
export function decodeQp(ascii: Uint8Array, header: boolean): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < ascii.length) {
    const char = ascii[index];
    if (char === 0x3d) {
      index++;
      if (index >= ascii.length) break;
      const next = ascii[index];
      if (next === 0x0a || next === 0x0d) {
        // A soft line break.
        if (next !== 0x0a) while (index < ascii.length && ascii[index] !== 0x0a) index++;
        if (index < ascii.length) index++;
      } else if (next === 0x3d) {
        out.push(0x3d);
        index++;
      } else if (index + 1 < ascii.length && isHexDigit(next) && isHexDigit(ascii[index + 1])) {
        out.push(Number.parseInt(String.fromCodePoint(next, ascii[index + 1]), 16));
        index += 2;
      } else {
        out.push(0x3d);
      }
    } else if (header && char === 0x5f) {
      out.push(0x20);
      index++;
    } else {
      out.push(char);
      index++;
    }
  }
  return Uint8Array.from(out);
}

interface QpOptions {
  quotetabs: boolean;
  istext: boolean;
  header: boolean;
}

/** `binascii.b2a_qp`: encodes data as quoted-printable, with lines of at most 76 characters. */
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes binascii_b2a_qp_impl, which decides each byte in one pass.
export function encodeQp(data: Uint8Array, { quotetabs, istext, header }: QpOptions): Uint8Array {
  const newline = data.indexOf(0x0a);
  const crlf = newline > 0 && data[newline - 1] === 0x0d;
  const out: number[] = [];
  const softBreak = (): void => {
    out.push(0x3d);
    if (crlf) out.push(0x0d);
    out.push(0x0a);
  };
  const pushHex = (byte: number): void => {
    out.push(...[...byte.toString(16).toUpperCase().padStart(2, '0')].map((digit) => digit.codePointAt(0) as number));
  };
  let lineLength = 0;
  let index = 0;
  while (index < data.length) {
    const byte = data[index];
    if (mustQuote(data, index, lineLength, { quotetabs, istext, header })) {
      if (lineLength + 3 >= MAXLINESIZE) {
        softBreak();
        lineLength = 0;
      }
      out.push(0x3d);
      pushHex(byte);
      index++;
      lineLength += 3;
    } else if (istext && (byte === 0x0a || (index + 1 < data.length && byte === 0x0d && data[index + 1] === 0x0a))) {
      lineLength = 0;
      // Whitespace at the end of a line is encoded, as it would be lost.
      const last = out.at(-1);
      if (last === 0x20 || last === 0x09) {
        out[out.length - 1] = 0x3d;
        pushHex(last);
      }
      if (crlf) out.push(0x0d);
      out.push(0x0a);
      index += byte === 0x0d ? 2 : 1;
    } else {
      if (index + 1 !== data.length && data[index + 1] !== 0x0a && lineLength + 1 >= MAXLINESIZE) {
        softBreak();
        lineLength = 0;
      }
      lineLength++;
      out.push(header && byte === 0x20 ? 0x5f : byte);
      index++;
    }
  }
  return Uint8Array.from(out);
}

function mustQuote(data: Uint8Array, index: number, lineLength: number, options: QpOptions): boolean {
  const byte = data[index];
  const next = data[index + 1];
  const isLast = index + 1 === data.length;
  return (
    byte > 126 ||
    byte === 0x3d ||
    (options.header && byte === 0x5f) ||
    (byte === 0x2e && lineLength === 0 && (isLast || next === 0x0a || next === 0x0d || next === 0)) ||
    (!options.istext && (byte === 0x0d || byte === 0x0a)) ||
    ((byte === 0x09 || byte === 0x20) && isLast) ||
    (byte < 33 && byte !== 0x0d && byte !== 0x0a && (options.quotetabs || (byte !== 0x09 && byte !== 0x20)))
  );
}
