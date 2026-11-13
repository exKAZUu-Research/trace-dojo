// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { decodeRune, RUNE_ERROR } from '../literals';
import { EmptyOp, IMPOSSIBLE, type Inst, InstOp, matchRunePos, type Prog } from './regexpProg';
import { runeAt } from './regexpSyntax';

const END_OF_TEXT = -1;

/** The compiled form of a `*regexp.Regexp` that matching needs, as in Go's regexp.go. */
export interface Matcher {
  prog: Prog;
  onepass: Prog | undefined;
  prefix: string;
  prefixRune: number;
  prefixEnd: number;
  cond: number;
  minInputLen: number;
}

/** Go's `input`: the text a match runs over, a byte string or an `io.RuneReader`. */
export interface Input {
  /** The rune at `pos`, setting `width` to its size; END_OF_TEXT with width 0 past the end. */
  step(pos: number): number;
  width: number;
  canCheckPrefix(): boolean;
  hasPrefix(prefix: string): boolean;
  index(prefix: string, pos: number): number;
  context(pos: number): LazyFlag;
}

export class StringInput implements Input {
  width = 0;

  constructor(readonly str: string) {}

  step(pos: number): number {
    if (pos < this.str.length) {
      const { rune, size } = decodeRune(this.str, pos);
      this.width = size;
      return rune;
    }
    this.width = 0;
    return END_OF_TEXT;
  }

  canCheckPrefix(): boolean {
    return true;
  }

  hasPrefix(prefix: string): boolean {
    return this.str.startsWith(prefix);
  }

  index(prefix: string, pos: number): number {
    const at = this.str.indexOf(prefix, pos);
    return at === -1 ? -1 : at - pos;
  }

  context(pos: number): LazyFlag {
    let r1 = END_OF_TEXT;
    let r2 = END_OF_TEXT;
    if (pos - 1 >= 0 && pos - 1 < this.str.length) r1 = decodeLastRune(this.str.slice(0, pos));
    if (pos >= 0 && pos < this.str.length) r2 = decodeRune(this.str, pos).rune;
    return new LazyFlag(r1, r2);
  }
}

/** Go's `inputReader`, reading runes through `ReadRune` as the match advances. */
export class ReaderInput implements Input {
  width = 0;
  private atEOT = false;
  private pos = 0;

  constructor(private readonly readRune: () => { rune: number; size: number } | undefined) {}

  step(pos: number): number {
    if (!this.atEOT && pos !== this.pos) {
      this.width = 0;
      return END_OF_TEXT;
    }
    const read = this.readRune();
    if (!read) {
      this.atEOT = true;
      this.width = 0;
      return END_OF_TEXT;
    }
    this.pos += read.size;
    this.width = read.size;
    return read.rune;
  }

  canCheckPrefix(): boolean {
    return false;
  }

  hasPrefix(): boolean {
    return false;
  }

  index(): number {
    return -1;
  }

  context(): LazyFlag {
    return new LazyFlag(0, 0);
  }
}

/** `utf8.DecodeLastRuneInString`. */
function decodeLastRune(s: string): number {
  const end = s.length;
  if (end === 0) return RUNE_ERROR;
  let start = end - 1;
  if (s.charCodeAt(start) < 0x80) return s.charCodeAt(start);
  const lim = Math.max(end - 4, 0);
  for (start--; start >= lim; start--) {
    if ((s.charCodeAt(start) & 0xc0) !== 0x80) break;
  }
  if (start < 0) start = 0;
  const { rune, size } = runeAt(s, start);
  return start + size === end ? rune : RUNE_ERROR;
}

function isWordChar(r: number): boolean {
  return (r >= 0x61 && r <= 0x7a) || (r >= 0x41 && r <= 0x5a) || (r >= 0x30 && r <= 0x39) || r === 0x5f;
}

/** Go's `lazyFlag`: the runes around a position, from which empty-width conditions are decided. */
export class LazyFlag {
  constructor(
    readonly r1: number,
    readonly r2: number
  ) {}

  // code-gauge-allow functionCognitiveComplexity 18 -- Transcribes Go's lazyFlag.match step by step.
  allows(emptyOp: number): boolean {
    let op = emptyOp;
    if (op === 0) return true;
    const r1 = this.r1;
    if (op & EmptyOp.BeginLine) {
      if (r1 !== 10 && r1 >= 0) return false;
      op &= ~EmptyOp.BeginLine;
    }
    if (op & EmptyOp.BeginText) {
      if (r1 >= 0) return false;
      op &= ~EmptyOp.BeginText;
    }
    if (op === 0) return true;
    const r2 = this.r2;
    if (op & EmptyOp.EndLine) {
      if (r2 !== 10 && r2 >= 0) return false;
      op &= ~EmptyOp.EndLine;
    }
    if (op & EmptyOp.EndText) {
      if (r2 >= 0) return false;
      op &= ~EmptyOp.EndText;
    }
    if (op === 0) return true;
    op &= ~(isWordChar(r1) === isWordChar(r2) ? EmptyOp.NoWordBoundary : EmptyOp.WordBoundary);
    return op === 0;
  }
}

