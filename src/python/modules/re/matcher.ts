// code-gauge-allow-file fileNcss 553 -- Transcribes one C file of CPython, Modules/_sre/sre_lib.h.
// A transcription of CPython's `_sre` matcher (Modules/_sre/sre_lib.h): a backtracking machine whose contexts live on
// an explicit stack, so that deep backtracking needs no host recursion. Each context is a generator that yields the
// context it calls and receives whether that context matched.
import { pyError } from '../../types';
import type { Charset, Program } from './compiler';
import { AT, CATEGORY, MAXREPEAT, OP } from './constants';
import {
  asciiLower,
  isAsciiSpace,
  isAsciiWord,
  unicodeIsDecimal,
  unicodeIsSpace,
  unicodeIsWord,
  unicodeLower,
  unicodeUpper,
} from './unicodeData';

const MAX_CONTEXTS = 100_000;

const SINGLE_CHARACTER_OPS = new Set<number>([
  OP.LITERAL,
  OP.NOT_LITERAL,
  OP.LITERAL_IGNORE,
  OP.NOT_LITERAL_IGNORE,
  OP.LITERAL_UNI_IGNORE,
  OP.NOT_LITERAL_UNI_IGNORE,
  OP.ANY,
  OP.ANY_ALL,
  OP.CATEGORY,
  OP.IN,
  OP.IN_IGNORE,
  OP.IN_UNI_IGNORE,
]);

interface Repeat {
  count: number;
  /** The position of the repeat's skip in the code, after which come its minimum, maximum, and body. */
  pc: number;
  lastPtr: number;
  prev: Repeat | undefined;
}

interface Call {
  pc: number;
  toplevel: boolean;
}

type Context = Generator<Call, boolean, boolean>;

/** What a handler that does not end its context returns: where matching continues. */
interface Next {
  pc: number;
  ptr: number;
}

export interface Budget {
  /** Charges `count` matcher steps, throwing when the run exceeds its limits. */
  charge(count: number): void;
}

/** The state of one match attempt over a string, as `SRE_STATE`: positions are indices into `text`. */
export class MatchState {
  start: number;
  end: number;
  ptr: number;
  marks: number[] = [];
  lastmark = -1;
  lastindex = -1;
  repeat: Repeat | undefined;
  matchAll = false;
  mustAdvance = false;
  readonly beginning = 0;
  readonly pos: number;
  readonly endpos: number;

  constructor(
    readonly text: number[],
    pos: number,
    endpos: number
  ) {
    this.pos = Math.min(Math.max(pos, 0), text.length);
    this.endpos = Math.min(Math.max(endpos, 0), text.length);
    this.start = this.pos;
    this.end = this.endpos;
    this.ptr = this.start;
  }

  reset(): void {
    this.lastmark = -1;
    this.lastindex = -1;
    this.repeat = undefined;
  }

  /** The span of group `index` (1-based), or [-1, -1] when it did not participate. */
  groupSpan(index: number): [number, number] {
    const j = (index - 1) * 2;
    if (j + 1 <= this.lastmark && this.marks[j] >= 0 && this.marks[j + 1] >= 0)
      return [this.marks[j], this.marks[j + 1]];
    return [-1, -1];
  }
}

export class Matcher {
  private readonly code: number[];
  private readonly charsets: Charset[];

  constructor(
    private readonly program: Program,
    readonly state: MatchState,
    private readonly budget: Budget
  ) {
    this.code = program.code;
    this.charsets = program.charsets;
  }

  /** `sre_match`: matches at `state.start`. */
  match(): boolean {
    this.state.ptr = this.state.start;
    return this.execute(0, true);
  }

  /** `sre_search`: finds the first position from `state.start` where the pattern matches. */
  search(): boolean {
    const { state } = this;
    let ptr = state.start;
    const { end, text } = state;
    if (ptr > end) return false;
    const { searchCharset } = this.program;
    // CPython tries only the positions whose character may start a match, which `searchCharset` gives.
    const skip = (at: number): boolean =>
      searchCharset !== undefined && (at >= end || !this.inCharset(searchCharset, text[at]));
    let matched = false;
    if (!skip(ptr)) {
      state.ptr = ptr;
      matched = this.execute(0, true);
    }
    state.mustAdvance = false;
    const [first, at] = this.code;
    if (!matched && first === OP.AT && (at === AT.BEGINNING || at === AT.BEGINNING_STRING)) {
      state.start = end;
      state.ptr = end;
      return false;
    }
    while (!matched && ptr < end) {
      ptr++;
      this.budget.charge(1);
      if (skip(ptr)) continue;
      state.reset();
      state.start = ptr;
      state.ptr = ptr;
      matched = this.execute(0, false);
    }
    return matched;
  }

