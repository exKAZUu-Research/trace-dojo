// The delta and BCJ filters of liblzma 5.8.4 (`delta_*.c`, `simple_coder.c`, `x86.c`, `powerpc.c`, `ia64.c`,
// `arm.c`, `armthumb.c`, `sparc.c`), for encoding and decoding.
import {
  bufcpy,
  type Coder,
  LZMA_FILTER_ARM,
  LZMA_FILTER_ARMTHUMB,
  LZMA_FILTER_IA64,
  LZMA_FILTER_POWERPC,
  LZMA_FILTER_SPARC,
  LZMA_FILTER_X86,
  LZMA_FINISH,
  LZMA_OK,
  LZMA_OPTIONS_ERROR,
  LZMA_RUN,
  LZMA_STREAM_END,
  LZMA_SYNC_FLUSH,
  type Pos,
} from './xzCommon';

/** `lzma_delta_coder`: the encoder when `encoder`, else the decoder. */
export class DeltaCoder implements Coder {
  private readonly history = new Uint8Array(256);
  private pos = 0;

  constructor(
    private readonly distance: number,
    private readonly encoder: boolean,
    private readonly next: Coder | undefined
  ) {}

  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  code(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number {
    if (this.encoder && this.next === undefined) {
      const size = Math.min(inSize - inPos.value, outSize - outPos.value);
      if (size > 0) out.set(input.subarray(inPos.value, inPos.value + size), outPos.value);
      this.filter(out, outPos.value, outPos.value + size);
      inPos.value += size;
      outPos.value += size;
      return action !== LZMA_RUN && inPos.value === inSize ? LZMA_STREAM_END : LZMA_OK;
    }
    const outStart = outPos.value;
    const ret = (this.next as Coder).code(input, inPos, inSize, out, outPos, outSize, action);
    this.filter(out, outStart, outPos.value);
    return ret;
  }

  private filter(buffer: Uint8Array, start: number, end: number): void {
    const { history, distance } = this;
    for (let i = start; i < end; i++) {
      if (this.encoder) {
        const tmp = history[(distance + this.pos) & 0xff];
        history[this.pos & 0xff] = buffer[i];
        buffer[i] -= tmp;
      } else {
        buffer[i] += history[(distance + this.pos) & 0xff];
        history[this.pos & 0xff] = buffer[i];
      }
      this.pos = (this.pos - 1) & 0xff;
    }
  }
}

/** A BCJ filter function: filters `buffer[start, end)` at stream position `nowPos` and returns how much it did. */
type SimpleFilter = (nowPos: number, isEncoder: boolean, buffer: Uint8Array, start: number, end: number) => number;

interface SimpleKind {
  filter: () => SimpleFilter;
  unfilteredMax: number;
  alignment: number;
}

export const SIMPLE_FILTERS = new Map<bigint, SimpleKind>([
  [LZMA_FILTER_X86, { filter: x86Filter, unfilteredMax: 5, alignment: 1 }],
  [LZMA_FILTER_POWERPC, { filter: () => powerpcCode, unfilteredMax: 4, alignment: 4 }],
  [LZMA_FILTER_IA64, { filter: () => ia64Code, unfilteredMax: 16, alignment: 16 }],
  [LZMA_FILTER_ARM, { filter: () => armCode, unfilteredMax: 4, alignment: 4 }],
  [LZMA_FILTER_ARMTHUMB, { filter: () => armthumbCode, unfilteredMax: 4, alignment: 2 }],
  [LZMA_FILTER_SPARC, { filter: () => sparcCode, unfilteredMax: 4, alignment: 4 }],
]);

/** `lzma_simple_coder`. */
export class SimpleCoder implements Coder {
  private readonly filter: SimpleFilter;
  private readonly buffer: Uint8Array;
  private endWasReached = false;
  private pos = 0;
  private filtered = 0;
  private size = 0;

