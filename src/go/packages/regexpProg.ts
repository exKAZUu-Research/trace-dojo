import { encodeRune, RUNE_ERROR } from '../literals';
import { MAX_RUNE, type RuneClass } from './regexpCharClass';
import { Flag, newNode, type Node, Op } from './regexpSyntax';
import { simpleFold } from './unicodeSupport';

/** Go's `syntax.InstOp`. */
export const InstOp = {
  Alt: 0,
  AltMatch: 1,
  Capture: 2,
  EmptyWidth: 3,
  Match: 4,
  Fail: 5,
  Nop: 6,
  Rune: 7,
  Rune1: 8,
  RuneAny: 9,
  RuneAnyNotNL: 10,
} as const;

/** Go's `syntax.EmptyOp`. */
export const EmptyOp = {
  BeginLine: 1,
  EndLine: 2,
  BeginText: 4,
  EndText: 8,
  WordBoundary: 16,
  NoWordBoundary: 32,
} as const;

/** The start condition of a program that cannot match, Go's `^EmptyOp(0)`. */
export const IMPOSSIBLE = 0xff;

export interface Inst {
  op: number;
  out: number;
  arg: number;
  rune: RuneClass;
  /** The next instructions of a onepass instruction, one per rune range. */
  next?: number[];
}

export interface Prog {
  inst: Inst[];
  start: number;
  numCap: number;
}

export const ANY_RUNE_NOT_NL = [0, 9, 11, MAX_RUNE];
export const ANY_RUNE = [0, MAX_RUNE];

// Simplify --------------------------------------------------------------------------------------------------------