  private execute(pc: number, toplevel: boolean): boolean {
    const stack: Context[] = [this.run(pc, toplevel)];
    let result = false;
    while (stack.length > 0) {
      const step = (stack.at(-1) as Context).next(result);
      if (step.done) {
        stack.pop();
        result = step.value;
      } else {
        this.budget.charge(2);
        // CPython keeps these contexts on the heap without a limit; this bounds the memory of one run.
        if (stack.length >= MAX_CONTEXTS) throw pyError('MemoryError');
        stack.push(this.run(step.value.pc, step.value.toplevel));
      }
    }
    return result;
  }

  /** A context of SRE(match): runs the code from `startPc` at `state.ptr` until it matches or fails. */
  // code-gauge-allow functionNcss 36 -- Mirrors the opcode dispatch loop of SRE(match).
  private *run(startPc: number, toplevel: boolean): Context {
    const { code } = this;
    let pc = startPc;
    let ptr = this.state.ptr;
    for (;;) {
      this.budget.charge(1);
      const op = code[pc++];
      let next = this.step(op, pc, ptr, toplevel);
      if (next === undefined) {
        switch (op) {
          case OP.BRANCH: {
            return yield* this.branch(pc, ptr, toplevel);
          }
          case OP.REPEAT_ONE: {
            return yield* this.repeatOne(pc, ptr, toplevel);
          }
          case OP.MIN_REPEAT_ONE: {
            return yield* this.minRepeatOne(pc, ptr, toplevel);
          }
          case OP.REPEAT: {
            return yield* this.repeat(pc, ptr, toplevel);
          }
          case OP.MAX_UNTIL: {
            return yield* this.maxUntil(pc, ptr, toplevel);
          }
          case OP.MIN_UNTIL: {
            return yield* this.minUntil(pc, ptr, toplevel);
          }
          case OP.POSSESSIVE_REPEAT: {
            next = yield* this.possessiveRepeat(pc, ptr);
            break;
          }
          case OP.ATOMIC_GROUP: {
            next = yield* this.atomicGroup(pc, ptr);
            break;
          }
          case OP.ASSERT: {
            next = yield* this.assert(pc, ptr);
            break;
          }
          default: {
            next = yield* this.assertNot(pc, ptr);
          }
        }
      }
      if (typeof next === 'boolean') return next;
      ({ pc, ptr } = next);
    }
  }

  /**
   * Runs an opcode that calls no other context: the position to continue at, or whether the context ends matched;
   * undefined for the opcodes that call other contexts.
   */
  // code-gauge-allow functionNcss 31 -- One case per opcode, as the dispatch loop of SRE(match) has.
  private step(op: number, pc: number, ptr: number, toplevel: boolean): Next | boolean | undefined {
    const { state, code } = this;
    switch (op) {
      case OP.SUCCESS: {
        if (toplevel && ((state.matchAll && ptr !== state.end) || (state.mustAdvance && ptr === state.start)))
          return false;
        state.ptr = ptr;
        return true;
      }
      case OP.FAILURE: {
        return false;
      }
      case OP.MARK: {
        this.mark(code[pc], ptr);
        return { pc: pc + 1, ptr };
      }
      case OP.AT: {
        return this.at(ptr, code[pc]) && { pc: pc + 1, ptr };
      }
      case OP.JUMP: {
        return { pc: pc + code[pc], ptr };
      }
      case OP.POSSESSIVE_REPEAT_ONE: {
        return this.possessiveRepeatOne(pc, ptr);
      }
      case OP.GROUPREF:
      case OP.GROUPREF_IGNORE:
      case OP.GROUPREF_UNI_IGNORE: {
        return this.groupref(op, pc, ptr);
      }
      case OP.GROUPREF_EXISTS: {
        return { pc: this.groupMatched(code[pc]) ? pc + 2 : pc + code[pc + 1], ptr };
      }
      default: {
        if (!SINGLE_CHARACTER_OPS.has(op)) return undefined;
        if (ptr >= state.end || !this.single(pc - 1, state.text[ptr])) return false;
        return { pc: pc + argumentLength(op, code[pc]), ptr: ptr + 1 };
      }
    }
  }