  constructor(
    kind: SimpleKind,
    private nowPos: number,
    private readonly isEncoder: boolean,
    private readonly next: Coder | undefined
  ) {
    this.filter = kind.filter();
    this.buffer = new Uint8Array(2 * kind.unfilteredMax);
  }

  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  // code-gauge-allow functionNcss 46 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 23 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  code(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number {
    if (action === LZMA_SYNC_FLUSH) return LZMA_OPTIONS_ERROR;
    if (this.pos < this.filtered) {
      this.copyFiltered(out, outPos, outSize);
      if (this.pos < this.filtered) return LZMA_OK;
      if (this.endWasReached) return LZMA_STREAM_END;
    }
    this.filtered = 0;
    const outAvail = outSize - outPos.value;
    const bufAvail = this.size - this.pos;
    if (outAvail > bufAvail || bufAvail === 0) {
      const outStart = outPos.value;
      out.set(this.buffer.subarray(this.pos, this.size), outPos.value);
      outPos.value += bufAvail;
      const ret = this.copyOrCode(input, inPos, inSize, out, outPos, outSize, action);
      if (ret !== LZMA_OK) return ret;
      const size = outPos.value - outStart;
      const filtered = size === 0 ? 0 : this.callFilter(out, outStart, outStart + size);
      const unfiltered = size - filtered;
      this.pos = 0;
      this.size = unfiltered;
      if (this.endWasReached) {
        this.size = 0;
      } else if (unfiltered > 0) {
        outPos.value -= unfiltered;
        this.buffer.set(out.subarray(outPos.value, outPos.value + unfiltered));
      }
    } else if (this.pos > 0) {
      this.buffer.copyWithin(0, this.pos, this.size);
      this.size -= this.pos;
      this.pos = 0;
    }
    if (this.size > 0) {
      const size = { value: this.size };
      const ret = this.copyOrCode(input, inPos, inSize, this.buffer, size, this.buffer.length, action);
      this.size = size.value;
      if (ret !== LZMA_OK) return ret;
      this.filtered = this.callFilter(this.buffer, 0, this.size);
      if (this.endWasReached) this.filtered = this.size;
      this.copyFiltered(out, outPos, outSize);
    }
    return this.endWasReached && this.pos === this.size ? LZMA_STREAM_END : LZMA_OK;
  }

  private copyFiltered(out: Uint8Array, outPos: Pos, outSize: number): void {
    const pos = { value: this.pos };
    bufcpy(this.buffer, pos, this.filtered, out, outPos, outSize);
    this.pos = pos.value;
  }

  // code-gauge-allow functionParameterCount 7 -- Takes the buffers and positions of a liblzma code function separately, as the C does.
  private copyOrCode(
    input: Uint8Array,
    inPos: Pos,
    inSize: number,
    out: Uint8Array,
    outPos: Pos,
    outSize: number,
    action: number
  ): number {
    if (this.next === undefined) {
      bufcpy(input, inPos, inSize, out, outPos, outSize);
      if (this.isEncoder && action === LZMA_FINISH && inPos.value === inSize) this.endWasReached = true;
      return LZMA_OK;
    }
    const ret = this.next.code(input, inPos, inSize, out, outPos, outSize, action);
    if (ret === LZMA_STREAM_END) this.endWasReached = true;
    else if (ret !== LZMA_OK) return ret;
    return LZMA_OK;
  }

  private callFilter(buffer: Uint8Array, start: number, end: number): number {
    const filtered = this.filter(this.nowPos, this.isEncoder, buffer, start, end);
    this.nowPos = (this.nowPos + filtered) >>> 0;
    return filtered;
  }
}

const test86MSByte = (b: number): boolean => b === 0 || b === 0xff;
const MASK_TO_BIT_NUMBER = [0, 1, 2, 2, 3];

function x86Filter(): SimpleFilter {
  const state: X86State = { prevMask: 0, prevPos: 0xff_ff_ff_fb };
  return (nowPos, isEncoder, buffer, start, end) => x86Code(state, nowPos, isEncoder, buffer, start, end);
}

interface X86State {
  prevMask: number;
  prevPos: number;
}

