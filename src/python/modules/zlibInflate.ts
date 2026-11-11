// zlib 1.2.12's inflate.c, transcribed as a generator that suspends where inflate() returns for more input or
// output, so that what it consumes, writes and reports at each call matches zlib's, error messages included.
import { crc32 } from './binascii';
import { adler32, Z_BUF_ERROR, Z_FINISH, Z_OK, Z_STREAM_END, ZStream } from './zlibDeflate';

export const Z_NEED_DICT = 2;
export const Z_DATA_ERROR = -3;

const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12_289, 16_385, 24_577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** Why the inflate generator suspended. */
type Suspend = 'input' | 'output' | 'dict';

/** A canonical Huffman code, decoded as zlib's tables decode it: one bit at a time, needing no more bits than its code. */
class HuffmanCode {
  readonly count = new Uint16Array(16);
  readonly symbols: Uint16Array;
  readonly maxLength: number;

  constructor(lengths: ArrayLike<number>) {
    for (let index = 0; index < lengths.length; index++) this.count[lengths[index]]++;
    this.count[0] = 0;
    const offsets = new Uint16Array(16);
    for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + this.count[len];
    this.symbols = new Uint16Array(lengths.length);
    for (let index = 0; index < lengths.length; index++) {
      if (lengths[index] !== 0) this.symbols[offsets[lengths[index]]++] = index;
    }
    let max = 15;
    while (max >= 1 && this.count[max] === 0) max--;
    this.maxLength = max;
  }

  /** inflate_table's checks: false for an over-subscribed set, or an incomplete one where zlib rejects it. */
  isValid(allowIncompleteSingle: boolean): boolean {
    if (this.maxLength === 0) return true;
    let left = 1;
    for (let len = 1; len <= 15; len++) {
      left = (left << 1) - this.count[len];
      if (left < 0) return false;
    }
    return !(left > 0 && (!allowIncompleteSingle || this.maxLength !== 1));
  }

  /** The symbol and length of the code at the low end of `hold`, or the length needed when `bits` falls short. */
  decode(hold: number, bits: number): { symbol: number; length: number } | { need: number } {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= this.maxLength; len++) {
      if (len > bits) return { need: len };
      code |= (hold >>> (len - 1)) & 1;
      const count = this.count[len];
      if (code - first < count) return { symbol: this.symbols[index + code - first], length: len };
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    // The hole of an incomplete code, or any code of an empty one, is an invalid code one bit long.
    return bits >= 1 ? { symbol: -1, length: 1 } : { need: 1 };
  }
}

let fixedCodes: [HuffmanCode, HuffmanCode] | undefined;

function fixedTables(): [HuffmanCode, HuffmanCode] {
  if (!fixedCodes) {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    fixedCodes = [new HuffmanCode(lengths), new HuffmanCode(new Uint8Array(32).fill(5))];
  }
  return fixedCodes;
}

class DataError extends Error {}

/** One inflate stream, created with inflateInit2's window bits, which must already be valid. */
export class Inflater {
  readonly strm = new ZStream();
  private readonly wrap: number;
  private wbits: number;
  private hold = 0;
  private bits = 0;
  private flags = -1;
  private check = 0;
  private total = 0;
  private havedict = false;
  private waitingDict = false;
  private window: Uint8Array | undefined;
  private wsize = 0;
  private whave = 0;
  private wnext = 0;
  private phase: 'data' | 'check' | 'done' | 'bad' = 'data';
  private callStartOut = 0;
  private checkedOut = 0;
  private readonly machine: Generator<Suspend, void, void>;

  constructor(windowBits: number) {
    let bits = windowBits;
    if (bits < 0) {
      this.wrap = 0;
      bits = -bits;
    } else {
      this.wrap = (bits >> 4) + 5;
      if (bits < 48) bits &= 15;
    }
    this.wbits = bits;
    this.machine = this.run();
  }

  inflate(flush: number): number {
    const { strm } = this;
    const startIn = strm.availIn;
    this.callStartOut = strm.availOut;
    this.checkedOut = strm.nextOut;
    let ret = Z_OK;
    if (this.phase === 'bad') {
      ret = Z_DATA_ERROR;
    } else if (this.phase === 'done') {
      ret = Z_STREAM_END;
    } else {
      ret = this.resume();
      if (ret === Z_NEED_DICT) return ret;
    }
    const written = this.callStartOut - strm.availOut;
    const beforeCheck = this.phase === 'data';
    if (this.wsize || (written && this.phase !== 'bad' && (beforeCheck || flush !== Z_FINISH))) {
      this.updateWindow(strm.output.subarray(strm.nextOut - written, strm.nextOut));
    }
    strm.totalIn += startIn - strm.availIn;
    this.updateCheck();
    if (((startIn === strm.availIn && written === 0) || flush === Z_FINISH) && ret === Z_OK) ret = Z_BUF_ERROR;
    return ret;
  }

