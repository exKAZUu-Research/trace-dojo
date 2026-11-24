/**
 * POSIX extended regular expressions as macOS's `regcomp` reads them for `[[ s =~ re ]]`: the leftmost match that is
 * longest, `.` matching any character, a backslash quoting the character after it, and no `\d`-style classes.
 */

import { charactersOf } from './characters';

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

const CLASSES: Record<string, (c: string) => boolean> = {
  alnum: (c) => /^[\p{L}\p{N}]$/u.test(c),
  alpha: (c) => /^\p{L}$/u.test(c),
  blank: (c) => c === ' ' || c === '\t',
  cntrl: (c) => /^\p{Cc}$/u.test(c),
  digit: (c) => /^[0-9]$/.test(c),
  graph: (c) => /^[^\p{C}\p{Z}]$/u.test(c),
  lower: (c) => /^\p{Ll}$/u.test(c),
  print: (c) => /^[^\p{C}]$/u.test(c),
  punct: (c) => /^[!-/:-@[-`{-~]$/.test(c),
  space: (c) => /^[ \t\n\v\f\r]$/.test(c),
  upper: (c) => /^\p{Lu}$/u.test(c),
  xdigit: (c) => /^[0-9A-Fa-f]$/.test(c),
};

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

  // code-gauge-allow functionCognitiveComplexity -- POSIX bracket expressions with classes, equivalence classes, collating symbols, and ranges.
  // code-gauge-allow functionNcss -- POSIX bracket expressions with classes, equivalence classes, collating symbols, and ranges.
  private parseSet(): RegexNode {
    const tests: ((c: string) => boolean)[] = [];
    let negated = false;
    if (this.chars[this.position] === '^') {
      negated = true;
      this.position++;
    }
    let first = true;
    for (;;) {
      const c = this.chars[this.position];
      if (c === undefined) throw new RegexSyntaxError('brackets ([ ]) not balanced');
      if (c === ']' && !first) {
        this.position++;
        break;
      }
      first = false;
      if (
        c === '[' &&
        (this.chars[this.position + 1] === ':' ||
          this.chars[this.position + 1] === '=' ||
          this.chars[this.position + 1] === '.')
      ) {
        const type = this.chars[this.position + 1];
        const rest = this.chars.slice(this.position + 2).join('');
        const close = rest.indexOf(`${type}]`);
        if (close === -1) throw new RegexSyntaxError('brackets ([ ]) not balanced');
        const name = rest.slice(0, close);
        this.position += 2 + charactersOf(name).length + 2;
        if (type === ':') {
          const test = Object.hasOwn(CLASSES, name) ? CLASSES[name] : undefined;
          if (!test) throw new RegexSyntaxError('invalid character class');
          tests.push(test);
        } else tests.push((ch) => ch === name);
        continue;
      }
      this.position++;
      if (
        this.chars[this.position] === '-' &&
        this.chars[this.position + 1] !== undefined &&
        this.chars[this.position + 1] !== ']'
      ) {
        const end = this.chars[this.position + 1];
        this.position += 2;
        const low = c.codePointAt(0) as number;
        const high = end.codePointAt(0) as number;
        if (low > high) throw new RegexSyntaxError('invalid character range');
        tests.push((ch) => {
          const code = ch.codePointAt(0) as number;
          return code >= low && code <= high;
        });
        continue;
      }
      tests.push((ch) => ch === c);
    }
    return { kind: 'set', negated, test: (ch) => tests.some((test) => test(ch)) };
  }
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
  | { kind: 'open'; slot: number; maxSlot: number; out: number }
  | { kind: 'close'; slot: number; out: number }
  | { kind: 'split'; first: number; second: number };

interface CompiledNfa {
  entry: number;
  accept: number;
  states: NfaState[];
  /** For each state, the set of slots currently open along paths through that state. */
  openSlots: ReadonlySet<number>[];
  slotCount: number;
  /** For each group `1..groups`, the slot index storing its `[start, end]`. */
  groupSlots: number[];
}

interface Thread {
  slots: [number, number][];
  opens: number[];
}

/** Finds the leftmost-longest match, choosing among equally long ones the one whose earlier subpatterns are longer. */
export function searchRegex(regex: CompiledRegex, text: string, spend: () => void): RegexMatch | undefined {
  const nfa = (regex.nfa ??= buildNfa(regex, spend));
  const chars = charactersOf(text);
  for (let start = 0; start <= chars.length; start++) {
    const match = matchFrom(nfa, chars, start, spend);
    if (match) return match;
  }
  return undefined;
}

function matchFrom(nfa: CompiledNfa, chars: string[], start: number, spend: () => void): RegexMatch | undefined {
  let current: (Thread | undefined)[] = Array.from({ length: nfa.states.length });
  current[nfa.entry] = {
    slots: Array.from({ length: nfa.slotCount + 1 }, () => [-1, -1]),
    opens: Array.from({ length: nfa.slotCount + 1 }, () => -1),
  };
  let bestEnd = -1;
  let bestThread: Thread | undefined;
  for (let pos = start; pos <= chars.length; pos++) {
    closeEpsilons(nfa, current, pos, chars.length, spend);
    const accepted = current[nfa.accept];
    if (accepted) {
      bestEnd = pos;
      bestThread = accepted;
    }
    if (pos === chars.length || !current.some(Boolean)) break;
    current = stepChar(nfa, current, chars[pos], spend);
  }
  if (!bestThread) return undefined;
  const result: RegexMatch = [[start, bestEnd]];
  for (let group = 1; group < nfa.groupSlots.length; group++) {
    const [s, e] = bestThread.slots[nfa.groupSlots[group]];
    result.push([s, e]);
  }
  return result;
}

// code-gauge-allow functionCognitiveComplexity -- Relaxes epsilon transitions (splits, anchors, and subpattern open/close tags) in a single worklist pass.
function closeEpsilons(
  nfa: CompiledNfa,
  states: (Thread | undefined)[],
  pos: number,
  textLength: number,
  spend: () => void
): void {
  const queue: number[] = [];
  const queued = new Uint8Array(nfa.states.length);
  for (let i = 0; i < states.length; i++) {
    if (states[i]) {
      queue.push(i);
      queued[i] = 1;
    }
  }
  const relax = (target: number, thread: Thread): void => {
    const existing = states[target];
    if (existing && !betterThread(nfa.openSlots[target], thread, existing)) return;
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
    if (!thread) continue;
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
      case 'open': {
        const slots = [...thread.slots];
        for (let s = state.slot + 1; s <= state.maxSlot; s++) slots[s] = [-1, -1];
        const opens = [...thread.opens];
        opens[state.slot] = pos;
        relax(state.out, { slots, opens });
        break;
      }
      case 'close': {
        const slots = [...thread.slots];
        slots[state.slot] = [thread.opens[state.slot], pos];
        relax(state.out, { slots, opens: thread.opens });
        break;
      }
      default: {
        break;
      }
    }
  }
}

function stepChar(
  nfa: CompiledNfa,
  current: (Thread | undefined)[],
  ch: string,
  spend: () => void
): (Thread | undefined)[] {
  const next: (Thread | undefined)[] = Array.from({ length: nfa.states.length });
  const advance = (target: number, thread: Thread): void => {
    const existing = next[target];
    if (!existing || betterThread(nfa.openSlots[target], thread, existing)) next[target] = thread;
  };
  for (let id = 0; id < current.length; id++) {
    const thread = current[id];
    if (!thread) continue;
    spend();
    const state = nfa.states[id];
    if (state.kind === 'char' && ch === state.c) advance(state.out, thread);
    else if (state.kind === 'any') advance(state.out, thread);
    else if (state.kind === 'set' && state.test(ch) !== state.negated) advance(state.out, thread);
  }
  return next;
}

function betterThread(openAtState: ReadonlySet<number>, candidate: Thread, existing: Thread): boolean {
  for (let s = 1; s < candidate.slots.length; s++) {
    if (openAtState.has(s)) {
      const co = candidate.opens[s];
      const eo = existing.opens[s];
      if (co !== eo) return eo === -1 || (co !== -1 && co < eo);
      continue;
    }
    const [cs, ce] = candidate.slots[s];
    const [bs, be] = existing.slots[s];
    if (cs === bs && ce === be) continue;
    if (bs === -1) return cs !== -1;
    if (cs === -1) return false;
    if (cs !== bs) return cs < bs;
    return ce > be;
  }
  return false;
}

interface NfaBuilder {
  states: NfaState[];
  slotMap: SlotAssignment;
  add: (state: NfaState, active: ReadonlySet<number>) => number;
}

function buildNfa(regex: CompiledRegex, spend: () => void): CompiledNfa {
  const states: NfaState[] = [];
  const openSlots: ReadonlySet<number>[] = [];
  const groupSlots: number[] = Array.from({ length: regex.groups + 1 }, () => 0);
  const slotMap = assignSlots(regex.root, groupSlots);
  const add = (state: NfaState, active: ReadonlySet<number>): number => {
    spend();
    const id = states.length;
    states.push(state);
    openSlots.push(active);
    return id;
  };
  const builder: NfaBuilder = { states, slotMap, add };
  const accept = add({ kind: 'accept' }, new Set());
  const entry = compileNode(regex.root, accept, new Set(), builder);
  return { entry, accept, states, openSlots, slotCount: slotMap.count, groupSlots };
}

interface SlotAssignment {
  count: number;
  rangeOf: Map<RegexNode, { slot: number; maxSlot: number }>;
}

function assignSlots(root: RegexNode, groupSlots: number[]): SlotAssignment {
  let count = 0;
  const rangeOf = new Map<RegexNode, { slot: number; maxSlot: number }>();
  const visit = (node: RegexNode): void => {
    if (node.kind === 'group' || node.kind === 'repeat') {
      const slot = ++count;
      if (node.kind === 'group') groupSlots[node.index] = slot;
      visit(node.body);
      rangeOf.set(node, { slot, maxSlot: count });
      return;
    }
    if (node.kind === 'concat') for (const item of node.items) visit(item);
    else if (node.kind === 'alternation') for (const option of node.options) visit(option);
  };
  visit(root);
  return { count, rangeOf };
}

// code-gauge-allow functionCognitiveComplexity -- Compiles each regex AST node kind into Thompson NFA states with POSIX subpattern tags.
function compileNode(node: RegexNode, out: number, active: ReadonlySet<number>, builder: NfaBuilder): number {
  const { add, slotMap } = builder;
  switch (node.kind) {
    case 'char': {
      return add({ kind: 'char', c: node.c, out }, active);
    }
    case 'any': {
      return add({ kind: 'any', out }, active);
    }
    case 'set': {
      return add({ kind: 'set', negated: node.negated, test: node.test, out }, active);
    }
    case 'start': {
      return add({ kind: 'start', out }, active);
    }
    case 'end': {
      return add({ kind: 'end', out }, active);
    }
    case 'group': {
      const { slot, maxSlot } = slotMap.rangeOf.get(node) as { slot: number; maxSlot: number };
      const inner = new Set([...active, slot]);
      const close = add({ kind: 'close', slot, out }, active);
      const body = compileNode(node.body, close, inner, builder);
      return add({ kind: 'open', slot, maxSlot, out: body }, active);
    }
    case 'concat': {
      let next = out;
      for (let i = node.items.length - 1; i >= 0; i--) next = compileNode(node.items[i], next, active, builder);
      return next;
    }
    case 'alternation': {
      let next = compileNode(node.options.at(-1) as RegexNode, out, active, builder);
      for (let i = node.options.length - 2; i >= 0; i--) {
        const branch = compileNode(node.options[i], out, active, builder);
        next = add({ kind: 'split', first: branch, second: next }, active);
      }
      return next;
    }
    case 'repeat': {
      const { slot, maxSlot } = slotMap.rangeOf.get(node) as { slot: number; maxSlot: number };
      const inner = new Set([...active, slot]);
      const close = add({ kind: 'close', slot, out }, active);
      const bodyEntry = compileRepeat(node.body, node.min, node.max, close, inner, builder);
      return add({ kind: 'open', slot, maxSlot, out: bodyEntry }, active);
    }
  }
}

function compileRepeat(
  body: RegexNode,
  min: number,
  max: number,
  out: number,
  active: ReadonlySet<number>,
  builder: NfaBuilder
): number {
  let next = out;
  if (max === Infinity) {
    const loop = builder.add({ kind: 'split', first: 0, second: out }, active);
    const iter = compileNode(body, loop, active, builder);
    (builder.states[loop] as Extract<NfaState, { kind: 'split' }>).first = iter;
    next = loop;
  } else {
    for (let i = 0; i < max - min; i++) {
      const iter = compileNode(body, next, active, builder);
      next = builder.add({ kind: 'split', first: iter, second: next }, active);
    }
  }
  for (let i = 0; i < min; i++) next = compileNode(body, next, active, builder);
  return next;
}