/** `x86_code`. */
function x86Code(
  state: X86State,
  nowPos: number,
  isEncoder: boolean,
  buffer: Uint8Array,
  start: number,
  end: number
): number {
  const size = end - start;
  if (size < 5) return 0;
  if ((nowPos - state.prevPos) >>> 0 > 5) state.prevPos = (nowPos - 5) >>> 0;
  const limit = size - 5;
  let bufferPos = 0;
  while (bufferPos <= limit) {
    const b = buffer[start + bufferPos];
    if (b === 0xe8 || b === 0xe9) {
      bufferPos += x86Instruction(state, (nowPos + bufferPos) >>> 0, isEncoder, buffer, start + bufferPos);
    } else {
      ++bufferPos;
    }
  }
  return bufferPos;
}

/** Converts the call or jump at `at`, at stream position `position`, if it looks like one, and returns its length. */
function x86Instruction(state: X86State, position: number, isEncoder: boolean, buffer: Uint8Array, at: number): number {
  const offset = (position - state.prevPos) >>> 0;
  state.prevPos = position;
  if (offset > 5) {
    state.prevMask = 0;
  } else {
    for (let i = 0; i < offset; ++i) state.prevMask = ((state.prevMask & 0x77) << 1) >>> 0;
  }
  const b = buffer[at + 4];
  if (!test86MSByte(b) || state.prevMask >>> 1 > 4 || state.prevMask >>> 1 === 3) {
    state.prevMask |= 1;
    if (test86MSByte(b)) state.prevMask |= 0x10;
    return 1;
  }
  const src = ((b << 24) | (buffer[at + 3] << 16) | (buffer[at + 2] << 8) | buffer[at + 1]) >>> 0;
  const dest = x86Destination(state.prevMask, src, (position + 5) >>> 0, isEncoder);
  buffer[at + 4] = ~(((dest >>> 24) & 1) - 1);
  buffer[at + 3] = dest >>> 16;
  buffer[at + 2] = dest >>> 8;
  buffer[at + 1] = dest;
  state.prevMask = 0;
  return 5;
}

function x86Destination(prevMask: number, source: number, shift: number, isEncoder: boolean): number {
  let src = source;
  for (;;) {
    const dest = isEncoder ? (src + shift) >>> 0 : (src - shift) >>> 0;
    if (prevMask === 0) return dest;
    const i = MASK_TO_BIT_NUMBER[prevMask >>> 1];
    if (!test86MSByte((dest >>> (24 - i * 8)) & 0xff)) return dest;
    // For i = 0 the shift count is 32, which the hardware CPython runs on takes modulo 32, as JavaScript does.
    src = (dest ^ ((1 << (32 - i * 8)) - 1)) >>> 0;
  }
}

function armCode(nowPos: number, isEncoder: boolean, buffer: Uint8Array, start: number, end: number): number {
  const size = (end - start) & ~3;
  let i: number;
  for (i = 0; i < size; i += 4) {
    const at = start + i;
    if (buffer[at + 3] !== 0xeb) continue;
    const src = ((buffer[at + 2] << 16) | (buffer[at + 1] << 8) | buffer[at]) * 4;
    const dest = (isEncoder ? nowPos + i + 8 + src : src - (nowPos + i + 8)) >>> 2;
    buffer[at + 2] = dest >>> 16;
    buffer[at + 1] = dest >>> 8;
    buffer[at] = dest;
  }
  return i;
}

function armthumbCode(nowPos: number, isEncoder: boolean, buffer: Uint8Array, start: number, end: number): number {
  if (end - start < 4) return 0;
  const size = end - start - 4;
  let i: number;
  for (i = 0; i <= size; i += 2) {
    const at = start + i;
    if ((buffer[at + 1] & 0xf8) !== 0xf0 || (buffer[at + 3] & 0xf8) !== 0xf8) continue;
    const src = (((buffer[at + 1] & 7) << 19) | (buffer[at] << 11) | ((buffer[at + 3] & 7) << 8) | buffer[at + 2]) * 2;
    const dest = ((isEncoder ? nowPos + i + 4 + src : src - (nowPos + i + 4)) >>> 0) >>> 1;
    buffer[at + 1] = 0xf0 | ((dest >>> 19) & 0x7);
    buffer[at] = dest >>> 11;
    buffer[at + 3] = 0xf8 | ((dest >>> 8) & 0x7);
    buffer[at + 2] = dest;
    i += 2;
  }
  return i;
}

