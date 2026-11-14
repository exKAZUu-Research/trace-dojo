// code-gauge-allow-file fileNcss 557 -- Transcribes liblzma 5.8.4 C sources together, which read best side by side with them.
// The LZMA1 and LZMA2 decoders of liblzma 5.8.4 (`lz_decoder.c`, `lzma_decoder.c`, `lzma2_decoder.c`). The LZMA
// decoder is the "safe" half of `lzma_decode`, which decodes the same bits as its fast half while stopping wherever
// the input runs out. The dictionary grows as it fills rather than being allocated at its full size.
import {
  type Coder,
  isLcLpPbValid,
  lclppbDecode,
  LZMA_DATA_ERROR,
  LZMA_FILTER_LZMA1EXT,
  LZMA_OK,
  LZMA_PROG_ERROR,
  LZMA_STREAM_END,
  type LzmaOptions,
  type Pos,
  UINT32_MAX,
  VLI_UNKNOWN,
} from './xzCommon';
import {
  DIST_ALIGN,
  DIST_MODEL_END,
  DIST_MODEL_START,
  DIST_SLOT,
  DIST_SPECIAL,
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
  LEN_MID,
  LIT_STATES,
  literalMaskCalc,
  literalSubcoder,
  MATCH_LEN_CODER,
  MATCH_LEN_MIN,
  POS_STATES_MAX,
  PROBS_SIZE,
  RC_BIT_MODEL_TOTAL,
  RC_MOVE_BITS,
  RC_TOP_VALUE,
  REP_LEN_CODER,
  resetModel,
  updateLongRep,
  updateMatch,
  updateShortRep,
} from './xzLzmaCommon';

const LZ_DICT_REPEAT_MAX = 288;
const LZ_DICT_INIT_POS = 2 * LZ_DICT_REPEAT_MAX;

/** `lzma_dict`. */
export class Dict {
  buf = new Uint8Array(0);
  pos = 0;
  full = 0;
  limit = 0;
  size = 0;
  hasWrapped = false;
  needReset = false;

  get(distance: number): number {
    return this.buf[this.pos - distance - 1 + (distance < this.pos ? 0 : this.size - LZ_DICT_REPEAT_MAX)];
  }

  /** `dict_put_safe`: false when the dictionary is at its limit. */
  put(byte: number): boolean {
    if (this.pos === this.limit) return false;
    this.buf[this.pos++] = byte;
    if (!this.hasWrapped) this.full = this.pos - LZ_DICT_INIT_POS;
    return true;
  }

  /** `dict_repeat`, which returns the length left to copy. */
  repeat(distance: number, len: number): number {
    let left = Math.min(this.limit - this.pos, len);
    const rest = len - left;
    let back = this.pos - distance - 1;
    if (distance >= this.pos) back += this.size - LZ_DICT_REPEAT_MAX;
    const { buf } = this;
    while (left-- > 0) buf[this.pos++] = buf[back++];
    if (!this.hasWrapped) this.full = this.pos - LZ_DICT_INIT_POS;
    return rest;
  }

  /** `dict_write`, which copies up to `left.value` bytes of input. */
  write(input: Uint8Array, inPos: Pos, inSize: number, left: Pos): void {
    const size = Math.min(inSize - inPos.value, left.value, this.limit - this.pos);
    this.buf.set(input.subarray(inPos.value, inPos.value + size), this.pos);
    inPos.value += size;
    this.pos += size;
    left.value -= size;
    if (!this.hasWrapped) this.full = this.pos - LZ_DICT_INIT_POS;
  }

  /** Grows the buffer so that it holds `end` bytes. */
  reserve(end: number): void {
    if (end <= this.buf.length) return;
    const grown = new Uint8Array(Math.min(Math.max(end, this.buf.length * 2, 1 << 16), this.size));
    grown.set(this.buf);
    this.buf = grown;
  }
}

/** What the LZ decoder drives: `lzma_lz_decoder`. */
interface LzDecoderCoder {
  code(dict: Dict, input: Uint8Array, inPos: Pos, inSize: number): number;
}

