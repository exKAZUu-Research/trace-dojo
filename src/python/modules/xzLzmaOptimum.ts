// code-gauge-allow-file fileNcss 448 -- Transcribes liblzma 5.8.4 C sources together, which read best side by side with them.
// How the LZMA encoder of liblzma 5.8.4 chooses its symbols: `lzma_encoder_optimum_fast.c` and
// `lzma_encoder_optimum_normal.c`. Both leave their choice in the encoder's `backRes` and `lenRes`.
import { UINT32_MAX } from './xzCommon';
import type { MatchFinder } from './xzLzEncoder';
import {
  ALIGN_MASK,
  ALIGN_SIZE,
  bit0Price,
  bit1Price,
  bitPrice,
  bittreePrice,
  bittreeReversePrice,
  DIST_ALIGN,
  DIST_MODEL_END,
  DIST_MODEL_START,
  DIST_SLOT,
  DIST_SPECIAL,
  DIST_STATES,
  FULL_DISTANCES,
  getDistSlot,
  getDistState,
  IS_MATCH,
  IS_REP,
  IS_REP0,
  IS_REP0_LONG,
  IS_REP1,
  IS_REP2,
  LIT_STATES,
  literalSubcoder,
  MATCH_LEN_MAX,
  POS_STATES_MAX,
  RC_INFINITY_PRICE,
  REPS,
  updateLiteral,
  updateLongRep,
  updateMatch,
  updateShortRep,
} from './xzLzmaCommon';
import { type LzmaEncoder, OPTS } from './xzLzmaEncoder';

function memcmplen(buf: Uint8Array, a: number, b: number, start: number, limit: number): number {
  let len = start;
  while (len < limit && buf[a + len] === buf[b + len]) len++;
  return len;
}

const notEqual16 = (buf: Uint8Array, a: number, b: number): boolean => buf[a] !== buf[b] || buf[a + 1] !== buf[b + 1];
const changePair = (smallDist: number, bigDist: number): boolean => bigDist >>> 7 > smallDist;

function choose(coder: LzmaEncoder, back: number, len: number): void {
  coder.backRes = back;
  coder.lenRes = len;
}

// The fast mode ------------------------------------------------------------------------------------------------------

/** The longest match at the position, and how many matches there are: the first part of both modes. */
function currentMatches(coder: LzmaEncoder, mf: MatchFinder): { lenMain: number; matchesCount: number } {
  if (mf.readAhead !== 0)
    return {
      lenMain: coder.longestMatchLength,
      matchesCount: coder.matchesCount,
    };
  const lenMain = mf.find();
  return { lenMain, matchesCount: mf.matchesCount };
}

/** `lzma_lzma_optimum_fast`. */
export function optimumFast(coder: LzmaEncoder, mf: MatchFinder): void {
  const { lenMain: longest, matchesCount } = currentMatches(coder, mf);
  const bufAvail = Math.min(mf.avail + 1, MATCH_LEN_MAX);
  if (bufAvail < 2) return choose(coder, UINT32_MAX, 1);
  const rep = fastRep(coder, mf, bufAvail);
  if (rep === undefined) return;
  if (longest >= mf.niceLen) {
    choose(coder, mf.matchDists[matchesCount - 1] + REPS, longest);
    return mf.skipAhead(longest - 1);
  }
  const { len, back } = shortenMain(mf, longest, matchesCount);
  if (
    rep.len >= 2 &&
    (rep.len + 1 >= len || (rep.len + 2 >= len && back > 1 << 9) || (rep.len + 3 >= len && back > 1 << 15))
  ) {
    choose(coder, rep.index, rep.len);
    return mf.skipAhead(rep.len - 1);
  }
  if (len < 2 || bufAvail <= 2 || nextIsBetter(coder, mf, len, back)) return choose(coder, UINT32_MAX, 1);
  const buf = mf.readPos - 1;
  const limit = Math.max(2, len - 1);
  for (let i = 0; i < REPS; ++i) {
    if (memcmplen(mf.buffer, buf, buf - coder.reps[i] - 1, 0, limit) === limit) return choose(coder, UINT32_MAX, 1);
  }
  choose(coder, back + REPS, len);
  mf.skipAhead(len - 2);
}