  /** inflateSetDictionary; returns zlib's result code. */
  setDictionary(dictionary: Uint8Array): number {
    const waiting = this.waitingDict;
    if (this.wrap !== 0 && !waiting) return -2;
    if (waiting && adler32(1, dictionary) !== this.check) return Z_DATA_ERROR;
    this.updateWindow(dictionary);
    this.havedict = true;
    return Z_OK;
  }

  private resume(): number {
    try {
      const step = this.machine.next();
      if (step.done) return Z_STREAM_END;
      return step.value === 'dict' ? Z_NEED_DICT : Z_OK;
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      this.strm.msg = error.message;
      this.phase = 'bad';
      return Z_DATA_ERROR;
    }
  }

  private updateCheck(): void {
    const { strm } = this;
    const written = strm.nextOut - this.checkedOut;
    if (this.wrap & 4 && written) {
      const data = strm.output.subarray(this.checkedOut, strm.nextOut);
      this.check = this.flags > 0 ? crc32(data, this.check) : adler32(this.check, data);
      strm.adler = this.check;
    }
    this.total += written;
    strm.totalOut += written;
    this.checkedOut = strm.nextOut;
  }

  private updateWindow(data: Uint8Array): void {
    this.window ??= new Uint8Array(1 << this.wbits);
    if (this.wsize === 0) {
      this.wsize = 1 << this.wbits;
      this.wnext = 0;
      this.whave = 0;
    }
    let copy = data.length;
    if (copy >= this.wsize) {
      this.window.set(data.subarray(copy - this.wsize));
      this.wnext = 0;
      this.whave = this.wsize;
      return;
    }
    const dist = Math.min(this.wsize - this.wnext, copy);
    this.window.set(data.subarray(0, dist), this.wnext);
    copy -= dist;
    if (copy) {
      this.window.set(data.subarray(dist), 0);
      this.wnext = copy;
      this.whave = this.wsize;
    } else {
      this.wnext += dist;
      if (this.wnext === this.wsize) this.wnext = 0;
      if (this.whave < this.wsize) this.whave += dist;
    }
  }

  // The bit accumulator -------------------------------------------------------------------------------------------

  private *needBits(n: number): Generator<Suspend, void, void> {
    while (this.bits < n) yield* this.pullByte();
  }

  private *pullByte(): Generator<Suspend, void, void> {
    const { strm } = this;
    while (strm.availIn === 0) yield 'input';
    strm.availIn--;
    this.hold += strm.input[strm.nextIn++] * 2 ** this.bits;
    this.bits += 8;
  }

  private take(n: number): number {
    const value = this.hold % 2 ** n;
    this.hold = Math.floor(this.hold / 2 ** n);
    this.bits -= n;
    return value;
  }

  private initBits(): void {
    this.hold = 0;
    this.bits = 0;
  }

  private *bytes(count: number): Generator<Suspend, number[], void> {
    const result: number[] = [];
    for (let index = 0; index < count; index++) {
      yield* this.needBits(8);
      result.push(this.take(8));
    }
    return result;
  }

  // The states ----------------------------------------------------------------------------------------------------

  private *run(): Generator<Suspend, void, void> {
    if (this.wrap !== 0) yield* this.header();
    let last = false;
    while (!last) {
      yield* this.needBits(3);
      last = this.take(1) === 1;
      const type = this.take(2);
      if (type === 0) yield* this.stored();
      else if (type === 1) yield* this.codes(...fixedTables());
      else if (type === 2) yield* this.dynamic();
      else throw new DataError('invalid block type');
    }
    this.take(this.bits % 8);
    this.phase = 'check';
    yield* this.trailer();
    this.phase = 'done';
  }