/** The rune at the position and the one after it, which Go's matchers keep as r, width, r1, and width1. */
class Cursor {
  r = END_OF_TEXT;
  width = 0;
  r1 = END_OF_TEXT;
  width1 = 0;

  constructor(
    private readonly input: Input,
    public pos: number
  ) {
    this.r = input.step(pos);
    this.width = input.width;
    if (this.r !== END_OF_TEXT) {
      this.r1 = input.step(pos + this.width);
      this.width1 = input.width;
    }
  }

  seek(pos: number): void {
    this.pos = pos;
    this.r = this.input.step(pos);
    this.width = this.input.width;
    this.r1 = this.input.step(pos + this.width);
    this.width1 = this.input.width;
  }

  advance(): void {
    this.pos += this.width;
    this.r = this.r1;
    this.width = this.width1;
    if (this.r !== END_OF_TEXT) {
      this.r1 = this.input.step(this.pos + this.width);
      this.width1 = this.input.width;
    }
  }
}

interface Thread {
  inst: Inst;
  cap: number[];
}

interface Entry {
  pc: number;
  t: Thread | undefined;
}

class Queue {
  readonly sparse: Uint32Array;
  dense: Entry[] = [];

  constructor(size: number) {
    this.sparse = new Uint32Array(size);
  }
}

/** Go's `(*Regexp).find`: the capture positions of the leftmost match at or after `pos`, or undefined. */
// code-gauge-allow functionParameterCount 7 -- Takes the parameters of Go's find.
export function find(
  re: Matcher,
  longest: boolean,
  input: Input,
  length: number | undefined,
  pos: number,
  ncap: number,
  spend: (cost: number) => void
): number[] | undefined {
  if (length !== undefined && length < re.minInputLen) return undefined;
  if (re.onepass) return doOnePass(re, input, pos, ncap, spend);
  const machine = new Machine(re, longest, ncap, spend);
  return machine.match(input, pos) ? machine.matchcap : undefined;
}

/** Go's pike VM (`machine` in exec.go), which runs all threads in step over the input. */
class Machine {
  private readonly prog: Prog;
  private readonly q0: Queue;
  private readonly q1: Queue;
  private pool: Thread[] = [];
  private matched = false;
  readonly matchcap: number[];

  constructor(
    private readonly re: Matcher,
    private readonly longest: boolean,
    ncap: number,
    private readonly spend: (cost: number) => void
  ) {
    this.prog = re.prog;
    this.q0 = new Queue(this.prog.inst.length);
    this.q1 = new Queue(this.prog.inst.length);
    this.matchcap = Array.from<number>({ length: ncap }).fill(-1);
  }

  match(input: Input, start: number): boolean {
    if (this.re.cond === IMPOSSIBLE) return false;
    let runq = this.q0;
    let nextq = this.q1;
    const at = new Cursor(input, start);
    let flag = start === 0 ? new LazyFlag(-1, at.r) : input.context(start);
    for (;;) {
      if (runq.dense.length === 0 && !this.canStart(input, at)) break;
      if (!this.matched) {
        if (this.matchcap.length > 0) this.matchcap[0] = at.pos;
        this.add(runq, this.prog.start, at.pos, this.matchcap, flag, undefined);
      }
      flag = new LazyFlag(at.r, at.r1);
      this.step(runq, nextq, at.pos, at.pos + at.width, at.r, flag);
      if (at.width === 0 || (this.matchcap.length === 0 && this.matched)) break;
      at.advance();
      [runq, nextq] = [nextq, runq];
    }
    return this.matched;
  }

  /** Whether a new thread may start once all have died, skipping ahead to the next occurrence of the prefix. */
  private canStart(input: Input, at: Cursor): boolean {
    if (this.re.cond & EmptyOp.BeginText && at.pos !== 0) return false;
    if (this.matched) return false;
    if (this.re.prefix.length > 0 && at.r1 !== this.re.prefixRune && input.canCheckPrefix()) {
      const advance = input.index(this.re.prefix, at.pos);
      if (advance < 0) return false;
      at.seek(at.pos + advance);
    }
    return true;
  }

  private step(runq: Queue, nextq: Queue, pos: number, nextPos: number, c: number, nextCond: LazyFlag): void {
    this.spend(1 + (runq.dense.length >>> 4));
    for (let j = 0; j < runq.dense.length; j++) {
      let t = runq.dense[j].t;
      if (!t) continue;
      if (this.longest && this.matched && t.cap.length > 0 && this.matchcap[0] < t.cap[0]) {
        this.pool.push(t);
        continue;
      }
      const i = t.inst;
      if (i.op === InstOp.Match) this.recordMatch(t, runq, j, pos);
      else if (runeMatches(i, c)) t = this.add(nextq, i.out, nextPos, t.cap, nextCond, t);
      if (t) this.pool.push(t);
    }
    runq.dense = [];
  }

