// The back end of bzip2 1.0.8's `compress.c`: the move-to-front and Huffman coding of a sorted block.
import { assignCodes, BZ_MAX_ALPHA_SIZE, makeCodeLengths } from './bzip2Huffman';

const BZ_N_GROUPS = 6;
const BZ_G_SIZE = 50;
const BZ_N_ITERS = 4;
const BZ_MAX_SELECTORS = 2 + 900_000 / BZ_G_SIZE;
const BZ_RUNA = 0;
const BZ_RUNB = 1;
const BZ_LESSER_ICOST = 0;
const BZ_GREATER_ICOST = 15;

export interface BitWriter {
  bsW(n: number, v: number): void;
}

/** A sorted block's symbols after the move-to-front and the zero-run coding. */
interface Symbols {
  mtfv: Uint16Array;
  nMTF: number;
  mtfFreq: Int32Array;
  alphaSize: number;
}

/** `generateMTFValues` and `sendMTFValues`: writes the coded block of `block[0, nblock)` in the order `ptr` sorts. */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows the steps of sendMTFValues of bzip2's compress.c.
export function writeBlock(
  out: BitWriter,
  block: Uint8Array,
  ptr: Int32Array,
  nblock: number,
  inUse: readonly boolean[]
): void {
  const symbols = generateMTFValues(block, ptr, nblock, inUse);
  const { nMTF, alphaSize } = symbols;
  const nGroups = nMTF < 200 ? 2 : nMTF < 600 ? 3 : nMTF < 1200 ? 4 : nMTF < 2400 ? 5 : 6;
  const len = initialTables(symbols, nGroups);
  const selector = new Uint8Array(BZ_MAX_SELECTORS);
  let nSelectors = 0;
  for (let iter = 0; iter < BZ_N_ITERS; iter++) {
    const rfreq = Array.from({ length: nGroups }, () => new Int32Array(BZ_MAX_ALPHA_SIZE));
    nSelectors = chooseTables(symbols, len, nGroups, selector, rfreq);
    for (let t = 0; t < nGroups; t++) makeCodeLengths(len[t], rfreq[t], alphaSize, 17);
  }
  const code = len.map((lengths) => {
    const codes = new Int32Array(BZ_MAX_ALPHA_SIZE);
    assignCodes(codes, lengths, alphaSize);
    return codes;
  });
  writeMapping(out, inUse);
  writeSelectors(out, nGroups, selector.subarray(0, nSelectors));
  writeCodingTables(out, len, alphaSize);
  for (let selCtr = 0, gs = 0; gs < nMTF; gs += BZ_G_SIZE, selCtr++) {
    const lengths = len[selector[selCtr]];
    const codes = code[selector[selCtr]];
    for (let i = gs; i <= Math.min(gs + BZ_G_SIZE - 1, nMTF - 1); i++)
      out.bsW(lengths[symbols.mtfv[i]], codes[symbols.mtfv[i]]);
  }
}

function generateMTFValues(block: Uint8Array, ptr: Int32Array, nblock: number, inUse: readonly boolean[]): Symbols {
  const unseqToSeq = new Uint8Array(256);
  let nInUse = 0;
  for (let i = 0; i < 256; i++) if (inUse[i]) unseqToSeq[i] = nInUse++;
  const eob = nInUse + 1;
  const mtfv = new Uint16Array(nblock + 1);
  const mtfFreq = new Int32Array(BZ_MAX_ALPHA_SIZE);
  let wr = 0;
  let zPend = 0;
  const putSymbol = (symbol: number): void => {
    mtfv[wr++] = symbol;
    mtfFreq[symbol]++;
  };
  const yy = Uint8Array.from({ length: nInUse }, (_, i) => i);
  for (let i = 0; i < nblock; i++) {
    const llI = unseqToSeq[block[ptr[i] === 0 ? nblock - 1 : ptr[i] - 1]];
    if (yy[0] === llI) {
      zPend++;
      continue;
    }
    putZeroRun(zPend, putSymbol);
    zPend = 0;
    putSymbol(moveToFront(yy, llI) + 1);
  }
  putZeroRun(zPend, putSymbol);
  putSymbol(eob);
  return { mtfv, nMTF: wr, mtfFreq, alphaSize: nInUse + 2 };
}