/** The longest repeated match, or undefined when one reaching the nice length has been chosen. */
function fastRep(coder: LzmaEncoder, mf: MatchFinder, bufAvail: number): { len: number; index: number } | undefined {
  const { buffer } = mf;
  const buf = mf.readPos - 1;
  const rep = { len: 0, index: 0 };
  for (let i = 0; i < REPS; ++i) {
    const bufBack = buf - coder.reps[i] - 1;
    if (notEqual16(buffer, buf, bufBack)) continue;
    const len = memcmplen(buffer, buf, bufBack, 2, bufAvail);
    if (len >= mf.niceLen) {
      choose(coder, i, len);
      mf.skipAhead(len - 1);
      return undefined;
    }
    if (len > rep.len) {
      rep.index = i;
      rep.len = len;
    }
  }
  return rep;
}

/** The main match of the fast mode: a shorter one when it is much nearer, and none for a far match of 2. */
function shortenMain(mf: MatchFinder, longest: number, count: number): { len: number; back: number } {
  if (longest < 2) return { len: longest, back: 0 };
  const { matchLens, matchDists } = mf;
  let matchesCount = count;
  let len = longest;
  let back = matchDists[matchesCount - 1];
  while (matchesCount > 1 && len === matchLens[matchesCount - 2] + 1) {
    if (!changePair(matchDists[matchesCount - 2], back)) break;
    --matchesCount;
    len = matchLens[matchesCount - 1];
    back = matchDists[matchesCount - 1];
  }
  return { len: len === 2 && back >= 0x80 ? 1 : len, back };
}

/** Finds the matches at the next position, and whether one of them beats the main match. */
function nextIsBetter(coder: LzmaEncoder, mf: MatchFinder, lenMain: number, backMain: number): boolean {
  coder.longestMatchLength = mf.find();
  coder.matchesCount = mf.matchesCount;
  const longest = coder.longestMatchLength;
  if (longest < 2) return false;
  const newDist = mf.matchDists[coder.matchesCount - 1];
  return (
    (longest >= lenMain && newDist < backMain) ||
    (longest === lenMain + 1 && !changePair(backMain, newDist)) ||
    longest > lenMain + 1 ||
    (longest + 1 >= lenMain && lenMain >= 3 && changePair(newDist, backMain))
  );
}

// The normal mode: prices --------------------------------------------------------------------------------------------

function getLiteralPrice(
  coder: LzmaEncoder,
  pos: number,
  prevByte: number,
  matchMode: boolean,
  matchByteStart: number,
  symbolStart: number
): number {
  const { probs } = coder;
  const subcoder = literalSubcoder(coder.literalContextBits, coder.literalMask, pos, prevByte);
  if (!matchMode) return bittreePrice(probs, subcoder, 8, symbolStart);
  let price = 0;
  let offset = 0x1_00;
  let symbol = symbolStart + 0x1_00;
  let matchByte = matchByteStart;
  do {
    matchByte <<= 1;
    const matchBit = matchByte & offset;
    const subcoderIndex = offset + matchBit + (symbol >>> 8);
    price += bitPrice(probs[subcoder + subcoderIndex], (symbol >>> 7) & 1);
    symbol <<= 1;
    offset &= ~(matchByte ^ symbol);
  } while (symbol < 1 << 16);
  return price;
}

const getShortRepPrice = (coder: LzmaEncoder, state: number, posState: number): number =>
  bit0Price(coder.probs[IS_REP0 + state]) + bit0Price(coder.probs[IS_REP0_LONG + state * POS_STATES_MAX + posState]);

function getPureRepPrice(coder: LzmaEncoder, repIndex: number, state: number, posState: number): number {
  const { probs } = coder;
  if (repIndex === 0) {
    return bit0Price(probs[IS_REP0 + state]) + bit1Price(probs[IS_REP0_LONG + state * POS_STATES_MAX + posState]);
  }
  let price = bit1Price(probs[IS_REP0 + state]);
  if (repIndex === 1) {
    price += bit0Price(probs[IS_REP1 + state]);
  } else {
    price += bit1Price(probs[IS_REP1 + state]);
    price += bitPrice(probs[IS_REP2 + state], repIndex - 2);
  }
  return price;
}

const getRepPrice = (coder: LzmaEncoder, repIndex: number, len: number, state: number, posState: number): number =>
  coder.repLenEncoder.price(len, posState) + getPureRepPrice(coder, repIndex, state, posState);

