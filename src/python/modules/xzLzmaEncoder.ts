// The LZMA encoder of liblzma 5.8.4 (`lzma_encoder.c`, `range_encoder.h`), which the LZMA1 and LZMA2 filters share.
import {
  isLcLpPbValid,
  LZMA_MODE_FAST,
  LZMA_MODE_NORMAL,
  LZMA_OK,
  LZMA_STREAM_END,
  type LzmaOptions,
  type Pos,
  UINT32_MAX,
} from './xzCommon';
import type { MatchFinder } from './xzLzEncoder';
import {
  ALIGN_BITS,
  ALIGN_MASK,
  bit0Price,
  bit1Price,
  bittreePrice,
  DIST_ALIGN,
  DIST_MODEL_END,
  DIST_MODEL_START,
  DIST_SLOT,
  DIST_SPECIAL,
  getDistSlot,
  getDistState,
  IS_MATCH,
  IS_REP,
  IS_REP0,
  IS_REP0_LONG,
  IS_REP1,
  IS_REP2,
  LEN_CHOICE,
  LEN_CHOICE2,
  LEN_HIGH,
  LEN_LOW,
  LEN_LOW_SYMBOLS,
  LEN_MID,
  LEN_MID_SYMBOLS,
  LEN_SYMBOLS,
  LIT_STATES,
  literalMaskCalc,
  literalSubcoder,
  MATCH_LEN_CODER,
  MATCH_LEN_MAX,
  MATCH_LEN_MIN,
  POS_STATES_MAX,
  PROBS_SIZE,
  RC_BIT_MODEL_TOTAL,
  RC_MOVE_BITS,
  RC_TOP_VALUE,
  REP_LEN_CODER,
  REPS,
  resetModel,
  updateLongRep,
  updateMatch,
  updateShortRep,
} from './xzLzmaCommon';
import { optimumFast, optimumNormal } from './xzLzmaOptimum';

export const OPTS = 1 << 12;
export const LZMA2_CHUNK_MAX = 1 << 16;
const LOOP_INPUT_MAX = OPTS + 1;

const RC_BIT_0 = 0;
const RC_BIT_1 = 1;
const RC_DIRECT_0 = 2;
const RC_DIRECT_1 = 3;
const RC_FLUSH = 4;

/** `lzma_range_encoder`, which queues the symbols of one LZMA symbol and then encodes them. */
export class RangeEncoder {
  low = 0;
  cacheSize = 1;
  range = UINT32_MAX;
  cache = 0;
  count = 0;
  pos = 0;
  readonly symbols = new Uint8Array(53);
  readonly probIndexes = new Int32Array(53);

  constructor(private readonly probs: Uint16Array) {}

  reset(): void {
    this.low = 0;
    this.cacheSize = 1;
    this.range = UINT32_MAX;
    this.cache = 0;
    this.count = 0;
    this.pos = 0;
  }

  bit(index: number, bit: number): void {
    this.symbols[this.count] = bit;
    this.probIndexes[this.count++] = index;
  }

  bittree(offset: number, bitCount: number, symbol: number): void {
    let modelIndex = 1;
    let left = bitCount;
    do {
      const bit = (symbol >>> --left) & 1;
      this.bit(offset + modelIndex, bit);
      modelIndex = (modelIndex << 1) + bit;
    } while (left !== 0);
  }

  bittreeReverse(offset: number, bitCount: number, symbol: number): void {
    let modelIndex = 1;
    let value = symbol;
    let left = bitCount;
    do {
      const bit = value & 1;
      value >>>= 1;
      this.bit(offset + modelIndex, bit);
      modelIndex = (modelIndex << 1) + bit;
    } while (--left !== 0);
  }

  direct(value: number, bitCount: number): void {
    let left = bitCount;
    do {
      this.symbols[this.count++] = RC_DIRECT_0 + ((value >>> --left) & 1);
    } while (left !== 0);
  }

  flush(): void {
    for (let i = 0; i < 5; i++) this.symbols[this.count++] = RC_FLUSH;
  }

  pending(): number {
    return this.cacheSize + 5 - 1;
  }