/** Writes a run of `zPend` zeros in the bijective base 2 of RUNA and RUNB. */
function putZeroRun(zPend: number, putSymbol: (symbol: number) => void): void {
  if (zPend === 0) return;
  for (let run = zPend - 1; ; run = (run - 2) >> 1) {
    putSymbol(run & 1 ? BZ_RUNB : BZ_RUNA);
    if (run < 2) break;
  }
}

/** Moves `value` to the front of `list`, returning where it was. */
function moveToFront(list: Uint8Array, value: number): number {
  let previous = list[0];
  let position = 0;
  while (previous !== value) {
    position++;
    const next = list[position];
    list[position] = previous;
    previous = next;
  }
  list[0] = previous;
  return position;
}

/** The initial coding tables, each cheap for its own range of symbols, as bzip2 splits the frequencies. */
function initialTables({ mtfFreq, nMTF, alphaSize }: Symbols, nGroups: number): Uint8Array[] {
  const len = Array.from({ length: BZ_N_GROUPS }, () => new Uint8Array(BZ_MAX_ALPHA_SIZE).fill(BZ_GREATER_ICOST));
  let gs = 0;
  for (let nPart = nGroups, remF = nMTF; nPart > 0; nPart--) {
    const tFreq = Math.trunc(remF / nPart);
    let ge = gs - 1;
    let aFreq = 0;
    while (aFreq < tFreq && ge < alphaSize - 1) aFreq += mtfFreq[++ge];
    if (ge > gs && nPart !== nGroups && nPart !== 1 && (nGroups - nPart) % 2 === 1) aFreq -= mtfFreq[ge--];
    for (let v = 0; v < alphaSize; v++) len[nPart - 1][v] = v >= gs && v <= ge ? BZ_LESSER_ICOST : BZ_GREATER_ICOST;
    gs = ge + 1;
    remF -= aFreq;
  }
  return len.slice(0, nGroups);
}

/** Picks the cheapest table for each group of 50 symbols, counting the symbols each table codes. */
function chooseTables(
  { mtfv, nMTF }: Symbols,
  len: Uint8Array[],
  nGroups: number,
  selector: Uint8Array,
  rfreq: Int32Array[]
): number {
  let nSelectors = 0;
  for (let gs = 0; gs < nMTF; gs += BZ_G_SIZE) {
    const ge = Math.min(gs + BZ_G_SIZE - 1, nMTF - 1);
    let bc = 999_999_999;
    let bt = -1;
    for (let t = 0; t < nGroups; t++) {
      let cost = 0;
      for (let i = gs; i <= ge; i++) cost += len[t][mtfv[i]];
      if (cost < bc) {
        bc = cost;
        bt = t;
      }
    }
    selector[nSelectors++] = bt;
    for (let i = gs; i <= ge; i++) rfreq[bt][mtfv[i]]++;
  }
  return nSelectors;
}

function writeMapping(out: BitWriter, inUse: readonly boolean[]): void {
  const inUse16 = Array.from({ length: 16 }, (_, i) => inUse.slice(i * 16, i * 16 + 16).includes(true));
  for (const used of inUse16) out.bsW(1, used ? 1 : 0);
  for (const [i, used] of inUse16.entries()) {
    if (used) for (let j = 0; j < 16; j++) out.bsW(1, inUse[i * 16 + j] ? 1 : 0);
  }
}

function writeSelectors(out: BitWriter, nGroups: number, selector: Uint8Array): void {
  out.bsW(3, nGroups);
  out.bsW(15, selector.length);
  const pos = Uint8Array.from({ length: nGroups }, (_, i) => i);
  for (const each of selector) {
    for (let j = moveToFront(pos, each); j > 0; j--) out.bsW(1, 1);
    out.bsW(1, 0);
  }
}

function writeCodingTables(out: BitWriter, len: Uint8Array[], alphaSize: number): void {
  for (const lengths of len) {
    let curr = lengths[0];
    out.bsW(5, curr);
    for (let i = 0; i < alphaSize; i++) {
      for (; curr < lengths[i]; curr++) out.bsW(2, 2);
      for (; curr > lengths[i]; curr--) out.bsW(2, 3);
      out.bsW(1, 0);
    }
  }
}
