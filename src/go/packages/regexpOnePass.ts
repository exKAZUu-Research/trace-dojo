import { encodeRune } from '../literals';
import type { RuneClass } from './regexpCharClass';
import {
  ANY_RUNE,
  ANY_RUNE_NOT_NL,
  EmptyOp,
  type Inst,
  InstOp,
  isLiteralRune,
  isRuneOp,
  type Prog,
} from './regexpProg';
import { Flag } from './regexpSyntax';
import { simpleFold } from './unicodeSupport';

/** Go's `onePassPrefix`: the literal after `^` that a onepass match starts with, and the pc after it. */
export function onePassPrefix(prog: Prog): { prefix: string; complete: boolean; pc: number } {
  let inst = prog.inst[prog.start];
  if (inst.op !== InstOp.EmptyWidth || (inst.arg & EmptyOp.BeginText) === 0) {
    return { prefix: '', complete: inst.op === InstOp.Match, pc: prog.start };
  }
  let pc = inst.out;
  inst = prog.inst[pc];
  while (inst.op === InstOp.Nop) {
    pc = inst.out;
    inst = prog.inst[pc];
  }
  if (!isRuneOp(inst.op) || inst.rune.length !== 1) {
    return { prefix: '', complete: inst.op === InstOp.Match, pc: prog.start };
  }
  let prefix = '';
  while (isLiteralRune(inst)) {
    prefix += encodeRune(inst.rune[0]);
    pc = inst.out;
    inst = prog.inst[pc];
  }
  const complete =
    inst.op === InstOp.EmptyWidth && (inst.arg & EmptyOp.EndText) !== 0 && prog.inst[inst.out].op === InstOp.Match;
  return { prefix, complete, pc };
}

/** Go's `compileOnePass`: a program that needs no backtracking, or undefined when the regexp is not onepass. */
// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes Go's compileOnePass step by step.
export function compileOnePass(prog: Prog): Prog | undefined {
  if (prog.start === 0) return undefined;
  const first = prog.inst[prog.start];
  if (first.op !== InstOp.EmptyWidth || (first.arg & EmptyOp.BeginText) !== EmptyOp.BeginText) return undefined;
  const hasAlt = prog.inst.some((inst) => inst.op === InstOp.Alt || inst.op === InstOp.AltMatch);
  for (const inst of prog.inst) {
    const opOut = prog.inst[inst.out].op;
    if (inst.op === InstOp.Alt || inst.op === InstOp.AltMatch) {
      if (opOut === InstOp.Match || prog.inst[inst.arg].op === InstOp.Match) return undefined;
    } else if (inst.op === InstOp.EmptyWidth) {
      if (opOut === InstOp.Match && (inst.arg & EmptyOp.EndText) !== EmptyOp.EndText) return undefined;
    } else if (opOut === InstOp.Match && hasAlt) {
      return undefined;
    }
  }
  const onepass = makeOnePass(onePassCopy(prog));
  if (onepass) cleanupOnePass(onepass, prog);
  return onepass;
}

function cleanupOnePass(onepass: Prog, original: Prog): void {
  for (const [ix, inst] of original.inst.entries()) {
    switch (inst.op) {
      case InstOp.Alt:
      case InstOp.AltMatch:
      case InstOp.Rune: {
        break;
      }
      case InstOp.Rune1:
      case InstOp.RuneAny:
      case InstOp.RuneAnyNotNL: {
        onepass.inst[ix] = { ...inst };
        break;
      }
      default: {
        onepass.inst[ix].next = undefined;
      }
    }
  }
}

function isAlt(inst: Inst): boolean {
  return inst.op === InstOp.Alt || inst.op === InstOp.AltMatch;
}

type InstField = 'out' | 'arg';

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes Go's onePassCopy step by step.
function onePassCopy(prog: Prog): Prog {
  const p: Prog = { start: prog.start, numCap: prog.numCap, inst: prog.inst.map((inst) => ({ ...inst })) };
  for (const [pc, inst] of p.inst.entries()) {
    if (!isAlt(inst)) continue;
    let aOther: InstField = 'out';
    let aAlt: InstField = 'arg';
    let instAlt = p.inst[inst[aAlt]];
    if (!isAlt(instAlt)) {
      [aAlt, aOther] = [aOther, aAlt];
      instAlt = p.inst[inst[aAlt]];
      if (!isAlt(instAlt)) continue;
    }
    if (isAlt(p.inst[inst[aOther]])) continue;
    const altInst = p.inst[inst[aAlt]];
    let bAlt: InstField = 'out';
    let bOther: InstField = 'arg';
    let patch = false;
    if (instAlt.out === pc) {
      patch = true;
    } else if (instAlt.arg === pc) {
      patch = true;
      [bAlt, bOther] = [bOther, bAlt];
    }
    if (patch) altInst[bAlt] = inst[aOther];
    if (inst[aOther] === altInst[bAlt]) inst[aAlt] = altInst[bOther];
  }
  return p;
}

const MERGE_FAILED = 0xff_ff_ff_ff;