  /** `rc_encode`: true when the output ran out before all the queued symbols were written. */
  // code-gauge-allow functionNcss 39 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  encode(out: Uint8Array, outPos: Pos, outSize: number): boolean {
    const { probs } = this;
    while (this.pos < this.count) {
      if (this.range < RC_TOP_VALUE) {
        if (this.shiftLow(out, outPos, outSize)) return true;
        this.range = (this.range << 8) >>> 0;
      }
      const index = this.probIndexes[this.pos];
      switch (this.symbols[this.pos]) {
        case RC_BIT_0: {
          const prob = probs[index];
          this.range = (this.range >>> 11) * prob;
          probs[index] = prob + ((RC_BIT_MODEL_TOTAL - prob) >> RC_MOVE_BITS);
          break;
        }
        case RC_BIT_1: {
          const prob = probs[index];
          const bound = prob * (this.range >>> 11);
          this.low += bound;
          this.range -= bound;
          probs[index] = prob - (prob >> RC_MOVE_BITS);
          break;
        }
        case RC_DIRECT_0: {
          this.range >>>= 1;
          break;
        }
        case RC_DIRECT_1: {
          this.range >>>= 1;
          this.low += this.range;
          break;
        }
        default: {
          this.range = UINT32_MAX;
          do {
            if (this.shiftLow(out, outPos, outSize)) return true;
          } while (++this.pos < this.count);
          this.reset();
          return false;
        }
      }
      ++this.pos;
    }
    this.count = 0;
    this.pos = 0;
    return false;
  }

  private shiftLow(out: Uint8Array, outPos: Pos, outSize: number): boolean {
    const lowLow = this.low >>> 0;
    const lowHigh = Math.floor(this.low / 2 ** 32);
    if (lowLow < 0xff_00_00_00 || lowHigh !== 0) {
      do {
        if (outPos.value === outSize) return true;
        out[outPos.value++] = (this.cache + lowHigh) & 0xff;
        this.cache = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = lowLow >>> 24;
    }
    ++this.cacheSize;
    this.low = (lowLow & 0x00_ff_ff_ff) * 256;
    return false;
  }
}

/** `lzma_length_encoder`'s prices; its probabilities are at `base` in the encoder's array. */
export class LengthEncoder {
  readonly prices = new Uint32Array(POS_STATES_MAX * LEN_SYMBOLS);
  tableSize = 0;
  readonly counters = new Uint32Array(POS_STATES_MAX);

  constructor(
    private readonly probs: Uint16Array,
    readonly base: number
  ) {}

  updatePrices(posState: number): void {
    const { probs, base, tableSize } = this;
    this.counters[posState] = tableSize;
    const a0 = bit0Price(probs[base + LEN_CHOICE]);
    const a1 = bit1Price(probs[base + LEN_CHOICE]);
    const b0 = a1 + bit0Price(probs[base + LEN_CHOICE2]);
    const b1 = a1 + bit1Price(probs[base + LEN_CHOICE2]);
    const at = posState * LEN_SYMBOLS;
    let i = 0;
    for (; i < tableSize && i < LEN_LOW_SYMBOLS; ++i) {
      this.prices[at + i] = a0 + bittreePrice(probs, base + LEN_LOW + posState * 8, 3, i);
    }
    for (; i < tableSize && i < LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS; ++i) {
      this.prices[at + i] = b0 + bittreePrice(probs, base + LEN_MID + posState * 8, 3, i - LEN_LOW_SYMBOLS);
    }
    for (; i < tableSize; ++i) {
      this.prices[at + i] = b1 + bittreePrice(probs, base + LEN_HIGH, 8, i - LEN_LOW_SYMBOLS - LEN_MID_SYMBOLS);
    }
  }

  price(len: number, posState: number): number {
    return this.prices[posState * LEN_SYMBOLS + len - MATCH_LEN_MIN];
  }
}

/** `lzma_lzma1_encoder`. */
export class LzmaEncoder {
  readonly probs = new Uint16Array(PROBS_SIZE);
  readonly rc = new RangeEncoder(this.probs);
  uncompSize = 0;
  state = 0;
  readonly reps = new Uint32Array(REPS);
  matchesCount = 0;
  longestMatchLength = 0;
  fastMode = false;
  isInitialized = false;
  isFlushed = false;
  useEopm = false;
  posMask = 0;
  literalContextBits = 0;
  literalMask = 0;
  readonly matchLenEncoder = new LengthEncoder(this.probs, MATCH_LEN_CODER);
  readonly repLenEncoder = new LengthEncoder(this.probs, REP_LEN_CODER);
  readonly distSlotPrices = new Uint32Array(4 * 64);
  readonly distPrices = new Uint32Array(4 * 128);
  distTableSize = 0;
  matchPriceCount = 0;
  readonly alignPrices = new Uint32Array(16);
  alignPriceCount = 0;
  optsEndIndex = 0;
  optsCurrentIndex = 0;
  readonly optState = new Uint8Array(OPTS);
  readonly optPrev1IsLiteral = new Uint8Array(OPTS);
  readonly optPrev2 = new Uint8Array(OPTS);
  readonly optPosPrev2 = new Uint32Array(OPTS);
  readonly optBackPrev2 = new Uint32Array(OPTS);
  readonly optPrice = new Uint32Array(OPTS);
  readonly optPosPrev = new Uint32Array(OPTS);
  readonly optBackPrev = new Uint32Array(OPTS);
  readonly optBacks = new Uint32Array(OPTS * REPS);
  /** The result of the optimum functions: `back_res` and `len_res`. */
  backRes = 0;
  lenRes = 0;

