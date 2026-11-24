// code-gauge-allow-file fileNcss -- Keeps POSIX ERE parsing, NFA compilation, and single-pass tagged matching in one self-contained module.
/**
 * POSIX extended regular expressions as macOS's `regcomp` reads them for `[[ s =~ re ]]`: the leftmost match that is
 * longest, `.` matching any character, a backslash quoting the character after it, and no `\d`-style classes.
 */

import { charactersOf, POSIX_CHARACTER_CLASSES } from './characters';

type RegexNode =
  | { kind: 'char'; c: string }
  | { kind: 'any' }
  | { kind: 'set'; negated: boolean; test: (c: string) => boolean }
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'group'; index: number; body: RegexNode }
  | { kind: 'concat'; items: RegexNode[] }
  | { kind: 'alternation'; options: RegexNode[] }
  | { kind: 'repeat'; body: RegexNode; min: number; max: number };

/** A pattern that macOS rejects, with the message `regerror` gives. */
export class RegexSyntaxError extends Error {}

export interface CompiledRegex {
  root: RegexNode;
  groups: number;
  nfa?: CompiledNfa;
}

const CLASSES = POSIX_CHARACTER_CLASSES;

export function compileRegex(source: string): CompiledRegex {
  const parser = new RegexParser(charactersOf(source));
  const root = parser.parseAlternation();
  if (parser.position < parser.chars.length) throw new RegexSyntaxError('parentheses not balanced');
  return { root, groups: parser.groups };
}

class RegexParser {
  position = 0;
  groups = 0;

  constructor(readonly chars: string[]) {}

  parseAlternation(): RegexNode {
    const options = [this.parseConcat()];
    while (this.chars[this.position] === '|') {
      this.position++;
      options.push(this.parseConcat());
    }
    return options.length === 1 ? options[0] : { kind: 'alternation', options };
  }

  private parseConcat(): RegexNode {
    const items: RegexNode[] = [];
    for (;;) {
      const c = this.chars[this.position];
      if (c === undefined || c === '|' || c === ')') break;
      items.push(this.parseRepeat());
    }
    if (items.length === 0) throw new RegexSyntaxError('empty (sub)expression');
    return items.length === 1 ? items[0] : { kind: 'concat', items };
  }

  private parseRepeat(): RegexNode {
    let node = this.parseAtom();
    for (;;) {
      const c = this.chars[this.position];
      if (c === '*' || c === '+' || c === '?') {
        this.position++;
        node = { kind: 'repeat', body: node, min: c === '+' ? 1 : 0, max: c === '?' ? 1 : Infinity };
        continue;
      }
      if (c === '{') {
        const interval = this.interval();
        if (!interval) break;
        node = { kind: 'repeat', body: node, ...interval };
        continue;
      }
      break;
    }
    return node;
  }