/** The LZ decoder's `lzma_coder`, the last filter of a decoder chain. */
export class LzDecoder implements Coder {
  private readonly dict = new Dict();

  constructor(
    private readonly lz: LzDecoderCoder,
    dictSize: number
  ) {
    const size = Math.ceil(Math.max(dictSize, 4096) / 16) * 16;
    this.dict.size = size + 2 * LZ_DICT_REPEAT_MAX;
    this.reset();
  }

  code(input: Uint8Array, inPos: Pos, inSize: number, out: Uint8Array, outPos: Pos, outSize: number): number {
    const { dict } = this;
    for (;;) {
      if (dict.pos === dict.size) {
        dict.pos = LZ_DICT_REPEAT_MAX;
        dict.hasWrapped = true;
        dict.buf.copyWithin(0, dict.size - LZ_DICT_REPEAT_MAX, dict.size);
      }
      const dictStart = dict.pos;
      dict.limit = dict.pos + Math.min(outSize - outPos.value, dict.size - dict.pos);
      dict.reserve(dict.limit);
      const ret = this.lz.code(dict, input, inPos, inSize);
      const copySize = dict.pos - dictStart;
      out.set(dict.buf.subarray(dictStart, dict.pos), outPos.value);
      outPos.value += copySize;
      if (dict.needReset) {
        this.reset();
        if (ret !== LZMA_OK || outPos.value === outSize) return ret;
      } else if (ret !== LZMA_OK || outPos.value === outSize || dict.pos < dict.size) {
        return ret;
      }
    }
  }

  private reset(): void {
    const { dict } = this;
    dict.pos = LZ_DICT_INIT_POS;
    dict.full = 0;
    dict.reserve(LZ_DICT_INIT_POS);
    dict.buf[LZ_DICT_INIT_POS - 1] = 0;
    dict.hasWrapped = false;
    dict.needReset = false;
  }
}

const SEQ_IS_MATCH = 0;
const SEQ_LITERAL = 1;
const SEQ_LITERAL_MATCHED = 2;
const SEQ_LITERAL_WRITE = 3;
const SEQ_IS_REP = 4;
const SEQ_MATCH_LEN_CHOICE = 5;
const SEQ_DIST_SLOT = 8;
const SEQ_DIST_MODEL = 9;
const SEQ_DIRECT = 10;
const SEQ_ALIGN = 11;
const SEQ_EOPM = 12;
const SEQ_IS_REP0 = 13;
const SEQ_SHORTREP = 14;
const SEQ_IS_REP0_LONG = 15;
const SEQ_IS_REP1 = 16;
const SEQ_IS_REP2 = 17;
const SEQ_REP_LEN_CHOICE = 18;
const SEQ_COPY = 21;

/** The length coder's sequences relative to its choice. */
const LEN_SEQ_CHOICE2 = 1;
const LEN_SEQ_BITTREE = 2;

/** A step of the decoder that leaves the decoding loop, with what `lzma_decode` returns. */
const CONTINUE = -1;
const NEED_INPUT = -1;

/** `lzma_lzma1_decoder`. */
export class Lzma1Decoder implements LzDecoderCoder {
  private readonly probs = new Uint16Array(PROBS_SIZE);
  private range = UINT32_MAX;
  private rcCode = 0;
  private initBytesLeft = 5;
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  private posMask = 0;
  private literalContextBits = 0;
  private literalMask = 0;
  uncompressedSize = VLI_UNKNOWN;
  allowEopm = true;
  private sequence = SEQ_IS_MATCH;
  private probsAt = 0;
  private symbol = 0;
  private limit = 0;
  private offset = 0;
  private len = 0;
  // The locals of one lzma_decode call.
  private dict = new Dict();
  private input = new Uint8Array(0);
  private inPos = 0;
  private inSize = 0;
  private posState = 0;
  private eopmIsValid = false;
  private mightFinishWithoutEopm = false;

  reset(options: LzmaOptions): void {
    this.posMask = (1 << options.pb) - 1;
    resetModel(this.probs, options.lc, options.lp, options.pb);
    this.literalContextBits = options.lc;
    this.literalMask = literalMaskCalc(options.lc, options.lp);
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
    this.rcReset();
    this.sequence = SEQ_IS_MATCH;
    this.probsAt = 0;
    this.symbol = 0;
    this.limit = 0;
    this.offset = 0;
    this.len = 0;
  }

