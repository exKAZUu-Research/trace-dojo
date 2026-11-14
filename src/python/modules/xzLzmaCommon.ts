// What the LZMA encoder and decoder of liblzma 5.8.4 share (`lzma_common.h`, `range_common.h`, `price.h`,
// `fastpos.h`), with every probability of a coder at a fixed offset in one array.

export const STATES = 12;
export const LIT_STATES = 7;
export const POS_STATES_MAX = 16;
export const MATCH_LEN_MIN = 2;
export const LEN_LOW_SYMBOLS = 8;
export const LEN_MID_SYMBOLS = 8;
export const LEN_HIGH_SYMBOLS = 256;
export const LEN_SYMBOLS = LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS + LEN_HIGH_SYMBOLS;
export const MATCH_LEN_MAX = MATCH_LEN_MIN + LEN_SYMBOLS - 1;
export const DIST_STATES = 4;
export const DIST_SLOTS = 64;
export const DIST_MODEL_START = 4;
export const DIST_MODEL_END = 14;
export const FULL_DISTANCES = 128;
export const ALIGN_BITS = 4;
export const ALIGN_SIZE = 16;
export const ALIGN_MASK = 15;
export const REPS = 4;

export const RC_TOP_VALUE = 1 << 24;
export const RC_BIT_MODEL_TOTAL = 1 << 11;
export const RC_MOVE_BITS = 5;
export const RC_INFINITY_PRICE = 1 << 30;
export const PROB_INIT = RC_BIT_MODEL_TOTAL >> 1;

export const LITERAL_CODER_SIZE = 0x3_00;
export const LITERAL = 0;
export const IS_MATCH = LITERAL + (LITERAL_CODER_SIZE << 4);
export const IS_REP = IS_MATCH + STATES * POS_STATES_MAX;
export const IS_REP0 = IS_REP + STATES;
export const IS_REP1 = IS_REP0 + STATES;
export const IS_REP2 = IS_REP1 + STATES;
export const IS_REP0_LONG = IS_REP2 + STATES;
export const DIST_SLOT = IS_REP0_LONG + STATES * POS_STATES_MAX;
export const DIST_SPECIAL = DIST_SLOT + DIST_STATES * DIST_SLOTS;
export const DIST_ALIGN = DIST_SPECIAL + FULL_DISTANCES - DIST_MODEL_END;
/** A length coder: its choice, choice2, low[16][8], mid[16][8] and high[256] probabilities. */
export const LEN_CHOICE = 0;
export const LEN_CHOICE2 = 1;
export const LEN_LOW = 2;
export const LEN_MID = LEN_LOW + POS_STATES_MAX * LEN_LOW_SYMBOLS;
export const LEN_HIGH = LEN_MID + POS_STATES_MAX * LEN_MID_SYMBOLS;
const LEN_CODER_SIZE = LEN_HIGH + LEN_HIGH_SYMBOLS;
export const MATCH_LEN_CODER = DIST_ALIGN + ALIGN_SIZE;
export const REP_LEN_CODER = MATCH_LEN_CODER + LEN_CODER_SIZE;
export const PROBS_SIZE = REP_LEN_CODER + LEN_CODER_SIZE;

export const updateLiteral = (state: number): number => (state <= 3 ? 0 : state <= 9 ? state - 3 : state - 6);
export const updateMatch = (state: number): number => (state < LIT_STATES ? 7 : 10);
export const updateLongRep = (state: number): number => (state < LIT_STATES ? 8 : 11);
export const updateShortRep = (state: number): number => (state < LIT_STATES ? 9 : 11);
export const getDistState = (len: number): number => (len < DIST_STATES + MATCH_LEN_MIN ? len - MATCH_LEN_MIN : 3);
export const literalMaskCalc = (lc: number, lp: number): number => (0x1_00 << lp) - (0x1_00 >> lc);