  /** Reads `{n}`, `{n,}`, or `{n,m}`, or leaves a `{` that starts none of them as a literal character. */
  private interval(): { min: number; max: number } | undefined {
    const rest = this.chars.slice(this.position).join('');
    const match = /^\{(\d+)(,(\d*))?\}/.exec(rest);
    if (!match) {
      if (/^\{\d/.test(rest)) throw new RegexSyntaxError('braces not balanced');
      return undefined;
    }
    this.position += charactersOf(match[0]).length;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
    if (max < min || min > 255 || (max !== Infinity && max > 255))
      throw new RegexSyntaxError('invalid repetition count(s)');
    return { min, max };
  }

  // code-gauge-allow functionNcss -- One case per atom of a POSIX extended regular expression.
  private parseAtom(): RegexNode {
    const c = this.chars[this.position++];
    switch (c) {
      case '(': {
        const index = ++this.groups;
        if (this.chars[this.position] === ')') throw new RegexSyntaxError('empty (sub)expression');
        const body = this.parseAlternation();
        if (this.chars[this.position] !== ')') throw new RegexSyntaxError('parentheses not balanced');
        this.position++;
        return { kind: 'group', index, body };
      }
      case '*':
      case '+':
      case '?': {
        throw new RegexSyntaxError('repetition-operator operand invalid');
      }
      case '.': {
        return { kind: 'any' };
      }
      case '^': {
        return { kind: 'start' };
      }
      case '$': {
        return { kind: 'end' };
      }
      case '[': {
        return this.parseSet();
      }
      case '\\': {
        const next = this.chars[this.position++];
        if (next === undefined) throw new RegexSyntaxError(String.raw`trailing backslash (\)`);
        return { kind: 'char', c: next };
      }
      default: {
        return { kind: 'char', c: c as string };
      }
    }
  }

  private parseSet(): RegexNode {
    const tests: ((c: string) => boolean)[] = [];
    const negated = this.chars[this.position] === '^';
    if (negated) this.position++;
    let first = true;
    for (;;) {
      const c = this.chars[this.position];
      if (c === undefined) throw new RegexSyntaxError('brackets ([ ]) not balanced');
      if (c === ']' && !first) {
        this.position++;
        break;
      }
      first = false;
      const subbracket = this.tryParseSubbracket(c);
      if (subbracket) {
        tests.push(subbracket);
        continue;
      }
      this.position++;
      if (this.chars[this.position] === '-' && (this.chars[this.position + 1] ?? ']') !== ']') {
        const end = this.chars[this.position + 1];
        this.position += 2;
        tests.push(makeCodeRangeTest(c, end));
        continue;
      }
      tests.push((ch) => ch === c);
    }
    return { kind: 'set', negated, test: (ch) => tests.some((test) => test(ch)) };
  }

  private tryParseSubbracket(c: string): ((ch: string) => boolean) | undefined {
    const type = this.chars[this.position + 1];
    if (c !== '[' || (type !== ':' && type !== '=' && type !== '.')) return undefined;
    const rest = this.chars.slice(this.position + 2).join('');
    const close = rest.indexOf(`${type}]`);
    if (close === -1) throw new RegexSyntaxError('brackets ([ ]) not balanced');
    const name = rest.slice(0, close);
    this.position += 2 + charactersOf(name).length + 2;
    if (type !== ':') return (ch) => ch === name;
    const test = Object.hasOwn(CLASSES, name) ? CLASSES[name] : undefined;
    if (!test) throw new RegexSyntaxError('invalid character class');
    return test;
  }
}

function makeCodeRangeTest(startChar: string, endChar: string): (ch: string) => boolean {
  const low = startChar.codePointAt(0) as number;
  const high = endChar.codePointAt(0) as number;
  if (low > high) throw new RegexSyntaxError('invalid character range');
  return (ch) => {
    const code = ch.codePointAt(0) as number;
    return code >= low && code <= high;
  };
}

/** A match: the start and end of the whole match and of each group, by character index, or -1 when unset. */
export type RegexMatch = [number, number][];

type NfaState =
  | { kind: 'accept' }
  | { kind: 'char'; c: string; out: number }
  | { kind: 'any'; out: number }
  | { kind: 'set'; negated: boolean; test: (c: string) => boolean; out: number }
  | { kind: 'start'; out: number }
  | { kind: 'end'; out: number }
  | { kind: 'open'; slot: number; group: number; maxGroup: number; out: number }
  | { kind: 'close'; slot: number; group: number; out: number }
  | { kind: 'markIter'; iter: number; out: number }
  | { kind: 'checkIter'; iter: number; out: number }
  | { kind: 'split'; first: number; second: number };

interface CompiledNfa {
  entry: number;
  accept: number;
  states: NfaState[];
  groups: number;
  slotCount: number;
  iterCount: number;
}

/** 32 `(slot, start, end)` triples per chunk so `open` and `close` copy at most one 96-int block. */
const HISTORY_STRIDE = 3;
const ENTRIES_PER_CHUNK = 32;
const CHUNK_INTS = ENTRIES_PER_CHUNK * HISTORY_STRIDE;

interface Thread {
  start: number;
  captures: [number, number][];
  openPos: Int32Array;
  openEntry: Int32Array;
  iterStarts: Int32Array;
  chunks: readonly Int32Array[];
  entryCount: number;
}

/** Finds the leftmost-longest match, choosing among equally long ones the one whose earlier subpatterns are longer. */
// code-gauge-allow functionCognitiveComplexity -- Single-pass NFA simulation spawning start threads and pruning paths dominated by an earlier match.
export function searchRegex(regex: CompiledRegex, text: string, spend: () => void): RegexMatch | undefined {
  const nfa = (regex.nfa ??= buildNfa(regex, spend));
  const chars = charactersOf(text);
  let current: (Thread | undefined)[] = Array.from({ length: nfa.states.length });
  let bestEnd = -1;
  let bestThread: Thread | undefined;
  for (let pos = 0; pos <= chars.length; pos++) {
    spend();
    if (!bestThread) {
      const startThread = createStartThread(nfa, pos);
      const existing = current[nfa.entry];
      if (!existing || betterThread(startThread, existing)) current[nfa.entry] = startThread;
    }
    closeEpsilons(nfa, current, pos, chars.length, bestThread ? bestThread.start : Infinity, spend);
    const accepted = current[nfa.accept];
    if (
      accepted &&
      (!bestThread || accepted.start < bestThread.start || (accepted.start === bestThread.start && pos > bestEnd))
    ) {
      bestThread = accepted;
      bestEnd = pos;
    }
    if (pos === chars.length) break;
    current = stepChar(nfa, current, chars[pos], bestThread ? bestThread.start : Infinity, spend);
    if (bestThread && !current.some(Boolean)) break;
  }
  if (!bestThread) return undefined;
  const result: RegexMatch = [[bestThread.start, bestEnd]];
  for (let group = 1; group <= nfa.groups; group++) result.push(bestThread.captures[group]);
  return result;
}

function createStartThread(nfa: CompiledNfa, start: number): Thread {
  const openPos = new Int32Array(nfa.slotCount + 1).fill(-1);
  const openEntry = new Int32Array(nfa.slotCount + 1).fill(-1);
  const iterStarts = new Int32Array(nfa.iterCount).fill(-1);
  return {
    start,
    captures: Array.from({ length: nfa.groups + 1 }, () => [-1, -1]),
    openPos,
    openEntry,
    iterStarts,
    chunks: [],
    entryCount: 0,
  };
}

// code-gauge-allow functionCognitiveComplexity -- Relaxes epsilon transitions (splits, anchors, loop guards, and subpattern tags) in a single worklist pass.
// code-gauge-allow functionNcss -- Handles every epsilon state kind of the tagged NFA in one worklist pass.
function closeEpsilons(
  nfa: CompiledNfa,
  states: (Thread | undefined)[],
  pos: number,
  textLength: number,
  maxStart: number,
  spend: () => void
): void {
  const queue: number[] = [];
  const queued = new Uint8Array(nfa.states.length);
  for (let i = 0; i < states.length; i++) {
    const thread = states[i];
    if (!thread) continue;
    if (thread.start > maxStart) {
      states[i] = undefined;
      continue;
    }
    queue.push(i);
    queued[i] = 1;
  }
  const relax = (target: number, thread: Thread): void => {
    if (thread.start > maxStart) return;
    const existing = states[target];
    if (existing && !betterThread(thread, existing)) return;
    states[target] = thread;
    if (!queued[target]) {
      queued[target] = 1;
      queue.push(target);
    }
  };
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    queued[id] = 0;
    const thread = states[id];
    if (!thread || thread.start > maxStart) continue;
    spend();
    const state = nfa.states[id];
    switch (state.kind) {
      case 'split': {
        relax(state.first, thread);
        relax(state.second, thread);
        break;
      }
      case 'start': {
        if (pos === 0) relax(state.out, thread);
        break;
      }
      case 'end': {
        if (pos === textLength) relax(state.out, thread);
        break;
      }
      case 'markIter': {
        const iterStarts = new Int32Array(thread.iterStarts);
        iterStarts[state.iter] = pos;
        relax(state.out, { ...thread, iterStarts });
        break;
      }
      case 'checkIter': {
        if (pos > thread.iterStarts[state.iter]) relax(state.out, thread);
        break;
      }
      case 'open': {
        relax(state.out, openSubpattern(thread, state, pos));
        break;
      }
      case 'close': {
        relax(state.out, closeSubpattern(thread, state, pos));
        break;
      }
      default: {
        break;
      }
    }
  }
}