function getDistLenPrice(coder: LzmaEncoder, dist: number, len: number, posState: number): number {
  const distState = getDistState(len);
  const price =
    dist < FULL_DISTANCES
      ? coder.distPrices[distState * FULL_DISTANCES + dist]
      : coder.distSlotPrices[distState * 64 + getDistSlot(dist)] + coder.alignPrices[dist & ALIGN_MASK];
  return price + coder.matchLenEncoder.price(len, posState);
}

function fillDistPrices(coder: LzmaEncoder): void {
  const { probs, distSlotPrices, distPrices } = coder;
  for (let distState = 0; distState < DIST_STATES; ++distState) {
    const at = distState * 64;
    for (let distSlot = 0; distSlot < coder.distTableSize; ++distSlot) {
      distSlotPrices[at + distSlot] = bittreePrice(probs, DIST_SLOT + at, 6, distSlot);
    }
    for (let distSlot = DIST_MODEL_END; distSlot < coder.distTableSize; ++distSlot) {
      distSlotPrices[at + distSlot] += ((distSlot >>> 1) - 1 - 4) << 4;
    }
    for (let i = 0; i < DIST_MODEL_START; ++i) distPrices[distState * FULL_DISTANCES + i] = distSlotPrices[at + i];
  }
  for (let i = DIST_MODEL_START; i < FULL_DISTANCES; ++i) {
    const distSlot = getDistSlot(i);
    const footerBits = (distSlot >>> 1) - 1;
    const base = (2 | (distSlot & 1)) << footerBits;
    const price = bittreeReversePrice(probs, DIST_SPECIAL + base - distSlot - 1, footerBits, i - base);
    for (let distState = 0; distState < DIST_STATES; ++distState) {
      distPrices[distState * FULL_DISTANCES + i] = price + distSlotPrices[distState * 64 + distSlot];
    }
  }
  coder.matchPriceCount = 0;
}

function fillAlignPrices(coder: LzmaEncoder): void {
  for (let i = 0; i < ALIGN_SIZE; ++i) coder.alignPrices[i] = bittreeReversePrice(coder.probs, DIST_ALIGN, 4, i);
  coder.alignPriceCount = 0;
}

// The normal mode: the search ----------------------------------------------------------------------------------------

/** Sets `opts[index]` to a choice of `back` reached from `posPrev`, as the many `opts[...] = ...` blocks do. */
function setOpt(coder: LzmaEncoder, index: number, price: number, posPrev: number, back: number): void {
  coder.optPrice[index] = price;
  coder.optPosPrev[index] = posPrev;
  coder.optBackPrev[index] = back;
  coder.optPrev1IsLiteral[index] = 0;
}

function backward(coder: LzmaEncoder, start: number): void {
  let cur = start;
  coder.optsEndIndex = cur;
  let posMem = coder.optPosPrev[cur];
  let backMem = coder.optBackPrev[cur];
  do {
    if (coder.optPrev1IsLiteral[cur]) {
      coder.optBackPrev[posMem] = UINT32_MAX;
      coder.optPrev1IsLiteral[posMem] = 0;
      coder.optPosPrev[posMem] = posMem - 1;
      if (coder.optPrev2[cur]) {
        coder.optPrev1IsLiteral[posMem - 1] = 0;
        coder.optPosPrev[posMem - 1] = coder.optPosPrev2[cur];
        coder.optBackPrev[posMem - 1] = coder.optBackPrev2[cur];
      }
    }
    const posPrev = posMem;
    const backCur = backMem;
    backMem = coder.optBackPrev[posPrev];
    posMem = coder.optPosPrev[posPrev];
    coder.optBackPrev[posPrev] = backCur;
    coder.optPosPrev[posPrev] = cur;
    cur = posPrev;
  } while (cur !== 0);
  coder.optsCurrentIndex = coder.optPosPrev[0];
  choose(coder, coder.optBackPrev[0], coder.optPosPrev[0]);
}