  /** `lzma_lzma_encoder_create`'s part that depends on the options; false when they are invalid. */
  create(isLzma1: boolean, options: LzmaOptions, niceLen: number): boolean {
    if (options.mode === LZMA_MODE_FAST) {
      this.fastMode = true;
    } else if (options.mode === LZMA_MODE_NORMAL) {
      this.fastMode = false;
      if (options.dictSize > 2 ** 30 + 2 ** 29) return false;
      let logSize = 0;
      while (2 ** logSize < options.dictSize) ++logSize;
      this.distTableSize = logSize * 2;
      this.matchLenEncoder.tableSize = niceLen + 1 - MATCH_LEN_MIN;
      this.repLenEncoder.tableSize = niceLen + 1 - MATCH_LEN_MIN;
    } else {
      return false;
    }
    this.isInitialized = false;
    this.isFlushed = false;
    this.uncompSize = 0;
    this.useEopm = isLzma1;
    return this.reset(options);
  }

  /** `lzma_lzma_encoder_reset`; false when the options are invalid. */
  reset(options: LzmaOptions): boolean {
    if (!isLcLpPbValid(options) || options.niceLen < MATCH_LEN_MIN || options.niceLen > MATCH_LEN_MAX) return false;
    if (options.mode !== LZMA_MODE_FAST && options.mode !== LZMA_MODE_NORMAL) return false;
    this.posMask = (1 << options.pb) - 1;
    this.literalContextBits = options.lc;
    this.literalMask = literalMaskCalc(options.lc, options.lp);
    this.rc.reset();
    this.state = 0;
    this.reps.fill(0);
    resetModel(this.probs, options.lc, options.lp, options.pb);
    for (const encoder of [this.matchLenEncoder, this.repLenEncoder]) {
      if (!this.fastMode) for (let posState = 0; posState < 1 << options.pb; posState++) encoder.updatePrices(posState);
    }
    this.matchPriceCount = UINT32_MAX >>> 1;
    this.alignPriceCount = UINT32_MAX >>> 1;
    this.optsEndIndex = 0;
    this.optsCurrentIndex = 0;
    return true;
  }