  private *header(): Generator<Suspend, void, void> {
    yield* this.needBits(16);
    if (this.wrap & 2 && this.hold === 0x8b_1f) {
      if (this.wbits === 0) this.wbits = 15;
      this.check = crc32(Uint8Array.of(0x1f, 0x8b), 0);
      this.initBits();
      yield* this.gzipHeader();
      return;
    }
    const cmf = this.hold & 0xff;
    if (!(this.wrap & 1) || ((cmf << 8) + (this.hold >>> 8)) % 31) throw new DataError('incorrect header check');
    if ((cmf & 0x0f) !== 8) throw new DataError('unknown compression method');
    const len = (cmf >> 4) + 8;
    if (this.wbits === 0) this.wbits = len;
    if (len > 15 || len > this.wbits) throw new DataError('invalid window size');
    this.flags = 0;
    const dictionary = this.hold & 0x20_00;
    this.strm.adler = this.check = 1;
    this.initBits();
    if (!dictionary) return;
    const id = yield* this.bytes(4);
    this.strm.adler = this.check = ((id[0] << 24) | (id[1] << 16) | (id[2] << 8) | id[3]) >>> 0;
    this.waitingDict = true;
    while (!this.havedict) yield 'dict';
    this.waitingDict = false;
    this.strm.adler = this.check = 1;
  }

  private *gzipHeader(): Generator<Suspend, void, void> {
    const headerCrc = (data: number[]): void => {
      if (this.flags & 0x02_00 && this.wrap & 4) this.check = crc32(Uint8Array.from(data), this.check);
    };
    const fixed = yield* this.bytes(2);
    this.flags = fixed[0] | (fixed[1] << 8);
    if ((this.flags & 0xff) !== 8) throw new DataError('unknown compression method');
    if (this.flags & 0xe0_00) throw new DataError('unknown header flags set');
    headerCrc(fixed);
    headerCrc(yield* this.bytes(4));
    headerCrc(yield* this.bytes(2));
    if (this.flags & 0x04_00) {
      const length = yield* this.bytes(2);
      headerCrc(length);
      for (let left = length[0] | (length[1] << 8); left > 0; left--) headerCrc(yield* this.rawByte());
    }
    for (const flag of [0x08_00, 0x10_00]) {
      if (!(this.flags & flag)) continue;
      let byte: number[];
      do {
        byte = yield* this.rawByte();
        headerCrc(byte);
      } while (byte[0] !== 0);
    }
    if (this.flags & 0x02_00) {
      const crc = yield* this.bytes(2);
      if (this.wrap & 4 && (crc[0] | (crc[1] << 8)) !== (this.check & 0xff_ff)) {
        throw new DataError('header crc mismatch');
      }
    }
    this.strm.adler = this.check = 0;
  }

  /** A byte of the gzip header's extra field, name or comment, which zlib reads straight from the input. */
  private *rawByte(): Generator<Suspend, number[], void> {
    const { strm } = this;
    while (strm.availIn === 0) yield 'input';
    strm.availIn--;
    return [strm.input[strm.nextIn++]];
  }

  private *stored(): Generator<Suspend, void, void> {
    this.take(this.bits % 8);
    yield* this.needBits(32);
    const length = this.hold % 0x1_00_00;
    if (length !== (Math.floor(this.hold / 0x1_00_00) ^ 0xff_ff)) throw new DataError('invalid stored block lengths');
    this.initBits();
    const { strm } = this;
    let left = length;
    while (left > 0) {
      const copy = Math.min(left, strm.availIn, strm.availOut);
      if (copy === 0) {
        yield strm.availIn === 0 ? 'input' : 'output';
        continue;
      }
      strm.output.set(strm.input.subarray(strm.nextIn, strm.nextIn + copy), strm.nextOut);
      strm.nextIn += copy;
      strm.availIn -= copy;
      strm.nextOut += copy;
      strm.availOut -= copy;
      left -= copy;
    }
  }

  private *dynamic(): Generator<Suspend, void, void> {
    yield* this.needBits(14);
    const nlen = this.take(5) + 257;
    const ndist = this.take(5) + 1;
    const ncode = this.take(4) + 4;
    if (nlen > 286 || ndist > 30) throw new DataError('too many length or distance symbols');
    const codeLengths = new Uint8Array(19);
    for (let index = 0; index < ncode; index++) {
      yield* this.needBits(3);
      codeLengths[ORDER[index]] = this.take(3);
    }
    const lencode = new HuffmanCode(codeLengths);
    if (!lencode.isValid(false)) throw new DataError('invalid code lengths set');
    const lens = yield* this.codeLengths(lencode, nlen + ndist);
    if (lens[256] === 0) throw new DataError('invalid code -- missing end-of-block');
    const literals = new HuffmanCode(lens.subarray(0, nlen));
    if (!literals.isValid(true)) throw new DataError('invalid literal/lengths set');
    const distances = new HuffmanCode(lens.subarray(nlen));
    if (!distances.isValid(true)) throw new DataError('invalid distances set');
    yield* this.codes(literals, distances);
  }