/** `helper1`: the prices of the first symbols, or `UINT32_MAX` once the choice is made. */
// code-gauge-allow functionNcss 42 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
function helper1(coder: LzmaEncoder, mf: MatchFinder, position: number): number {
  const { lenMain, matchesCount } = currentMatches(coder, mf);
  const bufAvail = Math.min(mf.avail + 1, MATCH_LEN_MAX);
  if (bufAvail < 2) return chooseLiteral(coder);
  const { buffer } = mf;
  const buf = mf.readPos - 1;
  const repLens = [0, 0, 0, 0];
  let repMaxIndex = 0;
  for (let i = 0; i < REPS; ++i) {
    const bufBack = buf - coder.reps[i] - 1;
    if (notEqual16(buffer, buf, bufBack)) continue;
    repLens[i] = memcmplen(buffer, buf, bufBack, 2, bufAvail);
    if (repLens[i] > repLens[repMaxIndex]) repMaxIndex = i;
  }
  const repMax = repLens[repMaxIndex];
  if (repMax >= mf.niceLen) {
    choose(coder, repMaxIndex, repMax);
    mf.skipAhead(repMax - 1);
    return UINT32_MAX;
  }
  if (lenMain >= mf.niceLen) {
    choose(coder, mf.matchDists[matchesCount - 1] + REPS, lenMain);
    mf.skipAhead(lenMain - 1);
    return UINT32_MAX;
  }
  const matchByte = buffer[buf - coder.reps[0] - 1];
  if (lenMain < 2 && buffer[buf] !== matchByte && repMax < 2) return chooseLiteral(coder);
  const posState = position & coder.posMask;
  const matchPrice = priceFirstByte(coder, mf, position, posState);
  const lenEnd = Math.max(lenMain, repMax);
  if (lenEnd < 2) {
    choose(coder, coder.optBackPrev[1], 1);
    return UINT32_MAX;
  }
  coder.optPosPrev[1] = 0;
  for (let i = 0; i < REPS; ++i) coder.optBacks[i] = coder.reps[i];
  for (let len = lenEnd; len >= 2; len--) coder.optPrice[len] = RC_INFINITY_PRICE;
  priceFirstReps(coder, repLens, matchPrice, posState);
  priceFirstMatches(coder, mf, repLens[0] >= 2 ? repLens[0] + 1 : 2, lenMain, matchesCount, matchPrice, posState);
  return lenEnd;
}

function chooseLiteral(coder: LzmaEncoder): number {
  choose(coder, UINT32_MAX, 1);
  return UINT32_MAX;
}

/** Prices a literal and a short rep as `opts[1]`, and returns the price of a match's first bit. */
function priceFirstByte(coder: LzmaEncoder, mf: MatchFinder, position: number, posState: number): number {
  const { probs, state } = coder;
  const { buffer } = mf;
  const buf = mf.readPos - 1;
  const currentByte = buffer[buf];
  const matchByte = buffer[buf - coder.reps[0] - 1];
  coder.optState[0] = state;
  const isMatch = probs[IS_MATCH + state * POS_STATES_MAX + posState];
  coder.optPrice[1] =
    bit0Price(isMatch) + getLiteralPrice(coder, position, buffer[buf - 1], state >= LIT_STATES, matchByte, currentByte);
  coder.optBackPrev[1] = UINT32_MAX;
  coder.optPrev1IsLiteral[1] = 0;
  const matchPrice = bit1Price(isMatch);
  if (matchByte === currentByte) {
    const shortRepPrice = matchPrice + bit1Price(probs[IS_REP + state]) + getShortRepPrice(coder, state, posState);
    if (shortRepPrice < coder.optPrice[1]) {
      coder.optPrice[1] = shortRepPrice;
      coder.optBackPrev[1] = 0;
      coder.optPrev1IsLiteral[1] = 0;
    }
  }
  return matchPrice;
}

function priceFirstReps(coder: LzmaEncoder, repLens: readonly number[], matchPrice: number, posState: number): void {
  const { state } = coder;
  const repMatchPrice = matchPrice + bit1Price(coder.probs[IS_REP + state]);
  for (let i = 0; i < REPS; ++i) {
    let repLen = repLens[i];
    if (repLen < 2) continue;
    const price = repMatchPrice + getPureRepPrice(coder, i, state, posState);
    do {
      const curAndLenPrice = price + coder.repLenEncoder.price(repLen, posState);
      if (curAndLenPrice < coder.optPrice[repLen]) setOpt(coder, repLen, curAndLenPrice, 0, i);
    } while (--repLen >= 2);
  }
}