  setUncompressed(uncompressedSize: number, allowEopm: boolean): void {
    this.uncompressedSize = uncompressedSize;
    this.allowEopm = allowEopm;
  }

  code(dict: Dict, input: Uint8Array, inPos: Pos, inSize: number): number {
    while (this.initBytesLeft > 0) {
      if (inPos.value === inSize) return LZMA_OK;
      if (this.initBytesLeft === 5 && input[inPos.value] !== 0) return LZMA_DATA_ERROR;
      this.rcCode = ((this.rcCode << 8) | input[inPos.value++]) >>> 0;
      --this.initBytesLeft;
    }
    Object.assign(this, { dict, input, inPos: inPos.value, inSize });
    const dictStart = dict.pos;
    const savedLimit = dict.limit;
    this.posState = dict.pos & this.posMask;
    this.eopmIsValid = this.uncompressedSize === VLI_UNKNOWN;
    this.mightFinishWithoutEopm = false;
    if (this.uncompressedSize !== VLI_UNKNOWN && this.uncompressedSize <= dict.limit - dict.pos) {
      dict.limit = dict.pos + this.uncompressedSize;
      this.mightFinishWithoutEopm = true;
    }
    let ret = this.run();
    dict.limit = savedLimit;
    inPos.value = this.inPos;
    if (this.uncompressedSize !== VLI_UNKNOWN) {
      this.uncompressedSize -= dict.pos - dictStart;
      if (
        this.uncompressedSize === 0 &&
        ret === LZMA_OK &&
        (this.sequence === SEQ_LITERAL_WRITE || this.sequence === SEQ_SHORTREP || this.sequence === SEQ_COPY)
      ) {
        ret = LZMA_DATA_ERROR;
      }
    }
    if (ret === LZMA_STREAM_END) {
      this.rcReset();
      this.sequence = SEQ_IS_MATCH;
    }
    return ret;
  }

  private rcReset(): void {
    this.range = UINT32_MAX;
    this.rcCode = 0;
    this.initBytesLeft = 5;
  }

  /** The step of each sequence, in the order of their numbers. */
  private readonly steps: readonly (() => number)[] = [
    () => this.isMatch(),
    () => this.literal(),
    () => this.literalMatched(),
    () => this.write(this.symbol, SEQ_LITERAL_WRITE),
    () => this.isRep(),
    () => this.length(SEQ_MATCH_LEN_CHOICE, MATCH_LEN_CODER),
    () => this.length(SEQ_MATCH_LEN_CHOICE, MATCH_LEN_CODER),
    () => this.length(SEQ_MATCH_LEN_CHOICE, MATCH_LEN_CODER),
    () => this.distSlot(),
    () => this.distModel(),
    () => this.direct(),
    () => this.align(),
    () => this.eopm(),
    () => this.isRep0(),
    () => this.write(this.dict.get(this.rep0), SEQ_SHORTREP),
    () => this.isRep0Long(),
    () => this.isRep1(),
    () => this.isRep2(),
    () => this.length(SEQ_REP_LEN_CHOICE, REP_LEN_CODER),
    () => this.length(SEQ_REP_LEN_CHOICE, REP_LEN_CODER),
    () => this.length(SEQ_REP_LEN_CHOICE, REP_LEN_CODER),
    () => this.copy(),
  ];

  /** Runs the decoding loop until it leaves it, with the sequence to resume at stored. */
  private run(): number {
    for (;;) {
      const result = this.steps[this.sequence]();
      if (result !== CONTINUE) return result;
    }
  }

  /** `rc_normalize_safe`: false when it needs input it does not have. */
  private normalize(): boolean {
    if (this.range < RC_TOP_VALUE) {
      if (this.inPos === this.inSize) return false;
      this.range = (this.range << 8) >>> 0;
      this.rcCode = ((this.rcCode << 8) | this.input[this.inPos++]) >>> 0;
    }
    return true;
  }