function openSubpattern(thread: Thread, state: Extract<NfaState, { kind: 'open' }>, pos: number): Thread {
  const entryIndex = thread.entryCount;
  const chunkIndex = entryIndex >> 5;
  const offset = (entryIndex & 31) * HISTORY_STRIDE;
  const chunks = [...thread.chunks];
  const chunk = chunkIndex < chunks.length ? new Int32Array(chunks[chunkIndex]) : new Int32Array(CHUNK_INTS);
  chunk[offset] = state.slot;
  chunk[offset + 1] = pos;
  chunk[offset + 2] = -1;
  chunks[chunkIndex] = chunk;
  const openPos = new Int32Array(thread.openPos);
  const openEntry = new Int32Array(thread.openEntry);
  openPos[state.slot] = pos;
  openEntry[state.slot] = entryIndex;
  let { captures } = thread;
  if (state.group > 0) {
    captures = [...captures];
    for (let g = state.group; g <= state.maxGroup; g++) captures[g] = [-1, -1];
  }
  return { ...thread, captures, openPos, openEntry, chunks, entryCount: entryIndex + 1 };
}

function closeSubpattern(thread: Thread, state: Extract<NfaState, { kind: 'close' }>, pos: number): Thread {
  const entryIndex = thread.openEntry[state.slot];
  const startPos = thread.openPos[state.slot];
  const chunkIndex = entryIndex >> 5;
  const offset = (entryIndex & 31) * HISTORY_STRIDE;
  const chunks = [...thread.chunks];
  const chunk = new Int32Array(chunks[chunkIndex]);
  chunk[offset + 2] = pos;
  chunks[chunkIndex] = chunk;
  let { captures } = thread;
  if (state.group > 0) {
    captures = [...captures];
    captures[state.group] = [startPos, pos];
  }
  return { ...thread, captures, chunks };
}