// code-gauge-allow functionParameterCount 7 -- Takes the locals of the optimum_normal helper it continues.
function priceFirstMatches(
  coder: LzmaEncoder,
  mf: MatchFinder,
  startLen: number,
  lenMain: number,
  matchesCount: number,
  matchPrice: number,
  posState: number
): void {
  const { matchLens, matchDists } = mf;
  const normalMatchPrice = matchPrice + bit0Price(coder.probs[IS_REP + coder.state]);
  let len = startLen;
  if (len > lenMain) return;
  let i = 0;
  while (len > matchLens[i]) ++i;
  for (; ; ++len) {
    const dist = matchDists[i];
    const curAndLenPrice = normalMatchPrice + getDistLenPrice(coder, dist, len, posState);
    if (curAndLenPrice < coder.optPrice[len]) setOpt(coder, len, curAndLenPrice, 0, dist + REPS);
    if (len === matchLens[i] && ++i === matchesCount) break;
  }
}

/** The state and reps at `cur` that helper2 derives from the path to it. */
// code-gauge-allow functionNcss 37 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
function stateAt(coder: LzmaEncoder, reps: Uint32Array, cur: number): number {
  let posPrev = coder.optPosPrev[cur];
  let state: number;
  const prev1IsLiteral = coder.optPrev1IsLiteral[cur] !== 0;
  if (prev1IsLiteral) {
    --posPrev;
    if (coder.optPrev2[cur]) {
      state = coder.optState[coder.optPosPrev2[cur]];
      state = coder.optBackPrev2[cur] < REPS ? updateLongRep(state) : updateMatch(state);
    } else {
      state = coder.optState[posPrev];
    }
    state = updateLiteral(state);
  } else {
    state = coder.optState[posPrev];
  }
  if (posPrev === cur - 1) {
    return coder.optBackPrev[cur] === 0 ? updateShortRep(state) : updateLiteral(state);
  }
  let pos: number;
  if (prev1IsLiteral && coder.optPrev2[cur]) {
    posPrev = coder.optPosPrev2[cur];
    pos = coder.optBackPrev2[cur];
    state = updateLongRep(state);
  } else {
    pos = coder.optBackPrev[cur];
    state = pos < REPS ? updateLongRep(state) : updateMatch(state);
  }
  const backs = posPrev * REPS;
  if (pos < REPS) {
    reps[0] = coder.optBacks[backs + pos];
    let i: number;
    for (i = 1; i <= pos; ++i) reps[i] = coder.optBacks[backs + i - 1];
    for (; i < REPS; ++i) reps[i] = coder.optBacks[backs + i];
  } else {
    reps[0] = pos - REPS;
    for (let i = 1; i < REPS; ++i) reps[i] = coder.optBacks[backs + i - 1];
  }
  return state;
}

/** The arguments of helper2 that stay the same while it runs. */
interface Step {
  buffer: Uint8Array;
  buf: number;
  position: number;
  cur: number;
  niceLen: number;
  bufAvailFull: number;
  state: number;
  posState: number;
}

function extendEnd(coder: LzmaEncoder, lenEnd: number, offset: number): number {
  let end = lenEnd;
  while (end < offset) coder.optPrice[++end] = RC_INFINITY_PRICE;
  return end;
}

/** Prices a literal at `cur + lenTest`, then a rep0 match, after a match of `lenTest`; the `len_test_2` blocks. */
// code-gauge-allow functionParameterCount 8 -- Takes the locals of the optimum_normal helper it continues.
function tryLiteralThenRep0(
  coder: LzmaEncoder,
  step: Step,
  lenEndStart: number,
  bufBack: number,
  lenTest: number,
  priceBefore: number,
  stateAfter: number,
  back: number
): number {
  const { buffer, buf, bufAvailFull, niceLen, position, cur } = step;
  let lenTest2 = lenTest + 1;
  const limit = Math.min(bufAvailFull, lenTest2 + niceLen);
  if (lenTest2 < limit) lenTest2 = memcmplen(buffer, buf, bufBack, lenTest2, limit);
  lenTest2 -= lenTest + 1;
  if (lenTest2 < 2) return lenEndStart;
  const { probs, posMask } = coder;
  let state2 = stateAfter;
  let posStateNext = (position + lenTest) & posMask;
  const curAndLenLiteralPrice =
    priceBefore +
    bit0Price(probs[IS_MATCH + state2 * POS_STATES_MAX + posStateNext]) +
    getLiteralPrice(
      coder,
      position + lenTest,
      buffer[buf + lenTest - 1],
      true,
      buffer[bufBack + lenTest],
      buffer[buf + lenTest]
    );
  state2 = updateLiteral(state2);
  posStateNext = (position + lenTest + 1) & posMask;
  const nextRepMatchPrice =
    curAndLenLiteralPrice +
    bit1Price(probs[IS_MATCH + state2 * POS_STATES_MAX + posStateNext]) +
    bit1Price(probs[IS_REP + state2]);
  const offset = cur + lenTest + 1 + lenTest2;
  const lenEnd = extendEnd(coder, lenEndStart, offset);
  const curAndLenPrice = nextRepMatchPrice + getRepPrice(coder, 0, lenTest2, state2, posStateNext);
  if (curAndLenPrice < coder.optPrice[offset]) {
    setOpt(coder, offset, curAndLenPrice, cur + lenTest + 1, 0);
    coder.optPrev1IsLiteral[offset] = 1;
    coder.optPrev2[offset] = 1;
    coder.optPosPrev2[offset] = cur;
    coder.optBackPrev2[offset] = back;
  }
  return lenEnd;
}