  /** Decodes one bit with the probability at `index`, or returns `NEED_INPUT`. */
  private bit(index: number): number {
    if (!this.normalize()) return NEED_INPUT;
    const prob = this.probs[index];
    const bound = (this.range >>> 11) * prob;
    if (this.rcCode < bound) {
      this.range = bound;
      this.probs[index] = prob + ((RC_BIT_MODEL_TOTAL - prob) >> RC_MOVE_BITS);
      return 0;
    }
    this.range -= bound;
    this.rcCode -= bound;
    this.probs[index] = prob - (prob >> RC_MOVE_BITS);
    return 1;
  }

  /** Moves to the next symbol: the loop's `continue`. */
  private next(): number {
    this.posState = this.dict.pos & this.posMask;
    this.sequence = SEQ_IS_MATCH;
    return CONTINUE;
  }

  private distanceIsValid(distance: number): boolean {
    return this.dict.full > distance;
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private isMatch(): number {
    const { dict } = this;
    if (this.mightFinishWithoutEopm && dict.pos === dict.limit) {
      if (!this.normalize()) return LZMA_OK;
      if (this.rcCode === 0) return LZMA_STREAM_END;
      if (!this.allowEopm) return LZMA_DATA_ERROR;
      this.eopmIsValid = true;
    }
    const bit = this.bit(IS_MATCH + this.state * POS_STATES_MAX + this.posState);
    if (bit === NEED_INPUT) return LZMA_OK;
    if (bit === 1) {
      this.sequence = SEQ_IS_REP;
      return CONTINUE;
    }
    this.probsAt = literalSubcoder(this.literalContextBits, this.literalMask, dict.pos, dict.buf[dict.pos - 1]);
    this.symbol = 1;
    if (this.state < LIT_STATES) {
      this.state = this.state <= 3 ? 0 : this.state - 3;
      this.sequence = SEQ_LITERAL;
    } else {
      this.state = this.state <= 9 ? this.state - 3 : this.state - 6;
      this.len = dict.get(this.rep0) << 1;
      this.offset = 0x1_00;
      this.sequence = SEQ_LITERAL_MATCHED;
    }
    return CONTINUE;
  }

  private literal(): number {
    do {
      const bit = this.bit(this.probsAt + this.symbol);
      if (bit === NEED_INPUT) return LZMA_OK;
      this.symbol = (this.symbol << 1) + bit;
    } while (this.symbol < 1 << 8);
    this.sequence = SEQ_LITERAL_WRITE;
    return CONTINUE;
  }

  private literalMatched(): number {
    do {
      const matchBit = this.len & this.offset;
      const bit = this.bit(this.probsAt + this.offset + matchBit + this.symbol);
      if (bit === NEED_INPUT) return LZMA_OK;
      this.symbol = (this.symbol << 1) + bit;
      this.offset &= bit === 0 ? ~matchBit : matchBit;
      this.len <<= 1;
    } while (this.symbol < 1 << 8);
    this.sequence = SEQ_LITERAL_WRITE;
    return CONTINUE;
  }

  private write(byte: number, sequence: number): number {
    if (!this.dict.put(byte & 0xff)) {
      this.sequence = sequence;
      return LZMA_OK;
    }
    return this.next();
  }

  private isRep(): number {
    const bit = this.bit(IS_REP + this.state);
    if (bit === NEED_INPUT) return LZMA_OK;
    if (bit === 0) {
      this.state = updateMatch(this.state);
      this.rep3 = this.rep2;
      this.rep2 = this.rep1;
      this.rep1 = this.rep0;
      this.sequence = SEQ_MATCH_LEN_CHOICE;
      return CONTINUE;
    }
    if (!this.distanceIsValid(0)) return LZMA_DATA_ERROR;
    this.sequence = SEQ_IS_REP0;
    return CONTINUE;
  }

  /** `len_decode` of the length coder at `coder`, whose sequences start at `choiceSequence`. */
  // code-gauge-allow functionCognitiveComplexity 17 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private length(choiceSequence: number, coder: number): number {
    if (this.sequence === choiceSequence) {
      const bit = this.bit(coder + LEN_CHOICE);
      if (bit === NEED_INPUT) return LZMA_OK;
      if (bit === 0) this.startLength(coder + LEN_LOW + this.posState * 8, 8, MATCH_LEN_MIN, choiceSequence);
      else this.sequence = choiceSequence + LEN_SEQ_CHOICE2;
    }
    if (this.sequence === choiceSequence + LEN_SEQ_CHOICE2) {
      const bit = this.bit(coder + LEN_CHOICE2);
      if (bit === NEED_INPUT) return LZMA_OK;
      if (bit === 0) this.startLength(coder + LEN_MID + this.posState * 8, 8, MATCH_LEN_MIN + 8, choiceSequence);
      else this.startLength(coder + LEN_HIGH, 256, MATCH_LEN_MIN + 16, choiceSequence);
    }
    do {
      const bit = this.bit(this.probsAt + this.symbol);
      if (bit === NEED_INPUT) return LZMA_OK;
      this.symbol = (this.symbol << 1) + bit;
    } while (this.symbol < this.limit);
    this.len += this.symbol - this.limit;
    if (choiceSequence === SEQ_REP_LEN_CHOICE) {
      this.sequence = SEQ_COPY;
    } else {
      this.probsAt = DIST_SLOT + getDistState(this.len) * 64;
      this.symbol = 1;
      this.sequence = SEQ_DIST_SLOT;
    }
    return CONTINUE;
  }