function mergeRuneSets(left: RuneClass, right: RuneClass, leftPC: number, rightPC: number): [RuneClass, number[]] {
  const merged: RuneClass = [];
  const next: number[] = [];
  let lx = 0;
  let rx = 0;
  const extend = (runes: RuneClass, low: number, pc: number): boolean => {
    if (merged.length > 0 && runes[low] <= (merged.at(-1) as number)) return false;
    merged.push(runes[low], runes[low + 1]);
    next.push(pc);
    return true;
  };
  while (lx < left.length || rx < right.length) {
    let ok: boolean;
    if (rx >= right.length || (lx < left.length && right[rx] >= left[lx])) {
      ok = extend(left, lx, leftPC);
      lx += 2;
    } else {
      ok = extend(right, rx, rightPC);
      rx += 2;
    }
    if (!ok) return [[], [MERGE_FAILED]];
  }
  return [merged, next];
}

function foldedRunes(r0: number): RuneClass {
  const runes = [r0, r0];
  for (let r1 = simpleFold(r0); r1 !== r0; r1 = simpleFold(r1)) runes.push(r1, r1);
  return runes.toSorted((a, b) => a - b);
}

function nextFor(runes: RuneClass, out: number): number[] {
  return Array.from<number>({ length: runes.length / 2 + 1 }).fill(out);
}

/** Go's `makeOnePass`: rewrites the copied program into a onepass one, or returns undefined when it is not onepass. */
function makeOnePass(p: Prog): Prog | undefined {
  if (p.inst.length >= 1000) return undefined;
  const builder = new OnePassBuilder(p);
  if (!builder.run()) return undefined;
  for (const [i, inst] of p.inst.entries()) inst.rune = builder.onePassRunes[i];
  return p;
}

/** The state of Go's `makeOnePass`: the queue of instructions to check and the rune sets found for each. */
class OnePassBuilder {
  readonly onePassRunes: RuneClass[];
  private readonly instQueue: number[] = [];
  private readonly queued = new Set<number>();
  private readonly visited = new Set<number>();
  private readonly matches: boolean[];

  constructor(private readonly p: Prog) {
    this.onePassRunes = p.inst.map(() => []);
    this.matches = p.inst.map(() => false);
  }

  run(): boolean {
    this.insert(this.p.start);
    for (let at = 0; at < this.instQueue.length; at++) {
      this.visited.clear();
      if (!this.check(this.instQueue[at])) return false;
    }
    return true;
  }

  private insert(pc: number): void {
    if (!this.queued.has(pc)) {
      this.queued.add(pc);
      this.instQueue.push(pc);
    }
  }

  private check(pc: number): boolean {
    const inst = this.p.inst[pc];
    if (this.visited.has(pc)) return true;
    this.visited.add(pc);
    switch (inst.op) {
      case InstOp.Alt:
      case InstOp.AltMatch: {
        return this.checkAlt(pc, inst);
      }
      case InstOp.Capture:
      case InstOp.Nop:
      case InstOp.EmptyWidth: {
        const ok = this.check(inst.out);
        this.matches[pc] = this.matches[inst.out];
        this.onePassRunes[pc] = [...this.onePassRunes[inst.out]];
        inst.next = nextFor(this.onePassRunes[pc], inst.out);
        return ok;
      }
      case InstOp.Match:
      case InstOp.Fail: {
        this.matches[pc] = inst.op === InstOp.Match;
        return true;
      }
    }
    this.matches[pc] = false;
    if (inst.next && inst.next.length > 0) return true;
    this.insert(inst.out);
    this.onePassRunes[pc] = onePassRuneSet(inst);
    return true;
  }

  private checkAlt(pc: number, inst: Inst): boolean {
    const ok = this.check(inst.out) && this.check(inst.arg);
    let matchOut = this.matches[inst.out];
    const matchArg = this.matches[inst.arg];
    if (matchOut && matchArg) return false;
    if (matchArg) {
      [inst.out, inst.arg] = [inst.arg, inst.out];
      matchOut = matchArg;
    }
    if (matchOut) {
      this.matches[pc] = true;
      inst.op = InstOp.AltMatch;
    }
    [this.onePassRunes[pc], inst.next] = mergeRuneSets(
      this.onePassRunes[inst.out],
      this.onePassRunes[inst.arg],
      inst.out,
      inst.arg
    );
    if (inst.next.length > 0 && inst.next[0] === MERGE_FAILED) return false;
    return ok;
  }
}

/** The runes a rune instruction of a onepass program matches, setting its next instructions. */
function onePassRuneSet(inst: Inst): RuneClass {
  let runes: RuneClass;
  switch (inst.op) {
    case InstOp.Rune: {
      if (inst.rune.length === 0) {
        inst.next = [inst.out];
        return [];
      }
      runes = inst.rune.length === 1 && inst.arg & Flag.FoldCase ? foldedRunes(inst.rune[0]) : [...inst.rune];
      inst.op = InstOp.Rune;
      break;
    }
    case InstOp.Rune1: {
      runes = inst.arg & Flag.FoldCase ? foldedRunes(inst.rune[0]) : [inst.rune[0], inst.rune[0]];
      inst.op = InstOp.Rune;
      break;
    }
    case InstOp.RuneAny: {
      inst.next = [inst.out];
      return [...ANY_RUNE];
    }
    default: {
      runes = [...ANY_RUNE_NOT_NL];
    }
  }
  inst.next = nextFor(runes, inst.out);
  return runes;
}