  private mark(index: number, ptr: number): void {
    const { state } = this;
    if (index & 1) state.lastindex = (index >> 1) + 1;
    if (index > state.lastmark) {
      for (let j = state.lastmark + 1; j < index; j++) state.marks[j] = -1;
      state.lastmark = index;
    }
    state.marks[index] = ptr;
  }

  private saveMarks(lastmark: number): number[] | undefined {
    return lastmark < 0 ? undefined : this.state.marks.slice(0, lastmark + 1);
  }

  private restoreMarks(saved: number[] | undefined): void {
    if (!saved) return;
    for (const [index, value] of saved.entries()) this.state.marks[index] = value;
  }

  /** Whether the single-character opcode at `pc` matches `char`, for the opcodes that `_simple` admits. */
  private single(pc: number, char: number): boolean {
    const { code } = this;
    const argument = code[pc + 1];
    switch (code[pc]) {
      case OP.LITERAL: {
        return char === argument;
      }
      case OP.NOT_LITERAL: {
        return char !== argument;
      }
      case OP.LITERAL_IGNORE: {
        return asciiLower(char) === argument;
      }
      case OP.NOT_LITERAL_IGNORE: {
        return asciiLower(char) !== argument;
      }
      case OP.LITERAL_UNI_IGNORE: {
        return unicodeLower(char) === argument;
      }
      case OP.NOT_LITERAL_UNI_IGNORE: {
        return unicodeLower(char) !== argument;
      }
      case OP.ANY: {
        return char !== 0x0a;
      }
      case OP.ANY_ALL: {
        return true;
      }
      case OP.CATEGORY: {
        return category(argument, char);
      }
      case OP.IN: {
        return this.inCharset(code[pc + 2], char);
      }
      case OP.IN_IGNORE: {
        return this.inCharset(code[pc + 2], asciiLower(char));
      }
      case OP.IN_UNI_IGNORE: {
        return this.inCharset(code[pc + 2], unicodeLower(char));
      }
      default: {
        return false;
      }
    }
  }

  private inCharset(index: number, char: number): boolean {
    const charset = this.charsets[index];
    let found = charset.lowered?.has(char) === true || charset.literals?.has(char) === true;
    if (!found) {
      for (let i = 0; i < charset.items.length; i++) {
        if ((i & 7) === 0) this.budget.charge(1);
        if (charsetItemHas(charset.items[i], char)) {
          found = true;
          break;
        }
      }
    }
    return found !== charset.negate;
  }

  private at(ptr: number, at: number): boolean {
    const { state } = this;
    const { text, end } = state;
    switch (at) {
      case AT.BEGINNING:
      case AT.BEGINNING_STRING: {
        return ptr === state.beginning;
      }
      case AT.BEGINNING_LINE: {
        return ptr === state.beginning || text[ptr - 1] === 0x0a;
      }
      case AT.END: {
        return (end - ptr === 1 && text[ptr] === 0x0a) || ptr === end;
      }
      case AT.END_LINE: {
        return ptr === end || text[ptr] === 0x0a;
      }
      case AT.END_STRING: {
        return ptr === end;
      }
      default: {
        const isWord = at === AT.UNI_BOUNDARY || at === AT.UNI_NON_BOUNDARY ? unicodeIsWord : isAsciiWord;
        const before = ptr > state.beginning && isWord(text[ptr - 1]);
        const after = ptr < end && isWord(text[ptr]);
        return at === AT.BOUNDARY || at === AT.UNI_BOUNDARY ? before !== after : before === after;
      }
    }
  }

  /** `SRE(count)`: how many times, up to `maxcount`, the single-character item at `pc` matches from `state.ptr`. */
  private count(pc: number, maxcount: number): number {
    const { state } = this;
    const start = state.ptr;
    let end = state.end;
    if (maxcount < end - start && maxcount !== MAXREPEAT) end = start + maxcount;
    let ptr = start;
    while (ptr < end && this.single(pc, state.text[ptr])) {
      ptr++;
      if (((ptr - start) & 15) === 0) this.budget.charge(1);
    }
    this.budget.charge(1);
    return ptr - start;
  }