  /** Records the match of thread `j`, which ends the lower-priority threads unless the longest match is wanted. */
  private recordMatch(t: Thread, runq: Queue, j: number, pos: number): void {
    if (t.cap.length > 0 && (!this.longest || !this.matched || this.matchcap[1] < pos)) {
      t.cap[1] = pos;
      for (let k = 0; k < this.matchcap.length; k++) this.matchcap[k] = t.cap[k];
    }
    if (!this.longest) {
      for (const d of runq.dense.slice(j + 1)) if (d.t) this.pool.push(d.t);
      runq.dense = [];
    }
    this.matched = true;
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Transcribes Go's machine.add step by step.
  // code-gauge-allow functionNcss 50 -- Transcribes Go's machine.add step by step.
  private add(
    q: Queue,
    startPC: number,
    pos: number,
    cap: number[],
    cond: LazyFlag,
    thread?: Thread
  ): Thread | undefined {
    let t = thread;
    let pc = startPC;
    for (;;) {
      if (pc === 0) return t;
      const j = q.sparse[pc];
      if (j < q.dense.length && q.dense[j].pc === pc) return t;
      const d: Entry = { pc, t: undefined };
      q.sparse[pc] = q.dense.length;
      q.dense.push(d);
      const i = this.prog.inst[pc];
      switch (i.op) {
        case InstOp.Fail: {
          return t;
        }
        case InstOp.Alt:
        case InstOp.AltMatch: {
          t = this.add(q, i.out, pos, cap, cond, t);
          pc = i.arg;
          continue;
        }
        case InstOp.EmptyWidth: {
          if (!cond.allows(i.arg)) return t;
          pc = i.out;
          continue;
        }
        case InstOp.Nop: {
          pc = i.out;
          continue;
        }
        case InstOp.Capture: {
          if (i.arg < cap.length) {
            const opos = cap[i.arg];
            cap[i.arg] = pos;
            this.add(q, i.out, pos, cap, cond, undefined);
            cap[i.arg] = opos;
            return t;
          }
          pc = i.out;
          continue;
        }
      }
      if (t) t.inst = i;
      else t = this.pool.pop() ?? { inst: i, cap: Array.from<number>({ length: this.matchcap.length }).fill(0) };
      t.inst = i;
      if (cap.length > 0 && t.cap !== cap) for (let k = 0; k < cap.length; k++) t.cap[k] = cap[k];
      d.t = t;
      return undefined;
    }
  }
}

function onePassNext(inst: Inst, r: number): number {
  const next = matchRunePos(inst, r);
  if (next >= 0) return (inst.next as number[])[next];
  if (inst.op === InstOp.AltMatch) return inst.out;
  return 0;
}

function runeMatches(inst: Inst, c: number): boolean {
  switch (inst.op) {
    case InstOp.Rune: {
      return matchRunePos(inst, c) >= 0;
    }
    case InstOp.Rune1: {
      return c === inst.rune[0];
    }
    case InstOp.RuneAny: {
      return true;
    }
    case InstOp.RuneAnyNotNL: {
      return c !== 10;
    }
  }
  throw new Error('bad inst');
}

/** Go's `doOnePass`, which follows the single possible thread of a onepass program. */
// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes Go's doOnePass step by step.
// code-gauge-allow functionNcss 44 -- Transcribes Go's doOnePass step by step.
function doOnePass(
  re: Matcher,
  input: Input,
  start: number,
  ncap: number,
  spend: (cost: number) => void
): number[] | undefined {
  if (re.cond === IMPOSSIBLE) return undefined;
  const onepass = re.onepass as Prog;
  const matchcap = Array.from<number>({ length: ncap }).fill(-1);
  const at = new Cursor(input, start);
  let flag = start === 0 ? new LazyFlag(-1, at.r) : input.context(start);
  let pc = onepass.start;
  if (start === 0 && flag.allows(onepass.inst[pc].arg) && re.prefix.length > 0 && input.canCheckPrefix()) {
    if (!input.hasPrefix(re.prefix)) return undefined;
    at.seek(re.prefix.length);
    flag = input.context(at.pos);
    pc = re.prefixEnd;
  }
  for (;;) {
    spend(1);
    const inst = onepass.inst[pc];
    pc = inst.out;
    switch (inst.op) {
      case InstOp.Match: {
        if (matchcap.length > 0) {
          matchcap[0] = 0;
          matchcap[1] = at.pos;
        }
        return matchcap;
      }
      case InstOp.Alt:
      case InstOp.AltMatch: {
        pc = onePassNext(inst, at.r);
        continue;
      }
      case InstOp.Fail: {
        return undefined;
      }
      case InstOp.Nop: {
        continue;
      }
      case InstOp.EmptyWidth: {
        if (!flag.allows(inst.arg)) return undefined;
        continue;
      }
      case InstOp.Capture: {
        if (inst.arg < matchcap.length) matchcap[inst.arg] = at.pos;
        continue;
      }
    }
    if (!runeMatches(inst, at.r) || at.width === 0) return undefined;
    flag = new LazyFlag(at.r, at.r1);
    at.advance();
  }
}