function stepChar(
  nfa: CompiledNfa,
  current: (Thread | undefined)[],
  ch: string,
  maxStart: number,
  spend: () => void
): (Thread | undefined)[] {
  const next: (Thread | undefined)[] = Array.from({ length: nfa.states.length });
  const advance = (target: number, thread: Thread): void => {
    const existing = next[target];
    if (!existing || betterThread(thread, existing)) next[target] = thread;
  };
  for (let id = 0; id < current.length; id++) {
    const thread = current[id];
    if (!thread || thread.start > maxStart) continue;
    spend();
    const state = nfa.states[id];
    if (state.kind === 'char' && ch === state.c) advance(state.out, thread);
    else if (state.kind === 'any') advance(state.out, thread);
    else if (state.kind === 'set' && state.test(ch) !== state.negated) advance(state.out, thread);
  }
  return next;
}

// code-gauge-allow functionCognitiveComplexity -- Compares overall start index and then pre-order subexpression history chunk by chunk.
// code-gauge-allow functionNcss -- Compares overall start index and chunked (slot, start, end) subexpression triples.
function betterThread(candidate: Thread, existing: Thread): boolean {
  if (candidate.start !== existing.start) return candidate.start < existing.start;
  const minEntries = Math.min(candidate.entryCount, existing.entryCount);
  const fullChunks = minEntries >> 5;
  for (let c = 0; c <= fullChunks; c++) {
    const limit = c < fullChunks ? ENTRIES_PER_CHUNK : minEntries & 31;
    if (limit === 0) break;
    const cChunk = candidate.chunks[c];
    const bChunk = existing.chunks[c];
    if (c < fullChunks && cChunk === bChunk) continue;
    for (let i = 0; i < limit; i++) {
      const base = i * HISTORY_STRIDE;
      const cSlot = cChunk[base];
      const bSlot = bChunk[base];
      if (cSlot !== bSlot) return cSlot < bSlot;
      const cs = cChunk[base + 1];
      const bs = bChunk[base + 1];
      if (cs !== bs) return cs < bs;
      const ce = cChunk[base + 2];
      const be = bChunk[base + 2];
      if (ce === be) continue;
      if (ce === -1) return true;
      if (be === -1) return false;
      return ce > be;
    }
  }
  return candidate.entryCount > existing.entryCount;
}

interface NfaBuilder {
  states: NfaState[];
  slotMap: SlotAssignment;
  trackCaptures: boolean;
  nextIter: number;
  add: (state: NfaState) => number;
}

function buildNfa(regex: CompiledRegex, spend: () => void): CompiledNfa {
  const states: NfaState[] = [];
  const trackCaptures = regex.groups > 0;
  const slotMap = trackCaptures ? assignSlots(regex.root) : { count: 0, rangeOf: new Map(), optionSlots: new Map() };
  const add = (state: NfaState): number => {
    spend();
    const id = states.length;
    states.push(state);
    return id;
  };
  const builder: NfaBuilder = { states, slotMap, trackCaptures, nextIter: 0, add };
  const accept = add({ kind: 'accept' });
  const entry = compileNode(regex.root, accept, builder);
  return { entry, accept, states, groups: regex.groups, slotCount: slotMap.count, iterCount: builder.nextIter };
}

interface SlotAssignment {
  count: number;
  rangeOf: Map<RegexNode, { slot: number; maxGroup: number }>;
  optionSlots: Map<RegexNode, number[]>;
}