  private *codeLengths(lencode: HuffmanCode, total: number): Generator<Suspend, Uint8Array, void> {
    const lens = new Uint8Array(total);
    let have = 0;
    while (have < total) {
      const { symbol, length } = yield* this.decodeSymbol(lencode);
      if (symbol < 16) {
        this.take(length);
        // An empty code-length code decodes every bit as an invalid code, which zlib reads as length 0.
        lens[have++] = Math.max(symbol, 0);
        continue;
      }
      const [extra, base] = symbol === 16 ? [2, 3] : symbol === 17 ? [3, 3] : [7, 11];
      yield* this.needBits(length + extra);
      this.take(length);
      if (symbol === 16 && have === 0) throw new DataError('invalid bit length repeat');
      const len = symbol === 16 ? lens[have - 1] : 0;
      const copy = base + this.take(extra);
      if (have + copy > total) throw new DataError('invalid bit length repeat');
      lens.fill(len, have, have + copy);
      have += copy;
    }
    return lens;
  }

  /** Pulls bytes until the next code is complete, as zlib's table lookups do; the caller drops its bits. */
  private *decodeSymbol(code: HuffmanCode): Generator<Suspend, { symbol: number; length: number }, void> {
    for (;;) {
      const result = code.decode(this.hold % 0x1_00_00, this.bits);
      if ('symbol' in result) return result;
      yield* this.pullByte();
    }
  }

  private *codes(literals: HuffmanCode, distances: HuffmanCode): Generator<Suspend, void, void> {
    const { strm } = this;
    for (;;) {
      const lit = yield* this.decodeSymbol(literals);
      this.take(lit.length);
      if (lit.symbol < 256 && lit.symbol >= 0) {
        while (strm.availOut === 0) yield 'output';
        strm.output[strm.nextOut++] = lit.symbol;
        strm.availOut--;
        continue;
      }
      if (lit.symbol === 256) return;
      if (lit.symbol < 0 || lit.symbol > 285) throw new DataError('invalid literal/length code');
      const lengthIndex = lit.symbol - 257;
      yield* this.needBits(LENGTH_EXTRA[lengthIndex]);
      const length = LENGTH_BASE[lengthIndex] + this.take(LENGTH_EXTRA[lengthIndex]);
      const dist = yield* this.decodeSymbol(distances);
      this.take(dist.length);
      if (dist.symbol < 0 || dist.symbol > 29) throw new DataError('invalid distance code');
      yield* this.needBits(DIST_EXTRA[dist.symbol]);
      const offset = DIST_BASE[dist.symbol] + this.take(DIST_EXTRA[dist.symbol]);
      yield* this.copyMatch(offset, length);
    }
  }

  private *copyMatch(offset: number, initialLength: number): Generator<Suspend, void, void> {
    const { strm } = this;
    let length = initialLength;
    while (length > 0) {
      while (strm.availOut === 0) yield 'output';
      const writtenThisCall = this.callStartOut - strm.availOut;
      let copy: number;
      if (offset > writtenThisCall) {
        copy = offset - writtenThisCall;
        if (copy > this.whave) throw new DataError('invalid distance too far back');
        const window = this.window as Uint8Array;
        let from: number;
        if (copy > this.wnext) {
          copy -= this.wnext;
          from = this.wsize - copy;
        } else {
          from = this.wnext - copy;
        }
        copy = Math.min(copy, length, strm.availOut);
        strm.output.set(window.subarray(from, from + copy), strm.nextOut);
        strm.nextOut += copy;
      } else {
        copy = Math.min(length, strm.availOut);
        for (let index = 0; index < copy; index++) {
          strm.output[strm.nextOut] = strm.output[strm.nextOut - offset];
          strm.nextOut++;
        }
      }
      strm.availOut -= copy;
      length -= copy;
    }
  }

  private *trailer(): Generator<Suspend, void, void> {
    if (!this.wrap) return;
    const check = yield* this.bytes(4);
    this.updateCheck();
    if (this.wrap & 4) {
      const value =
        this.flags > 0
          ? (check[0] | (check[1] << 8) | (check[2] << 16) | (check[3] << 24)) >>> 0
          : ((check[0] << 24) | (check[1] << 16) | (check[2] << 8) | check[3]) >>> 0;
      if (value !== this.check) throw new DataError('incorrect data check');
    }
    if (this.flags <= 0) return;
    const length = yield* this.bytes(4);
    const value = (length[0] | (length[1] << 8) | (length[2] << 16) | (length[3] << 24)) >>> 0;
    if (this.wrap & 4 && value !== this.total % 2 ** 32) throw new DataError('incorrect length check');
  }
}