  private groupMatched(group: number): boolean {
    const { state } = this;
    const groupref = group + group;
    if (groupref >= state.lastmark) return false;
    const start = state.marks[groupref];
    const end = state.marks[groupref + 1];
    return start >= 0 && end >= 0 && end >= start;
  }

  private groupref(op: number, pc: number, ptr: number): Next | false {
    const { state } = this;
    const groupref = this.code[pc] * 2;
    if (groupref >= state.lastmark) return false;
    let p = state.marks[groupref];
    const e = state.marks[groupref + 1];
    if (p < 0 || e < 0 || e < p) return false;
    const fold = op === OP.GROUPREF ? undefined : op === OP.GROUPREF_IGNORE ? asciiLower : unicodeLower;
    let at = ptr;
    for (; p < e; p++, at++) {
      if (at >= state.end) return false;
      const [left, right] = [state.text[at], state.text[p]];
      if (fold ? fold(left) !== fold(right) : left !== right) return false;
    }
    this.budget.charge(Math.ceil((at - ptr) / 16));
    return { pc: pc + 1, ptr: at };
  }

  private *branch(pc: number, ptr: number, toplevel: boolean): Context {
    const { state, code } = this;
    const { lastmark, lastindex } = state;
    const saved = state.repeat ? this.saveMarks(lastmark) : undefined;
    for (let at = pc; code[at]; at += code[at]) {
      if (code[at + 1] === OP.LITERAL && (ptr >= state.end || state.text[ptr] !== code[at + 2])) continue;
      if (code[at + 1] === OP.IN && (ptr >= state.end || !this.inCharset(code[at + 3], state.text[ptr]))) continue;
      state.ptr = ptr;
      if (yield { pc: at + 1, toplevel }) return true;
      this.restoreMarks(saved);
      state.lastmark = lastmark;
      state.lastindex = lastindex;
    }
    return false;
  }

  // code-gauge-allow functionNcss 32 -- Transcribes REPEAT_ONE of SRE(match) with its literal-tail shortcut.
  // code-gauge-allow functionCognitiveComplexity 19 -- Transcribes REPEAT_ONE of SRE(match) with its literal-tail shortcut.
  private *repeatOne(pc: number, start: number, toplevel: boolean): Context {
    const { state, code } = this;
    const [min, max] = [code[pc + 1], code[pc + 2]];
    if (min > state.end - start) return false;
    state.ptr = start;
    let count = this.count(pc + 3, max);
    let ptr = start + count;
    if (count < min) return false;
    const tail = pc + code[pc];
    if (code[tail] === OP.SUCCESS && ptr === state.end && !(toplevel && state.mustAdvance && ptr === state.start)) {
      state.ptr = ptr;
      return true;
    }
    const { lastmark, lastindex } = state;
    const saved = state.repeat ? this.saveMarks(lastmark) : undefined;
    const literalTail = code[tail] === OP.LITERAL ? code[tail + 1] : undefined;
    for (;;) {
      if (literalTail !== undefined) {
        while (count >= min && (ptr >= state.end || state.text[ptr] !== literalTail)) {
          ptr--;
          count--;
        }
      }
      if (count < min) return false;
      state.ptr = ptr;
      if (yield { pc: tail, toplevel }) return true;
      this.restoreMarks(saved);
      state.lastmark = lastmark;
      state.lastindex = lastindex;
      ptr--;
      count--;
    }
  }

  // code-gauge-allow functionNcss 33 -- Transcribes MIN_REPEAT_ONE of SRE(match).
  // code-gauge-allow functionCognitiveComplexity 17 -- Transcribes MIN_REPEAT_ONE of SRE(match).
  private *minRepeatOne(pc: number, start: number, toplevel: boolean): Context {
    const { state, code } = this;
    const [min, max] = [code[pc + 1], code[pc + 2]];
    if (min > state.end - start) return false;
    state.ptr = start;
    let ptr = start;
    let count = 0;
    if (min > 0) {
      count = this.count(pc + 3, min);
      if (count < min) return false;
      ptr += count;
    }
    const tail = pc + code[pc];
    const tailFails = toplevel && ((state.matchAll && ptr !== state.end) || (state.mustAdvance && ptr === state.start));
    if (code[tail] === OP.SUCCESS && !tailFails) {
      state.ptr = ptr;
      return true;
    }
    const { lastmark, lastindex } = state;
    const saved = state.repeat ? this.saveMarks(lastmark) : undefined;
    while (max === MAXREPEAT || count <= max) {
      state.ptr = ptr;
      if (yield { pc: tail, toplevel }) return true;
      this.restoreMarks(saved);
      state.ptr = ptr;
      if (this.count(pc + 3, 1) === 0) break;
      ptr++;
      count++;
      state.lastmark = lastmark;
      state.lastindex = lastindex;
    }
    return false;
  }