/** Go's `(*Regexp).Simplify`, which rewrites counted repetitions into simpler operators. */
export function simplify(re: Node): Node {
  switch (re.op) {
    case Op.Capture:
    case Op.Concat:
    case Op.Alternate: {
      const subs = re.sub.map((sub) => simplify(sub));
      return subs.every((sub, i) => sub === re.sub[i]) ? re : { ...re, rune: [], sub: subs };
    }
    case Op.Star:
    case Op.Plus:
    case Op.Quest: {
      return simplify1(re.op, re.flags, simplify(re.sub[0]), re);
    }
    case Op.Repeat: {
      return simplifyRepeat(re);
    }
  }
  return re;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes the OpRepeat case of Go's Simplify.
// code-gauge-allow functionNcss 31 -- Transcribes the OpRepeat case of Go's Simplify.
function simplifyRepeat(re: Node): Node {
  if (re.min === 0 && re.max === 0) return newNode(Op.EmptyMatch);
  const sub = simplify(re.sub[0]);
  if (re.max === -1) {
    if (re.min === 0) return simplify1(Op.Star, re.flags, sub);
    if (re.min === 1) return simplify1(Op.Plus, re.flags, sub);
    const concat = newNode(Op.Concat);
    for (let i = 0; i < re.min - 1; i++) concat.sub.push(sub);
    concat.sub.push(simplify1(Op.Plus, re.flags, sub));
    return concat;
  }
  if (re.min === 1 && re.max === 1) return sub;
  let prefix: Node | undefined;
  if (re.min > 0) {
    prefix = newNode(Op.Concat);
    for (let i = 0; i < re.min; i++) prefix.sub.push(sub);
  }
  if (re.max > re.min) {
    let suffix = simplify1(Op.Quest, re.flags, sub);
    for (let i = re.min + 1; i < re.max; i++) {
      const concat = newNode(Op.Concat);
      concat.sub = [sub, suffix];
      suffix = simplify1(Op.Quest, re.flags, concat);
    }
    if (!prefix) return suffix;
    prefix.sub.push(suffix);
  }
  return prefix ?? newNode(Op.NoMatch);
}

function simplify1(op: number, flags: number, sub: Node, re?: Node): Node {
  if (sub.op === Op.EmptyMatch) return sub;
  if (op === sub.op && (flags & Flag.NonGreedy) === (sub.flags & Flag.NonGreedy)) return sub;
  if (re && re.op === op && (re.flags & Flag.NonGreedy) === (flags & Flag.NonGreedy) && sub === re.sub[0]) return re;
  const node = newNode(op, flags);
  node.sub = [sub];
  return node;
}

/** The minimum number of input bytes a match needs, as Go's `minInputLen`. */
export function minInputLen(re: Node): number {
  switch (re.op) {
    case Op.AnyChar:
    case Op.AnyCharNotNL:
    case Op.CharClass: {
      return 1;
    }
    case Op.Literal: {
      let length = 0;
      for (const rune of re.rune) length += rune === RUNE_ERROR ? 1 : runeLen(rune);
      return length;
    }
    case Op.Capture:
    case Op.Plus: {
      return minInputLen(re.sub[0]);
    }
    case Op.Repeat: {
      return re.min * minInputLen(re.sub[0]);
    }
    case Op.Concat: {
      return re.sub.reduce((sum, sub) => sum + minInputLen(sub), 0);
    }
    case Op.Alternate: {
      return Math.min(...re.sub.map((sub) => minInputLen(sub)));
    }
  }
  return 0;
}

function runeLen(rune: number): number {
  if (rune < 0) return -1;
  if (rune < 0x80) return 1;
  if (rune < 0x8_00) return 2;
  if (rune >= 0xd8_00 && rune <= 0xdf_ff) return -1;
  if (rune < 0x1_00_00) return 3;
  return rune <= MAX_RUNE ? 4 : -1;
}

// Compile ---------------------------------------------------------------------------------------------------------

/** A list of instruction fields to patch, linked through themselves: `pc * 2` for Out, `pc * 2 + 1` for Arg. */
interface PatchList {
  head: number;
  tail: number;
}

interface Frag {
  i: number;
  out: PatchList;
  nullable: boolean;
}

const NO_PATCH: PatchList = { head: 0, tail: 0 };

/** Go's `syntax.Compile`. */
export function compileProg(re: Node, allocate: (count: number) => void): Prog {
  const compiler = new Compiler(allocate);
  const f = compiler.compile(re);
  compiler.patch(f.out, compiler.inst(InstOp.Match).i);
  compiler.prog.start = f.i;
  return compiler.prog;
}

class Compiler {
  readonly prog: Prog = { inst: [], start: 0, numCap: 2 };

  constructor(private readonly allocate: (count: number) => void) {
    this.inst(InstOp.Fail);
  }

  // code-gauge-allow functionNcss 60 -- Transcribes Go's compile switch case by case.
  compile(re: Node): Frag {
    switch (re.op) {
      case Op.NoMatch: {
        return { i: 0, out: NO_PATCH, nullable: false };
      }
      case Op.EmptyMatch: {
        return this.nop();
      }
      case Op.Literal: {
        if (re.rune.length === 0) return this.nop();
        let f = this.rune([re.rune[0]], re.flags);
        for (let j = 1; j < re.rune.length; j++) f = this.cat(f, this.rune([re.rune[j]], re.flags));
        return f;
      }
      case Op.CharClass: {
        return this.rune(re.rune, re.flags);
      }
      case Op.AnyCharNotNL: {
        return this.rune(ANY_RUNE_NOT_NL, 0);
      }
      case Op.AnyChar: {
        return this.rune(ANY_RUNE, 0);
      }
      case Op.BeginLine: {
        return this.empty(EmptyOp.BeginLine);
      }
      case Op.EndLine: {
        return this.empty(EmptyOp.EndLine);
      }
      case Op.BeginText: {
        return this.empty(EmptyOp.BeginText);
      }
      case Op.EndText: {
        return this.empty(EmptyOp.EndText);
      }
      case Op.WordBoundary: {
        return this.empty(EmptyOp.WordBoundary);
      }
      case Op.NoWordBoundary: {
        return this.empty(EmptyOp.NoWordBoundary);
      }
      case Op.Capture: {
        const bra = this.cap(re.cap * 2);
        const sub = this.compile(re.sub[0]);
        const ket = this.cap(re.cap * 2 + 1);
        return this.cat(this.cat(bra, sub), ket);
      }
      case Op.Star: {
        return this.star(this.compile(re.sub[0]), (re.flags & Flag.NonGreedy) !== 0);
      }
      case Op.Plus: {
        return this.plus(this.compile(re.sub[0]), (re.flags & Flag.NonGreedy) !== 0);
      }
      case Op.Quest: {
        return this.quest(this.compile(re.sub[0]), (re.flags & Flag.NonGreedy) !== 0);
      }
      case Op.Concat: {
        if (re.sub.length === 0) return this.nop();
        let f = this.compile(re.sub[0]);
        for (let i = 1; i < re.sub.length; i++) f = this.cat(f, this.compile(re.sub[i]));
        return f;
      }
      case Op.Alternate: {
        let f: Frag = { i: 0, out: NO_PATCH, nullable: false };
        for (const sub of re.sub) f = this.alt(f, this.compile(sub));
        return f;
      }
    }
    throw new Error('regexp: unhandled case in compile');
  }

  inst(op: number): Frag {
    const f = { i: this.prog.inst.length, out: NO_PATCH, nullable: true };
    this.allocate(4);
    this.prog.inst.push({ op, out: 0, arg: 0, rune: [] });
    return f;
  }

  patch(list: PatchList, value: number): void {
    let head = list.head;
    while (head !== 0) {
      const inst = this.prog.inst[head >>> 1];
      if (head % 2 === 0) {
        head = inst.out;
        inst.out = value;
      } else {
        head = inst.arg;
        inst.arg = value;
      }
    }
  }

  private append(l1: PatchList, l2: PatchList): PatchList {
    if (l1.head === 0) return l2;
    if (l2.head === 0) return l1;
    const inst = this.prog.inst[l1.tail >>> 1];
    if (l1.tail % 2 === 0) inst.out = l2.head;
    else inst.arg = l2.head;
    return { head: l1.head, tail: l2.tail };
  }

  private nop(): Frag {
    const f = this.inst(InstOp.Nop);
    f.out = { head: f.i * 2, tail: f.i * 2 };
    return f;
  }

  private cap(arg: number): Frag {
    const f = this.inst(InstOp.Capture);
    f.out = { head: f.i * 2, tail: f.i * 2 };
    this.prog.inst[f.i].arg = arg;
    if (this.prog.numCap < arg + 1) this.prog.numCap = arg + 1;
    return f;
  }

  private cat(f1: Frag, f2: Frag): Frag {
    if (f1.i === 0 || f2.i === 0) return { i: 0, out: NO_PATCH, nullable: false };
    this.patch(f1.out, f2.i);
    return { i: f1.i, out: f2.out, nullable: f1.nullable && f2.nullable };
  }

  private alt(f1: Frag, f2: Frag): Frag {
    if (f1.i === 0) return f2;
    if (f2.i === 0) return f1;
    const f = this.inst(InstOp.Alt);
    const inst = this.prog.inst[f.i];
    inst.out = f1.i;
    inst.arg = f2.i;
    f.out = this.append(f1.out, f2.out);
    f.nullable = f1.nullable || f2.nullable;
    return f;
  }

  private quest(f1: Frag, nongreedy: boolean): Frag {
    const f = this.inst(InstOp.Alt);
    const inst = this.prog.inst[f.i];
    if (nongreedy) {
      inst.arg = f1.i;
      f.out = { head: f.i * 2, tail: f.i * 2 };
    } else {
      inst.out = f1.i;
      f.out = { head: f.i * 2 + 1, tail: f.i * 2 + 1 };
    }
    f.out = this.append(f.out, f1.out);
    return f;
  }

  private loop(f1: Frag, nongreedy: boolean): Frag {
    const f = this.inst(InstOp.Alt);
    const inst = this.prog.inst[f.i];
    if (nongreedy) {
      inst.arg = f1.i;
      f.out = { head: f.i * 2, tail: f.i * 2 };
    } else {
      inst.out = f1.i;
      f.out = { head: f.i * 2 + 1, tail: f.i * 2 + 1 };
    }
    this.patch(f1.out, f.i);
    return f;
  }

  private star(f1: Frag, nongreedy: boolean): Frag {
    if (f1.nullable) return this.quest(this.plus(f1, nongreedy), nongreedy);
    return this.loop(f1, nongreedy);
  }

  private plus(f1: Frag, nongreedy: boolean): Frag {
    return { i: f1.i, out: this.loop(f1, nongreedy).out, nullable: f1.nullable };
  }

  private empty(op: number): Frag {
    const f = this.inst(InstOp.EmptyWidth);
    this.prog.inst[f.i].arg = op;
    f.out = { head: f.i * 2, tail: f.i * 2 };
    return f;
  }

  private rune(r: RuneClass, flags: number): Frag {
    const f = this.inst(InstOp.Rune);
    f.nullable = false;
    const inst = this.prog.inst[f.i];
    inst.rune = r;
    this.allocate(r.length);
    let fold = flags & Flag.FoldCase;
    if (r.length !== 1 || simpleFold(r[0]) === r[0]) fold = 0;
    inst.arg = fold;
    f.out = { head: f.i * 2, tail: f.i * 2 };
    if (fold === 0 && (r.length === 1 || (r.length === 2 && r[0] === r[1]))) inst.op = InstOp.Rune1;
    else if (r.length === 2 && r[0] === 0 && r[1] === MAX_RUNE) inst.op = InstOp.RuneAny;
    else if (r.length === 4 && r[0] === 0 && r[1] === 9 && r[2] === 11 && r[3] === MAX_RUNE) {
      inst.op = InstOp.RuneAnyNotNL;
    }
    return f;
  }
}

// Program analysis ------------------------------------------------------------------------------------------------

export function isRuneOp(op: number): boolean {
  return op === InstOp.Rune || op === InstOp.Rune1 || op === InstOp.RuneAny || op === InstOp.RuneAnyNotNL;
}

function skipNop(prog: Prog, pc: number): Inst {
  let inst = prog.inst[pc];
  while (inst.op === InstOp.Nop || inst.op === InstOp.Capture) inst = prog.inst[inst.out];
  return inst;
}

/** Go's `(*Prog).Prefix`: the literal every match starts with, and whether it is the whole match. */
export function progPrefix(prog: Prog): { prefix: string; complete: boolean } {
  let inst = skipNop(prog, prog.start);
  if (!isRuneOp(inst.op) || inst.rune.length !== 1) return { prefix: '', complete: inst.op === InstOp.Match };
  let prefix = '';
  while (isLiteralRune(inst)) {
    prefix += encodeRune(inst.rune[0]);
    inst = skipNop(prog, inst.out);
  }
  return { prefix, complete: inst.op === InstOp.Match };
}

export function isLiteralRune(inst: Inst): boolean {
  return isRuneOp(inst.op) && inst.rune.length === 1 && (inst.arg & Flag.FoldCase) === 0 && inst.rune[0] !== RUNE_ERROR;
}

/** Go's `(*Prog).StartCond`: the empty-width conditions every match needs at its start. */
export function startCond(prog: Prog): number {
  let flag = 0;
  let inst = prog.inst[prog.start];
  for (;;) {
    if (inst.op === InstOp.EmptyWidth) flag |= inst.arg;
    else if (inst.op === InstOp.Fail) return IMPOSSIBLE;
    else if (inst.op !== InstOp.Capture && inst.op !== InstOp.Nop) return flag;
    inst = prog.inst[inst.out];
  }
}

/** Go's `(*Inst).MatchRunePos`: the index of the range containing the rune, or -1. */
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes Go's matchRunePos step by step.
// code-gauge-allow functionNcss 36 -- Transcribes Go's matchRunePos step by step.
export function matchRunePos(inst: Inst, r: number): number {
  const runes = inst.rune;
  switch (runes.length) {
    case 0: {
      return -1;
    }
    case 1: {
      const r0 = runes[0];
      if (r === r0) return 0;
      if (inst.arg & Flag.FoldCase) {
        for (let r1 = simpleFold(r0); r1 !== r0; r1 = simpleFold(r1)) if (r === r1) return 0;
      }
      return -1;
    }
    case 2: {
      return r >= runes[0] && r <= runes[1] ? 0 : -1;
    }
    case 4:
    case 6:
    case 8: {
      for (let j = 0; j < runes.length; j += 2) {
        if (r < runes[j]) return -1;
        if (r <= runes[j + 1]) return j / 2;
      }
      return -1;
    }
  }
  let lo = 0;
  let hi = runes.length / 2;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (runes[2 * m] <= r) {
      if (r <= runes[2 * m + 1]) return m;
      lo = m + 1;
    } else {
      hi = m;
    }
  }
  return -1;
}