/** The offset of the literal coder for `pos` and the previous byte, as `literal_subcoder` computes it. */
export const literalSubcoder = (lc: number, literalMask: number, pos: number, prevByte: number): number =>
  LITERAL + 3 * ((((pos << 8) + prevByte) & literalMask) << lc);

/** `get_dist_slot`, as the small build computes it rather than through `lzma_fastpos`, to the same result. */
export function getDistSlot(dist: number): number {
  if (dist <= 4) return dist;
  const i = 31 - Math.clz32(dist);
  return i + i + ((dist >>> (i - 1)) & 1);
}

/** Resets the probabilities of `count` symbols at `offset`. */
export function resetProbs(probs: Uint16Array, offset: number, count: number): void {
  probs.fill(PROB_INIT, offset, offset + count);
}

/** Resets the literal coders and the rest of the model of `lc`, `lp` and `pb`. */
export function resetModel(probs: Uint16Array, lc: number, lp: number, pb: number): void {
  resetProbs(probs, LITERAL, LITERAL_CODER_SIZE << (lc + lp));
  const posStates = 1 << pb;
  for (let state = 0; state < STATES; state++) {
    resetProbs(probs, IS_MATCH + state * POS_STATES_MAX, posStates);
    resetProbs(probs, IS_REP0_LONG + state * POS_STATES_MAX, posStates);
  }
  resetProbs(probs, IS_REP, 4 * STATES);
  resetProbs(probs, DIST_SLOT, DIST_STATES * DIST_SLOTS);
  resetProbs(probs, DIST_SPECIAL, FULL_DISTANCES - DIST_MODEL_END + ALIGN_SIZE);
  for (const coder of [MATCH_LEN_CODER, REP_LEN_CODER]) {
    resetProbs(probs, coder + LEN_CHOICE, 2);
    for (let posState = 0; posState < posStates; posState++) {
      resetProbs(probs, coder + LEN_LOW + posState * LEN_LOW_SYMBOLS, LEN_LOW_SYMBOLS);
      resetProbs(probs, coder + LEN_MID + posState * LEN_MID_SYMBOLS, LEN_MID_SYMBOLS);
    }
    resetProbs(probs, coder + LEN_HIGH, LEN_HIGH_SYMBOLS);
  }
}

/** `lzma_rc_prices`, as `price_tablegen.c` generates it. */
const RC_PRICES = new Uint8Array(RC_BIT_MODEL_TOTAL >> 4);
for (let i = 8; i < RC_BIT_MODEL_TOTAL; i += 16) {
  let w = i;
  let bitCount = 0;
  for (let j = 0; j < 4; j++) {
    w *= w;
    bitCount <<= 1;
    while (w >= 1 << 16) {
      w >>>= 1;
      ++bitCount;
    }
  }
  RC_PRICES[i >> 4] = (11 << 4) - 15 - bitCount;
}

export const bitPrice = (prob: number, bit: number): number => RC_PRICES[(prob ^ (-bit & 0x7_ff)) >> 4];
export const bit0Price = (prob: number): number => RC_PRICES[prob >> 4];
export const bit1Price = (prob: number): number => RC_PRICES[(prob ^ 0x7_ff) >> 4];

export function bittreePrice(probs: Uint16Array, offset: number, bitLevels: number, symbol: number): number {
  let price = 0;
  let value = symbol + (1 << bitLevels);
  do {
    const bit = value & 1;
    value >>>= 1;
    price += bitPrice(probs[offset + value], bit);
  } while (value !== 1);
  return price;
}

export function bittreeReversePrice(probs: Uint16Array, offset: number, bitLevels: number, symbol: number): number {
  let price = 0;
  let modelIndex = 1;
  let value = symbol;
  let levels = bitLevels;
  do {
    const bit = value & 1;
    value >>>= 1;
    price += bitPrice(probs[offset + modelIndex], bit);
    modelIndex = (modelIndex << 1) + bit;
  } while (--levels !== 0);
  return price;
}