// code-gauge-allow functionNcss 58 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
function helper2(coder: LzmaEncoder, mf: MatchFinder, reps: Uint32Array, lenEndStart: number, step: Step): number {
  const { buffer, buf, cur, niceLen, bufAvailFull, state, posState, position } = step;
  const { probs } = coder;
  let lenEnd = lenEndStart;
  coder.optState[cur] = state;
  coder.optBacks.set(reps, cur * REPS);
  const curPrice = coder.optPrice[cur];
  const currentByte = buffer[buf];
  const matchByte = buffer[buf - reps[0] - 1];
  const isMatch = probs[IS_MATCH + state * POS_STATES_MAX + posState];
  const curAnd1Price =
    curPrice +
    bit0Price(isMatch) +
    getLiteralPrice(coder, position, buffer[buf - 1], state >= LIT_STATES, matchByte, currentByte);
  let nextIsLiteral = false;
  if (curAnd1Price < coder.optPrice[cur + 1]) {
    setOpt(coder, cur + 1, curAnd1Price, cur, UINT32_MAX);
    nextIsLiteral = true;
  }
  const matchPrice = curPrice + bit1Price(isMatch);
  const repMatchPrice = matchPrice + bit1Price(probs[IS_REP + state]);
  if (matchByte === currentByte && !(coder.optPosPrev[cur + 1] < cur && coder.optBackPrev[cur + 1] === 0)) {
    const shortRepPrice = repMatchPrice + getShortRepPrice(coder, state, posState);
    if (shortRepPrice <= coder.optPrice[cur + 1]) {
      setOpt(coder, cur + 1, shortRepPrice, cur, 0);
      nextIsLiteral = true;
    }
  }
  if (bufAvailFull < 2) return lenEnd;
  const bufAvail = Math.min(bufAvailFull, niceLen);
  if (!nextIsLiteral && matchByte !== currentByte) {
    const bufBack = buf - reps[0] - 1;
    const lenTest = memcmplen(buffer, buf, bufBack, 1, Math.min(bufAvailFull, niceLen + 1)) - 1;
    if (lenTest >= 2) {
      const state2 = updateLiteral(state);
      const posStateNext = (position + 1) & coder.posMask;
      const nextRepMatchPrice =
        curAnd1Price +
        bit1Price(probs[IS_MATCH + state2 * POS_STATES_MAX + posStateNext]) +
        bit1Price(probs[IS_REP + state2]);
      const offset = cur + 1 + lenTest;
      lenEnd = extendEnd(coder, lenEnd, offset);
      const curAndLenPrice = nextRepMatchPrice + getRepPrice(coder, 0, lenTest, state2, posStateNext);
      if (curAndLenPrice < coder.optPrice[offset]) {
        setOpt(coder, offset, curAndLenPrice, cur + 1, 0);
        coder.optPrev1IsLiteral[offset] = 1;
        coder.optPrev2[offset] = 0;
      }
    }
  }
  let startLen = 2;
  for (let repIndex = 0; repIndex < REPS; ++repIndex) {
    const bufBack = buf - reps[repIndex] - 1;
    if (notEqual16(buffer, buf, bufBack)) continue;
    let lenTest = memcmplen(buffer, buf, bufBack, 2, bufAvail);
    lenEnd = extendEnd(coder, lenEnd, cur + lenTest);
    const lenTestTemp = lenTest;
    const price = repMatchPrice + getPureRepPrice(coder, repIndex, state, posState);
    do {
      const curAndLenPrice = price + coder.repLenEncoder.price(lenTest, posState);
      if (curAndLenPrice < coder.optPrice[cur + lenTest]) setOpt(coder, cur + lenTest, curAndLenPrice, cur, repIndex);
    } while (--lenTest >= 2);
    lenTest = lenTestTemp;
    if (repIndex === 0) startLen = lenTest + 1;
    const priceBefore = price + coder.repLenEncoder.price(lenTest, posState);
    lenEnd = tryLiteralThenRep0(coder, step, lenEnd, bufBack, lenTest, priceBefore, updateLongRep(state), repIndex);
  }
  return matchesFrom(coder, mf, step, lenEnd, startLen, matchPrice, bufAvail);
}