  /** `lzma_lzma_encode`; `limit` is `UINT32_MAX` for LZMA1. */
  // code-gauge-allow functionNcss 31 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 24 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  encode(mf: MatchFinder, out: Uint8Array, outPos: Pos, outSize: number, limit: number): number {
    if (!this.isInitialized && !this.encodeInit(mf)) return LZMA_OK;
    if (this.rc.encode(out, outPos, outSize)) return LZMA_OK;
    if (this.isFlushed) return LZMA_STREAM_END;
    for (;;) {
      if (
        limit !== UINT32_MAX &&
        (mf.readPos - mf.readAhead >= limit || outPos.value + this.rc.pending() >= LZMA2_CHUNK_MAX - LOOP_INPUT_MAX)
      ) {
        break;
      }
      if (mf.readPos >= mf.readLimit) {
        if (mf.action === 0) return LZMA_OK;
        if (mf.readAhead === 0) break;
      }
      const position = this.uncompSize >>> 0;
      if (this.fastMode) optimumFast(this, mf);
      else optimumNormal(this, mf, position);
      this.encodeSymbol(mf, this.backRes, this.lenRes, position);
      this.uncompSize += this.lenRes;
      if (this.rc.encode(out, outPos, outSize)) return LZMA_OK;
    }
    if (this.useEopm) this.encodeEopm(this.uncompSize >>> 0);
    this.rc.flush();
    if (this.rc.encode(out, outPos, outSize)) {
      this.isFlushed = true;
      return LZMA_OK;
    }
    return LZMA_STREAM_END;
  }

  private encodeInit(mf: MatchFinder): boolean {
    if (mf.readPos === mf.readLimit) {
      if (mf.action === 0) return false;
    } else {
      mf.skipAhead(1);
      mf.readAhead = 0;
      this.rc.bit(IS_MATCH, 0);
      this.rc.bittree(0, 8, mf.buffer[0]);
      ++this.uncompSize;
    }
    this.isInitialized = true;
    return true;
  }

  private encodeSymbol(mf: MatchFinder, back: number, len: number, position: number): void {
    const posState = position & this.posMask;
    const isMatch = IS_MATCH + this.state * POS_STATES_MAX + posState;
    if (back === UINT32_MAX) {
      this.rc.bit(isMatch, 0);
      this.literal(mf, position);
    } else {
      this.rc.bit(isMatch, 1);
      if (back < REPS) {
        this.rc.bit(IS_REP + this.state, 1);
        this.repMatch(posState, back, len);
      } else {
        this.rc.bit(IS_REP + this.state, 0);
        this.match(posState, back - REPS, len);
      }
    }
    mf.readAhead -= len;
  }

  private literal(mf: MatchFinder, position: number): void {
    const at = mf.readPos - mf.readAhead;
    const curByte = mf.buffer[at];
    const subcoder = literalSubcoder(this.literalContextBits, this.literalMask, position, mf.buffer[at - 1]);
    if (this.state < LIT_STATES) {
      this.state = this.state <= 3 ? 0 : this.state - 3;
      this.rc.bittree(subcoder, 8, curByte);
    } else {
      this.state = this.state <= 9 ? this.state - 3 : this.state - 6;
      this.literalMatched(subcoder, mf.buffer[at - this.reps[0] - 1], curByte);
    }
  }

  private literalMatched(subcoder: number, matchByteStart: number, symbolStart: number): void {
    let offset = 0x1_00;
    let symbol = symbolStart + 0x1_00;
    let matchByte = matchByteStart;
    do {
      matchByte <<= 1;
      const matchBit = matchByte & offset;
      const subcoderIndex = offset + matchBit + (symbol >>> 8);
      this.rc.bit(subcoder + subcoderIndex, (symbol >>> 7) & 1);
      symbol <<= 1;
      offset &= ~(matchByte ^ symbol);
    } while (symbol < 1 << 16);
  }

  private length(encoder: LengthEncoder, posState: number, length: number): void {
    const { rc } = this;
    let len = length - MATCH_LEN_MIN;
    if (len < LEN_LOW_SYMBOLS) {
      rc.bit(encoder.base + LEN_CHOICE, 0);
      rc.bittree(encoder.base + LEN_LOW + posState * 8, 3, len);
    } else {
      rc.bit(encoder.base + LEN_CHOICE, 1);
      len -= LEN_LOW_SYMBOLS;
      if (len < LEN_MID_SYMBOLS) {
        rc.bit(encoder.base + LEN_CHOICE2, 0);
        rc.bittree(encoder.base + LEN_MID + posState * 8, 3, len);
      } else {
        rc.bit(encoder.base + LEN_CHOICE2, 1);
        rc.bittree(encoder.base + LEN_HIGH, 8, len - LEN_MID_SYMBOLS);
      }
    }
    if (!this.fastMode && --encoder.counters[posState] === 0) encoder.updatePrices(posState);
  }

  private match(posState: number, distance: number, len: number): void {
    this.state = updateMatch(this.state);
    this.length(this.matchLenEncoder, posState, len);
    const distSlot = getDistSlot(distance);
    this.rc.bittree(DIST_SLOT + getDistState(len) * 64, 6, distSlot);
    if (distSlot >= DIST_MODEL_START) {
      const footerBits = (distSlot >>> 1) - 1;
      const base = (2 | (distSlot & 1)) << footerBits;
      const distReduced = (distance - base) >>> 0;
      if (distSlot < DIST_MODEL_END) {
        this.rc.bittreeReverse(DIST_SPECIAL + base - distSlot - 1, footerBits, distReduced);
      } else {
        this.rc.direct(distReduced >>> ALIGN_BITS, footerBits - ALIGN_BITS);
        this.rc.bittreeReverse(DIST_ALIGN, ALIGN_BITS, distReduced & ALIGN_MASK);
        ++this.alignPriceCount;
      }
    }
    this.reps.copyWithin(1, 0, 3);
    this.reps[0] = distance;
    ++this.matchPriceCount;
  }

  private repMatch(posState: number, rep: number, len: number): void {
    const { rc, reps, state } = this;
    if (rep === 0) {
      rc.bit(IS_REP0 + state, 0);
      rc.bit(IS_REP0_LONG + state * POS_STATES_MAX + posState, len !== 1 ? 1 : 0);
    } else {
      const distance = reps[rep];
      rc.bit(IS_REP0 + state, 1);
      if (rep === 1) {
        rc.bit(IS_REP1 + state, 0);
      } else {
        rc.bit(IS_REP1 + state, 1);
        rc.bit(IS_REP2 + state, rep - 2);
        if (rep === 3) reps[3] = reps[2];
        reps[2] = reps[1];
      }
      reps[1] = reps[0];
      reps[0] = distance;
    }
    if (len === 1) {
      this.state = updateShortRep(state);
    } else {
      this.length(this.repLenEncoder, posState, len);
      this.state = updateLongRep(state);
    }
  }

  private encodeEopm(position: number): void {
    const posState = position & this.posMask;
    this.rc.bit(IS_MATCH + this.state * POS_STATES_MAX + posState, 1);
    this.rc.bit(IS_REP + this.state, 0);
    this.match(posState, UINT32_MAX, MATCH_LEN_MIN);
  }
}

/** `lzma_lzma_lclppb_encode`'s byte. */
export const lclppbByte = (options: LzmaOptions): number => (options.pb * 5 + options.lp) * 9 + options.lc;