  private possessiveRepeatOne(pc: number, start: number): Next | false {
    const { state, code } = this;
    if (code[pc + 1] > state.end - start) return false;
    state.ptr = start;
    const count = this.count(pc + 3, code[pc + 2]);
    if (count < code[pc + 1]) return false;
    return { pc: pc + code[pc], ptr: start + count };
  }

  private *repeat(pc: number, ptr: number, toplevel: boolean): Context {
    const { state } = this;
    const repeat: Repeat = { count: -1, pc, lastPtr: -1, prev: state.repeat };
    state.repeat = repeat;
    state.ptr = ptr;
    const matched = yield { pc: pc + this.code[pc], toplevel };
    state.repeat = repeat.prev;
    return matched;
  }

  // code-gauge-allow functionNcss 35 -- Transcribes MAX_UNTIL of SRE(match) with its zero-width match protection.
  private *maxUntil(pc: number, ptr: number, toplevel: boolean): Context {
    const { state, code } = this;
    const repeat = state.repeat as Repeat;
    state.ptr = ptr;
    const count = repeat.count + 1;
    const [min, max] = [code[repeat.pc + 1], code[repeat.pc + 2]];
    if (count < min) {
      repeat.count = count;
      if (yield { pc: repeat.pc + 3, toplevel }) return true;
      repeat.count = count - 1;
      state.ptr = ptr;
      return false;
    }
    if ((count < max || max === MAXREPEAT) && state.ptr !== repeat.lastPtr) {
      repeat.count = count;
      const { lastmark, lastindex } = state;
      const saved = this.saveMarks(lastmark);
      const lastPtr = repeat.lastPtr;
      repeat.lastPtr = state.ptr;
      const matched = yield { pc: repeat.pc + 3, toplevel };
      repeat.lastPtr = lastPtr;
      if (matched) return true;
      this.restoreMarks(saved);
      state.lastmark = lastmark;
      state.lastindex = lastindex;
      repeat.count = count - 1;
      state.ptr = ptr;
    }
    state.repeat = repeat.prev;
    const matched = yield { pc, toplevel };
    state.repeat = repeat;
    if (matched) return true;
    state.ptr = ptr;
    return false;
  }

  // code-gauge-allow functionNcss 38 -- Transcribes MIN_UNTIL of SRE(match) with its zero-width match protection.
  private *minUntil(pc: number, ptr: number, toplevel: boolean): Context {
    const { state, code } = this;
    const repeat = state.repeat as Repeat;
    state.ptr = ptr;
    const count = repeat.count + 1;
    const [min, max] = [code[repeat.pc + 1], code[repeat.pc + 2]];
    if (count < min) {
      repeat.count = count;
      if (yield { pc: repeat.pc + 3, toplevel }) return true;
      repeat.count = count - 1;
      state.ptr = ptr;
      return false;
    }
    state.repeat = repeat.prev;
    const { lastmark, lastindex } = state;
    const saved = state.repeat ? this.saveMarks(lastmark) : undefined;
    const tailMatched = yield { pc, toplevel };
    const repeatOfTail = state.repeat;
    state.repeat = repeat;
    if (tailMatched) return true;
    if (repeatOfTail) this.restoreMarks(saved);
    state.lastmark = lastmark;
    state.lastindex = lastindex;
    state.ptr = ptr;
    if ((count >= max && max !== MAXREPEAT) || state.ptr === repeat.lastPtr) return false;
    repeat.count = count;
    const lastPtr = repeat.lastPtr;
    repeat.lastPtr = state.ptr;
    const matched = yield { pc: repeat.pc + 3, toplevel };
    repeat.lastPtr = lastPtr;
    if (matched) return true;
    repeat.count = count - 1;
    state.ptr = ptr;
    return false;
  }