/** The last part of helper2: the normal matches from `cur`. */
// code-gauge-allow functionParameterCount 7 -- Takes the locals of the optimum_normal helper it continues.
function matchesFrom(
  coder: LzmaEncoder,
  mf: MatchFinder,
  step: Step,
  lenEndStart: number,
  startLen: number,
  matchPrice: number,
  bufAvail: number
): number {
  const { matchLens, matchDists } = mf;
  const { buf, cur, state, posState } = step;
  let lenEnd = lenEndStart;
  let matchesCount = coder.matchesCount;
  let newLen = coder.longestMatchLength;
  if (newLen > bufAvail) {
    newLen = bufAvail;
    matchesCount = 0;
    while (newLen > matchLens[matchesCount]) ++matchesCount;
    matchLens[matchesCount++] = newLen;
  }
  if (newLen < startLen) return lenEnd;
  const normalMatchPrice = matchPrice + bit0Price(coder.probs[IS_REP + state]);
  lenEnd = extendEnd(coder, lenEnd, cur + newLen);
  let i = 0;
  while (startLen > matchLens[i]) ++i;
  for (let lenTest = startLen; ; ++lenTest) {
    const curBack = matchDists[i];
    const curAndLenPrice = normalMatchPrice + getDistLenPrice(coder, curBack, lenTest, posState);
    if (curAndLenPrice < coder.optPrice[cur + lenTest])
      setOpt(coder, cur + lenTest, curAndLenPrice, cur, curBack + REPS);
    if (lenTest === matchLens[i]) {
      const bufBack = buf - curBack - 1;
      lenEnd = tryLiteralThenRep0(
        coder,
        step,
        lenEnd,
        bufBack,
        lenTest,
        curAndLenPrice,
        updateMatch(state),
        curBack + REPS
      );
      if (++i === matchesCount) break;
    }
  }
  return lenEnd;
}

/** `lzma_lzma_optimum_normal`. */
export function optimumNormal(coder: LzmaEncoder, mf: MatchFinder, position: number): void {
  if (coder.optsEndIndex !== coder.optsCurrentIndex) {
    const index = coder.optsCurrentIndex;
    choose(coder, coder.optBackPrev[index], coder.optPosPrev[index] - index);
    coder.optsCurrentIndex = coder.optPosPrev[index];
    return;
  }
  if (mf.readAhead === 0) {
    if (coder.matchPriceCount >= 1 << 7) fillDistPrices(coder);
    if (coder.alignPriceCount >= ALIGN_SIZE) fillAlignPrices(coder);
  }
  let lenEnd = helper1(coder, mf, position);
  if (lenEnd === UINT32_MAX) return;
  const reps = Uint32Array.from(coder.reps);
  let cur: number;
  for (cur = 1; cur < lenEnd; ++cur) {
    coder.longestMatchLength = mf.find();
    coder.matchesCount = mf.matchesCount;
    if (coder.longestMatchLength >= mf.niceLen) break;
    const state = stateAt(coder, reps, cur);
    const curPosition = (position + cur) >>> 0;
    lenEnd = helper2(coder, mf, reps, lenEnd, {
      buffer: mf.buffer,
      buf: mf.readPos - 1,
      position: curPosition,
      cur,
      niceLen: mf.niceLen,
      bufAvailFull: Math.min(mf.avail + 1, OPTS - 1 - cur),
      state,
      posState: curPosition & coder.posMask,
    });
  }
  backward(coder, cur);
}