function powerpcCode(nowPos: number, isEncoder: boolean, buffer: Uint8Array, start: number, end: number): number {
  const size = (end - start) & ~3;
  let i: number;
  for (i = 0; i < size; i += 4) {
    const at = start + i;
    if (buffer[at] >>> 2 !== 0x12 || (buffer[at + 3] & 3) !== 1) continue;
    const src =
      (((buffer[at] & 3) << 24) | (buffer[at + 1] << 16) | (buffer[at + 2] << 8) | (buffer[at + 3] & ~3)) >>> 0;
    const dest = (isEncoder ? nowPos + i + src : src - (nowPos + i)) >>> 0;
    buffer[at] = 0x48 | ((dest >>> 24) & 0x03);
    buffer[at + 1] = dest >>> 16;
    buffer[at + 2] = dest >>> 8;
    buffer[at + 3] = (buffer[at + 3] & 0x03) | (dest & 0xff);
  }
  return i;
}

const BRANCH_TABLE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 6, 6, 0, 0, 7, 7, 4, 4, 0, 0, 4, 4, 0, 0];

function ia64Code(nowPos: number, isEncoder: boolean, buffer: Uint8Array, start: number, end: number): number {
  const size = (end - start) & ~15;
  let i: number;
  for (i = 0; i < size; i += 16) {
    const mask = BRANCH_TABLE[buffer[start + i] & 0x1f];
    for (let slot = 0, bitPos = 5; slot < 3; ++slot, bitPos += 41) {
      if (((mask >>> slot) & 1) === 0) continue;
      ia64Slot(nowPos + i, isEncoder, buffer, start + i + (bitPos >>> 3), BigInt(bitPos & 7));
    }
  }
  return i;
}

function ia64Slot(position: number, isEncoder: boolean, buffer: Uint8Array, at: number, bitRes: bigint): void {
  let instruction = 0n;
  for (let j = 0; j < 6; ++j) instruction += BigInt(buffer[at + j]) << BigInt(8 * j);
  let instNorm = instruction >> bitRes;
  if (((instNorm >> 37n) & 0xfn) !== 0x5n || ((instNorm >> 9n) & 0x7n) !== 0n) return;
  let src = Number((instNorm >> 13n) & 0xf_ff_ffn);
  src |= Number((instNorm >> 36n) & 1n) << 20;
  src *= 16;
  const dest = ((isEncoder ? position + src : src - position) >>> 0) >>> 4;
  instNorm &= ~(0x8f_ff_ffn << 13n);
  instNorm |= BigInt(dest & 0xf_ff_ff) << 13n;
  instNorm |= BigInt(dest & 0x10_00_00) << (36n - 20n);
  instruction &= (1n << bitRes) - 1n;
  instruction |= instNorm << bitRes;
  for (let j = 0; j < 6; j++) buffer[at + j] = Number((instruction >> BigInt(8 * j)) & 0xffn);
}

function sparcCode(nowPos: number, isEncoder: boolean, buffer: Uint8Array, start: number, end: number): number {
  const size = (end - start) & ~3;
  let i: number;
  for (i = 0; i < size; i += 4) {
    const at = start + i;
    if (
      !(
        (buffer[at] === 0x40 && (buffer[at + 1] & 0xc0) === 0) ||
        (buffer[at] === 0x7f && (buffer[at + 1] & 0xc0) === 0xc0)
      )
    ) {
      continue;
    }
    const src = (((buffer[at] << 24) | (buffer[at + 1] << 16) | (buffer[at + 2] << 8) | buffer[at + 3]) << 2) >>> 0;
    let dest = ((isEncoder ? nowPos + i + src : src - (nowPos + i)) >>> 0) >>> 2;
    dest = (((-((dest >>> 22) & 1) << 22) & 0x3f_ff_ff_ff) | (dest & 0x3f_ff_ff) | 0x40_00_00_00) >>> 0;
    buffer[at] = dest >>> 24;
    buffer[at + 1] = dest >>> 16;
    buffer[at + 2] = dest >>> 8;
    buffer[at + 3] = dest;
  }
  return i;
}