// code-gauge-allow functionCognitiveComplexity -- Assigns pre-order subexpression slots across groups, repetitions, concatenations, and alternations.
function assignSlots(root: RegexNode): SlotAssignment {
  let count = 0;
  let maxSeenGroup = 0;
  const rangeOf = new Map<RegexNode, { slot: number; maxGroup: number }>();
  const optionSlots = new Map<RegexNode, number[]>();
  const visit = (node: RegexNode): void => {
    if (node.kind === 'group' || node.kind === 'repeat') {
      const slot = ++count;
      if (node.kind === 'group' && node.index > maxSeenGroup) maxSeenGroup = node.index;
      visit(node.body);
      rangeOf.set(node, { slot, maxGroup: maxSeenGroup });
      return;
    }
    if (node.kind === 'concat') {
      for (const item of node.items) visit(item);
      return;
    }
    if (node.kind === 'alternation') {
      const slots: number[] = [];
      for (const option of node.options) {
        slots.push(++count);
        visit(option);
      }
      optionSlots.set(node, slots);
    }
  };
  visit(root);
  return { count, rangeOf, optionSlots };
}

// code-gauge-allow functionNcss -- Compiles each regex AST node kind into Thompson NFA states with POSIX subpattern tags.
function compileNode(node: RegexNode, out: number, builder: NfaBuilder): number {
  const { add, slotMap, trackCaptures } = builder;
  switch (node.kind) {
    case 'char': {
      return add({ kind: 'char', c: node.c, out });
    }
    case 'any': {
      return add({ kind: 'any', out });
    }
    case 'set': {
      return add({ kind: 'set', negated: node.negated, test: node.test, out });
    }
    case 'start': {
      return add({ kind: 'start', out });
    }
    case 'end': {
      return add({ kind: 'end', out });
    }
    case 'group': {
      const info = slotMap.rangeOf.get(node) as { slot: number; maxGroup: number };
      const close = add({ kind: 'close', slot: info.slot, group: node.index, out });
      const body = compileNode(node.body, close, builder);
      return add({ kind: 'open', slot: info.slot, group: node.index, maxGroup: info.maxGroup, out: body });
    }
    case 'concat': {
      let next = out;
      for (let i = node.items.length - 1; i >= 0; i--) next = compileNode(node.items[i], next, builder);
      return next;
    }
    case 'alternation': {
      const slots = slotMap.optionSlots.get(node);
      const wrapOption = (option: RegexNode, index: number): number => {
        if (!trackCaptures || !slots) return compileNode(option, out, builder);
        const slot = slots[index];
        const close = add({ kind: 'close', slot, group: 0, out });
        const body = compileNode(option, close, builder);
        return add({ kind: 'open', slot, group: 0, maxGroup: 0, out: body });
      };
      let next = wrapOption(node.options.at(-1) as RegexNode, node.options.length - 1);
      for (let i = node.options.length - 2; i >= 0; i--) {
        const branch = wrapOption(node.options[i], i);
        next = add({ kind: 'split', first: branch, second: next });
      }
      return next;
    }
    case 'repeat': {
      if (!trackCaptures) return compileRepeat(node.body, node.min, node.max, out, builder);
      const info = slotMap.rangeOf.get(node) as { slot: number; maxGroup: number };
      const close = add({ kind: 'close', slot: info.slot, group: 0, out });
      const bodyEntry = compileRepeat(node.body, node.min, node.max, close, builder);
      return add({ kind: 'open', slot: info.slot, group: 0, maxGroup: 0, out: bodyEntry });
    }
  }
}

function compileRepeat(body: RegexNode, min: number, max: number, out: number, builder: NfaBuilder): number {
  let next = out;
  if (max === Infinity) {
    const iter = builder.nextIter++;
    const split = builder.add({ kind: 'split', first: 0, second: out });
    const check = builder.add({ kind: 'checkIter', iter, out: split });
    const iterBody = compileNode(body, check, builder);
    const mark = builder.add({ kind: 'markIter', iter, out: iterBody });
    (builder.states[split] as Extract<NfaState, { kind: 'split' }>).first = mark;
    next = split;
  } else {
    for (let i = 0; i < max - min; i++) {
      const iter = builder.nextIter++;
      const check = builder.add({ kind: 'checkIter', iter, out: next });
      const iterBody = compileNode(body, check, builder);
      const mark = builder.add({ kind: 'markIter', iter, out: iterBody });
      next = builder.add({ kind: 'split', first: mark, second: next });
    }
  }
  for (let i = 0; i < min; i++) next = compileNode(body, next, builder);
  return next;
}