  private startLength(probsAt: number, limit: number, target: number, choiceSequence: number): void {
    this.probsAt = probsAt;
    this.limit = limit;
    this.len = target;
    this.symbol = 1;
    this.sequence = choiceSequence + LEN_SEQ_BITTREE;
  }

  private distSlot(): number {
    do {
      const bit = this.bit(this.probsAt + this.symbol);
      if (bit === NEED_INPUT) return LZMA_OK;
      this.symbol = (this.symbol << 1) + bit;
    } while (this.symbol < 64);
    this.symbol -= 64;
    const { symbol } = this;
    if (symbol < DIST_MODEL_START) {
      this.rep0 = symbol;
      return this.toCopy();
    }
    this.limit = (symbol >>> 1) - 1;
    this.rep0 = 2 + (symbol & 1);
    if (symbol < DIST_MODEL_END) {
      this.rep0 <<= this.limit;
      this.probsAt = DIST_SPECIAL + this.rep0 - symbol - 1;
      this.symbol = 1;
      this.offset = 0;
      this.sequence = SEQ_DIST_MODEL;
    } else {
      this.limit -= 4;
      this.sequence = SEQ_DIRECT;
    }
    return CONTINUE;
  }

  private distModel(): number {
    do {
      const bit = this.bit(this.probsAt + this.symbol);
      if (bit === NEED_INPUT) return LZMA_OK;
      this.symbol = (this.symbol << 1) + bit;
      if (bit === 1) this.rep0 = (this.rep0 + 2 ** this.offset) >>> 0;
    } while (++this.offset < this.limit);
    return this.toCopy();
  }

  private direct(): number {
    do {
      if (!this.normalize()) return LZMA_OK;
      this.range >>>= 1;
      this.rcCode = (this.rcCode - this.range) >>> 0;
      const negative = this.rcCode >>> 31;
      if (negative) this.rcCode = (this.rcCode + this.range) >>> 0;
      this.rep0 = ((this.rep0 << 1) + 1 - negative) >>> 0;
    } while (--this.limit > 0);
    this.rep0 = (this.rep0 << 4) >>> 0;
    this.symbol = 0;
    this.offset = 1;
    this.sequence = SEQ_ALIGN;
    return CONTINUE;
  }

  private align(): number {
    do {
      const bit = this.bit(DIST_ALIGN + this.offset + this.symbol);
      if (bit === NEED_INPUT) return LZMA_OK;
      if (bit === 1) this.symbol += this.offset;
      this.offset <<= 1;
    } while (this.offset < 16);
    this.rep0 = (this.rep0 + this.symbol) >>> 0;
    if (this.rep0 !== UINT32_MAX) return this.toCopy();
    if (!this.eopmIsValid) return LZMA_DATA_ERROR;
    this.sequence = SEQ_EOPM;
    return CONTINUE;
  }

