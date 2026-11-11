// binascii's quoted-printable functions, transcribed from CPython's `Modules/binascii.c`.

const MAXLINESIZE = 76;
const HEX = '0123456789ABCDEF';
const [EQUALS, UNDERSCORE, SPACE, TAB, CR, LF, DOT] = ['=', '_', ' ', '\t', '\r', '\n', '.'].map(
  (char) => char.codePointAt(0) as number
);

function hexValue(byte: number): number {
  const char = String.fromCodePoint(byte);
  return /[0-9A-Fa-f]/.test(char) ? Number.parseInt(char, 16) : -1;
}

/** `binascii.a2b_qp`. */
export function a2bQp(data: Uint8Array, header: boolean): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < data.length) {
    const byte = data[index];
    if (byte === EQUALS) {
      index = decodeEscape(data, index + 1, out);
    } else {
      out.push(header && byte === UNDERSCORE ? SPACE : byte);
      index++;
    }
  }
  return Uint8Array.from(out);
}

/** Decodes what follows an `=`, returning the index after it. */
function decodeEscape(data: Uint8Array, start: number, out: number[]): number {
  let index = start;
  if (index >= data.length) return index;
  if (data[index] === LF || data[index] === CR) {
    while (index < data.length && data[index] !== LF) index++;
    return index < data.length ? index + 1 : index;
  }
  if (data[index] === EQUALS) {
    out.push(EQUALS);
    return index + 1;
  }
  if (index + 1 < data.length && hexValue(data[index]) >= 0 && hexValue(data[index + 1]) >= 0) {
    out.push((hexValue(data[index]) << 4) | hexValue(data[index + 1]));
    return index + 2;
  }
  out.push(EQUALS);
  return index;
}

interface QpOptions {
  quotetabs: boolean;
  istext: boolean;
  header: boolean;
}

/** Whether `b2a_qp` writes the byte at `index` as `=XX`. */
function needsQuoting(data: Uint8Array, index: number, lineLength: number, options: QpOptions): boolean {
  const byte = data[index];
  const last = index + 1 === data.length;
  const next = data[index + 1];
  if (byte > 126 || byte === EQUALS || (options.header && byte === UNDERSCORE)) return true;
  if (byte === DOT && lineLength === 0 && (last || next === LF || next === CR || next === 0)) return true;
  if (!options.istext && (byte === CR || byte === LF)) return true;
  if ((byte === TAB || byte === SPACE) && last) return true;
  return byte < 33 && byte !== CR && byte !== LF && (options.quotetabs || (byte !== TAB && byte !== SPACE));
}

/** `binascii.b2a_qp`, which ends the lines it breaks as the first line of `data` ends. */
// code-gauge-allow functionCognitiveComplexity 18 -- Follows the branches of binascii_b2a_qp_impl.
export function b2aQp(data: Uint8Array, options: QpOptions): Uint8Array {
  const firstLf = data.indexOf(LF);
  const writer = new QpWriter(firstLf > 0 && data[firstLf - 1] === CR ? [CR, LF] : [LF]);
  let index = 0;
  while (index < data.length) {
    const byte = data[index];
    if (needsQuoting(data, index, writer.lineLength, options)) {
      writer.quote(byte);
      index++;
    } else if (options.istext && (byte === LF || (byte === CR && data[index + 1] === LF))) {
      writer.endLine();
      index += byte === CR ? 2 : 1;
    } else {
      writer.literal(
        options.header && byte === SPACE ? UNDERSCORE : byte,
        index + 1 !== data.length && data[index + 1] !== LF
      );
      index++;
    }
  }
  return Uint8Array.from(writer.out);
}

/** The output of `b2a_qp`, breaking its lines with soft line breaks before they grow past 76 characters. */
class QpWriter {
  readonly out: number[] = [];
  lineLength = 0;

  constructor(private readonly newline: number[]) {}

  quote(byte: number): void {
    if (this.lineLength + 3 >= MAXLINESIZE) this.softBreak();
    this.out.push(EQUALS);
    this.pushHex(byte);
    this.lineLength += 3;
  }

  /** Ends a line, quoting the whitespace before it, which mail transports may strip. */
  endLine(): void {
    this.lineLength = 0;
    const previous = this.out.at(-1);
    if (previous === SPACE || previous === TAB) {
      this.out[this.out.length - 1] = EQUALS;
      this.pushHex(previous);
    }
    this.out.push(...this.newline);
  }

  literal(byte: number, mayBreak: boolean): void {
    if (mayBreak && this.lineLength + 1 >= MAXLINESIZE) this.softBreak();
    this.lineLength++;
    this.out.push(byte);
  }

  private softBreak(): void {
    this.out.push(EQUALS, ...this.newline);
    this.lineLength = 0;
  }

  private pushHex(byte: number): void {
    this.out.push(HEX.codePointAt(byte >> 4) as number, HEX.codePointAt(byte & 15) as number);
  }
}