  private *possessiveRepeat(pc: number, ptr: number): Generator<Call, Next | false, boolean> {
    const { state, code } = this;
    const [min, max] = [code[pc + 1], code[pc + 2]];
    state.ptr = ptr;
    const repeat: Repeat = { count: -1, pc: -1, lastPtr: -1, prev: state.repeat };
    state.repeat = repeat;
    let count = 0;
    while (count < min) {
      if (!(yield { pc: pc + 3, toplevel: false })) {
        state.ptr = ptr;
        state.repeat = repeat.prev;
        return false;
      }
      count++;
    }
    let iterationStart = -1;
    while ((count < max || max === MAXREPEAT) && state.ptr !== iterationStart) {
      const { lastmark, lastindex } = state;
      const saved = this.saveMarks(lastmark);
      iterationStart = state.ptr;
      if (!(yield { pc: pc + 3, toplevel: false })) {
        this.restoreMarks(saved);
        state.lastmark = lastmark;
        state.lastindex = lastindex;
        state.ptr = iterationStart;
        break;
      }
      count++;
    }
    state.repeat = repeat.prev;
    return { pc: pc + code[pc] + 1, ptr: state.ptr };
  }

  private *atomicGroup(pc: number, ptr: number): Generator<Call, Next | false, boolean> {
    const { state } = this;
    state.ptr = ptr;
    if (!(yield { pc: pc + 1, toplevel: false })) {
      state.ptr = ptr;
      return false;
    }
    return { pc: pc + this.code[pc], ptr: state.ptr };
  }

  private *assert(pc: number, ptr: number): Generator<Call, Next | false, boolean> {
    const { state, code } = this;
    const back = code[pc + 1];
    if (ptr - state.beginning < back) return false;
    state.ptr = ptr - back;
    if (!(yield { pc: pc + 2, toplevel: false })) return false;
    return { pc: pc + code[pc], ptr };
  }

  private *assertNot(pc: number, ptr: number): Generator<Call, Next | false, boolean> {
    const { state, code } = this;
    const back = code[pc + 1];
    if (ptr - state.beginning >= back) {
      state.ptr = ptr - back;
      const { lastmark, lastindex } = state;
      const saved = state.repeat ? this.saveMarks(lastmark) : undefined;
      if (yield { pc: pc + 2, toplevel: false }) return false;
      this.restoreMarks(saved);
      state.lastmark = lastmark;
      state.lastindex = lastindex;
    }
    return { pc: pc + code[pc], ptr };
  }
}

/** The number of code words after a single-character opcode, which a set's skip gives. */
function argumentLength(op: number, skip: number): number {
  if (op === OP.IN || op === OP.IN_IGNORE || op === OP.IN_UNI_IGNORE) return skip;
  return op === OP.ANY || op === OP.ANY_ALL ? 0 : 1;
}

function charsetItemHas(item: Charset['items'][number], char: number): boolean {
  switch (item.op) {
    case 'LITERAL': {
      return char === item.code;
    }
    case 'RANGE': {
      return item.lo <= char && char <= item.hi;
    }
    case 'RANGE_UNI_IGNORE': {
      if (item.lo <= char && char <= item.hi) return true;
      const upper = unicodeUpper(char);
      return item.lo <= upper && upper <= item.hi;
    }
    case 'CATEGORY': {
      return category(item.category, char);
    }
  }
}

function category(code: number, char: number): boolean {
  switch (code) {
    case CATEGORY.DIGIT: {
      return char >= 0x30 && char <= 0x39;
    }
    case CATEGORY.NOT_DIGIT: {
      return !(char >= 0x30 && char <= 0x39);
    }
    case CATEGORY.SPACE: {
      return isAsciiSpace(char);
    }
    case CATEGORY.NOT_SPACE: {
      return !isAsciiSpace(char);
    }
    case CATEGORY.WORD: {
      return isAsciiWord(char);
    }
    case CATEGORY.NOT_WORD: {
      return !isAsciiWord(char);
    }
    case CATEGORY.UNI_DIGIT: {
      return unicodeIsDecimal(char);
    }
    case CATEGORY.UNI_NOT_DIGIT: {
      return !unicodeIsDecimal(char);
    }
    case CATEGORY.UNI_SPACE: {
      return unicodeIsSpace(char);
    }
    case CATEGORY.UNI_NOT_SPACE: {
      return !unicodeIsSpace(char);
    }
    case CATEGORY.UNI_WORD: {
      return unicodeIsWord(char) || char === 0x5f;
    }
    default: {
      return !(unicodeIsWord(char) || char === 0x5f);
    }
  }
}