  private eopm(): number {
    if (!this.normalize()) return LZMA_OK;
    return this.rcCode === 0 ? LZMA_STREAM_END : LZMA_DATA_ERROR;
  }

  private toCopy(): number {
    if (!this.distanceIsValid(this.rep0)) return LZMA_DATA_ERROR;
    this.sequence = SEQ_COPY;
    return CONTINUE;
  }

  private isRep0(): number {
    const bit = this.bit(IS_REP0 + this.state);
    if (bit === NEED_INPUT) return LZMA_OK;
    this.sequence = bit === 0 ? SEQ_IS_REP0_LONG : SEQ_IS_REP1;
    return CONTINUE;
  }

  private isRep0Long(): number {
    const bit = this.bit(IS_REP0_LONG + this.state * POS_STATES_MAX + this.posState);
    if (bit === NEED_INPUT) return LZMA_OK;
    if (bit === 0) {
      this.state = updateShortRep(this.state);
      this.sequence = SEQ_SHORTREP;
      return CONTINUE;
    }
    return this.toRepLength();
  }

  private isRep1(): number {
    const bit = this.bit(IS_REP1 + this.state);
    if (bit === NEED_INPUT) return LZMA_OK;
    if (bit === 1) {
      this.sequence = SEQ_IS_REP2;
      return CONTINUE;
    }
    [this.rep0, this.rep1] = [this.rep1, this.rep0];
    return this.toRepLength();
  }

  private isRep2(): number {
    const bit = this.bit(IS_REP2 + this.state);
    if (bit === NEED_INPUT) return LZMA_OK;
    let distance: number;
    if (bit === 0) {
      distance = this.rep2;
    } else {
      distance = this.rep3;
      this.rep3 = this.rep2;
    }
    this.rep2 = this.rep1;
    this.rep1 = this.rep0;
    this.rep0 = distance;
    return this.toRepLength();
  }

  private toRepLength(): number {
    this.state = updateLongRep(this.state);
    this.sequence = SEQ_REP_LEN_CHOICE;
    return CONTINUE;
  }

  private copy(): number {
    this.len = this.dict.repeat(this.rep0, this.len);
    if (this.len !== 0) {
      this.sequence = SEQ_COPY;
      return LZMA_OK;
    }
    return this.next();
  }
}

/** `lzma_decoder_init`: LZMA1, whose size is unknown unless it is LZMA1EXT. */
export function lzma1DecoderInit(
  id: bigint,
  options: LzmaOptions,
  uncompressedSize = VLI_UNKNOWN
): { ret: number; coder?: Coder } {
  if (!isLcLpPbValid(options)) return { ret: LZMA_PROG_ERROR };
  const decoder = new Lzma1Decoder();
  decoder.reset(options);
  const known = id === LZMA_FILTER_LZMA1EXT ? uncompressedSize : VLI_UNKNOWN;
  decoder.setUncompressed(known, true);
  return { ret: LZMA_OK, coder: new LzDecoder(decoder, options.dictSize) };
}

const L2_CONTROL = 0;
const L2_UNCOMPRESSED_1 = 1;
const L2_UNCOMPRESSED_2 = 2;
const L2_COMPRESSED_0 = 3;
const L2_COMPRESSED_1 = 4;
const L2_PROPERTIES = 5;
const L2_LZMA = 6;
const L2_COPY = 7;

/** `lzma_lzma2_coder` of the decoder. */
class Lzma2Decoder implements LzDecoderCoder {
  private sequence = L2_CONTROL;
  private nextSequence = L2_CONTROL;
  private readonly lzma = new Lzma1Decoder();
  private uncompressedSize = 0;
  private readonly compressedSize: Pos = { value: 0 };
  private needProperties = true;
  private needDictionaryReset = true;
  private readonly options: LzmaOptions;

  constructor(options: LzmaOptions) {
    this.options = { ...options };
  }

  // code-gauge-allow functionNcss 51 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 22 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  code(dict: Dict, input: Uint8Array, inPos: Pos, inSize: number): number {
    while (inPos.value < inSize || this.sequence === L2_LZMA) {
      switch (this.sequence) {
        case L2_CONTROL: {
          const result = this.control(dict, input[inPos.value++]);
          if (result !== CONTINUE) return result;
          break;
        }
        case L2_UNCOMPRESSED_1: {
          this.uncompressedSize += input[inPos.value++] << 8;
          this.sequence = L2_UNCOMPRESSED_2;
          break;
        }
        case L2_UNCOMPRESSED_2: {
          this.uncompressedSize += input[inPos.value++] + 1;
          this.sequence = L2_COMPRESSED_0;
          this.lzma.setUncompressed(this.uncompressedSize, false);
          break;
        }
        case L2_COMPRESSED_0: {
          this.compressedSize.value = input[inPos.value++] << 8;
          this.sequence = L2_COMPRESSED_1;
          break;
        }
        case L2_COMPRESSED_1: {
          this.compressedSize.value += input[inPos.value++] + 1;
          this.sequence = this.nextSequence;
          break;
        }
        case L2_PROPERTIES: {
          if (lclppbDecode(this.options, input[inPos.value++])) return LZMA_DATA_ERROR;
          this.lzma.reset(this.options);
          this.sequence = L2_LZMA;
          break;
        }
        case L2_LZMA: {
          const inStart = inPos.value;
          const inLimit = inPos.value + Math.min(inSize - inPos.value, this.compressedSize.value + 1);
          const ret = this.lzma.code(dict, input, inPos, inLimit);
          const inUsed = inPos.value - inStart;
          if (inUsed > this.compressedSize.value) return LZMA_DATA_ERROR;
          this.compressedSize.value -= inUsed;
          if (ret !== LZMA_STREAM_END) return ret;
          if (this.compressedSize.value !== 0) return LZMA_DATA_ERROR;
          this.sequence = L2_CONTROL;
          break;
        }
        default: {
          dict.write(input, inPos, inSize, this.compressedSize);
          if (this.compressedSize.value !== 0) return LZMA_OK;
          this.sequence = L2_CONTROL;
        }
      }
    }
    return LZMA_OK;
  }

  // code-gauge-allow functionNcss 32 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 16 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  private control(dict: Dict, control: number): number {
    if (control === 0) return LZMA_STREAM_END;
    if (control >= 0xe0 || control === 1) {
      this.needProperties = true;
      this.needDictionaryReset = true;
    } else if (this.needDictionaryReset) {
      return LZMA_DATA_ERROR;
    }
    if (control >= 0x80) {
      this.uncompressedSize = (control & 0x1f) << 16;
      this.sequence = L2_UNCOMPRESSED_1;
      if (control >= 0xc0) {
        this.needProperties = false;
        this.nextSequence = L2_PROPERTIES;
      } else if (this.needProperties) {
        return LZMA_DATA_ERROR;
      } else {
        this.nextSequence = L2_LZMA;
        if (control >= 0xa0) this.lzma.reset(this.options);
      }
    } else {
      if (control > 2) return LZMA_DATA_ERROR;
      this.sequence = L2_COMPRESSED_0;
      this.nextSequence = L2_COPY;
    }
    if (this.needDictionaryReset) {
      this.needDictionaryReset = false;
      dict.needReset = true;
      return LZMA_OK;
    }
    return CONTINUE;
  }
}

export function lzma2DecoderInit(options: LzmaOptions): {
  ret: number;
  coder?: Coder;
} {
  return {
    ret: LZMA_OK,
    coder: new LzDecoder(new Lzma2Decoder(options), options.dictSize),
  };
}

/** `lzma_lzma_decoder_memusage_nocheck` on the reference's 64-bit arm build. */
export const lzmaDecoderMemusage = (dictSize: number): number => 28_352 + 4288 + dictSize + 2 * LZ_DICT_REPEAT_MAX;
/** `lzma_lzma2_decoder_memusage`. */
export const lzma2DecoderMemusage = (dictSize: number): number => 184 + lzmaDecoderMemusage(dictSize);
