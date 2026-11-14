// code-gauge-allow-file fileNcss 660 -- Go's parser keeps its methods on one parser type, transcribed together.
// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { decodeRune } from '../literals';
import {
  appendClass,
  appendFoldedClass,
  appendFoldedRange,
  appendNegatedClass,
  appendNegatedTable,
  appendRange,
  appendTable,
  type CharGroup,
  cleanClass,
  negateClass,
  PERL_GROUPS,
  POSIX_GROUPS,
  type RuneClass,
  unicodeTable,
} from './regexpCharClass';
import {
  checkUTF8,
  cleanAlt,
  equal,
  ERR_INVALID_CHAR_RANGE,
  ERR_INVALID_ESCAPE,
  ERR_INVALID_NAMED_CAPTURE,
  ERR_INVALID_PERL_OP,
  ERR_INVALID_REPEAT_OP,
  ERR_INVALID_REPEAT_SIZE,
  ERR_LARGE,
  ERR_MISSING_BRACKET,
  ERR_MISSING_PAREN,
  ERR_MISSING_REPEAT_ARGUMENT,
  ERR_NESTING_DEPTH,
  ERR_UNEXPECTED_PAREN,
  fail,
  Flag,
  isCharClass,
  isValidCaptureName,
  leadingRegexp,
  leadingString,
  mergeCharClass,
  minFoldRune,
  newNode,
  nextRune,
  type Node,
  Op,
  OP_LEFT_PAREN,
  OP_PSEUDO,
  OP_VERTICAL_BAR,
  parseEscape,
  parseRepeat,
  removeEmptyRepeats,
  repeatIsValid,
  runeAt,
} from './regexpSyntax';
import { simpleFold } from './unicodeSupport';

const MAX_HEIGHT = 1000;
const MAX_SIZE = Math.floor((128 << 20) / 40);
const MAX_RUNES = (128 << 20) / 4;

/** A limit error, which Go's parser panics with and `parse` turns into an error on the whole expression. */
class LimitError {
  constructor(readonly code: string) {}
}

/** `syntax.Parse`, throwing a `RegexpSyntaxError` where Go returns an error. */
export function parse(s: string, flags: number, spend: (cost: number) => void): Node {
  try {
    if (flags & Flag.Literal) {
      checkUTF8(s);
      const re = newNode(Op.Literal, flags);
      for (let at = 0; at < s.length;) {
        const { rune, size } = decodeRune(s, at);
        re.rune.push(rune);
        at += size;
      }
      return re;
    }
    return new Parser(s, flags, spend).parse();
  } catch (error) {
    if (error instanceof LimitError) fail(error.code, s);
    throw error;
  }
}

class Parser {
  private stack: Node[] = [];
  private numCap = 0;
  private numRegexp = 0;
  private numRunes = 0;
  private repeats = 0;
  private height: Map<Node, number> | undefined;
  private size: Map<Node, number> | undefined;

  constructor(
    private readonly wholeRegexp: string,
    private flags: number,
    private readonly spend: (cost: number) => void
  ) {}

  parse(): Node {
    let t = this.wholeRegexp;
    let lastRepeat = '';
    while (t !== '') {
      this.spend(1);
      const repeated = this.parseRepetition(t, lastRepeat);
      if (repeated) {
        ({ rest: t, repeat: lastRepeat } = repeated);
      } else {
        t = this.parseItem(t);
        lastRepeat = '';
      }
    }
    this.concatenate();
    if (this.swapVerticalBar()) this.stack.pop();
    this.alternate();
    if (this.stack.length !== 1) fail(ERR_MISSING_PAREN, this.wholeRegexp);
    return this.stack[0];
  }

  /** Parses a repetition operator, returning the rest and the text of the operator, which the next one checks. */
  private parseRepetition(t: string, lastRepeat: string): { rest: string; repeat: string } | undefined {
    switch (t[0]) {
      case '*':
      case '+':
      case '?': {
        const op = t[0] === '*' ? Op.Star : t[0] === '+' ? Op.Plus : Op.Quest;
        return { rest: this.repeat(op, 0, 0, t, t.slice(1), lastRepeat), repeat: t };
      }
      case '{': {
        const parsed = parseRepeat(t);
        if (!parsed) {
          this.literal(0x7b);
          return { rest: t.slice(1), repeat: '' };
        }
        const { min, max, rest } = parsed;
        if (min < 0 || min > 1000 || max > 1000 || (max >= 0 && min > max)) {
          fail(ERR_INVALID_REPEAT_SIZE, t.slice(0, t.length - rest.length));
        }
        return { rest: this.repeat(Op.Repeat, min, max, t, rest, lastRepeat), repeat: t };
      }
    }
    return undefined;
  }

  /** Parses anything but a repetition operator, returning the rest. */
  // code-gauge-allow functionNcss 33 -- Transcribes the cases of Go's parse loop.
  private parseItem(t: string): string {
    switch (t[0]) {
      case '(': {
        if (this.flags & Flag.PerlX && t.length >= 2 && t[1] === '?') return this.parsePerlFlags(t);
        this.numCap++;
        (this.op(OP_LEFT_PAREN) as Node).cap = this.numCap;
        return t.slice(1);
      }
      case '|': {
        this.parseVerticalBar();
        return t.slice(1);
      }
      case ')': {
        this.parseRightParen();
        return t.slice(1);
      }
      case '^': {
        this.op(this.flags & Flag.OneLine ? Op.BeginText : Op.BeginLine);
        return t.slice(1);
      }
      case '$': {
        if (this.flags & Flag.OneLine) (this.op(Op.EndText) as Node).flags |= Flag.WasDollar;
        else this.op(Op.EndLine);
        return t.slice(1);
      }
      case '.': {
        this.op(this.flags & Flag.DotNL ? Op.AnyChar : Op.AnyCharNotNL);
        return t.slice(1);
      }
      case '[': {
        return this.parseClass(t);
      }
      case '\\': {
        return this.parseBackslash(t);
      }
    }
    const { c, t: rest } = nextRune(t);
    this.literal(c);
    return rest;
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Transcribes the backslash case of Go's parse loop.
  // code-gauge-allow functionNcss 43 -- Transcribes the backslash case of Go's parse loop.
  private parseBackslash(text: string): string {
    let t = text;
    if (this.flags & Flag.PerlX && t.length >= 2) {
      switch (t[1]) {
        case 'A': {
          this.op(Op.BeginText);
          return t.slice(2);
        }
        case 'b': {
          this.op(Op.WordBoundary);
          return t.slice(2);
        }
        case 'B': {
          this.op(Op.NoWordBoundary);
          return t.slice(2);
        }
        case 'C': {
          return fail(ERR_INVALID_ESCAPE, t.slice(0, 2));
        }
        case 'Q': {
          const end = t.indexOf(String.raw`\E`, 2);
          let lit = end === -1 ? t.slice(2) : t.slice(2, end);
          t = end === -1 ? '' : t.slice(end + 2);
          while (lit !== '') {
            const { c, t: rest } = nextRune(lit);
            this.literal(c);
            lit = rest;
          }
          return t;
        }
        case 'z': {
          this.op(Op.EndText);
          return t.slice(2);
        }
      }
    }
    const re = newNode(Op.CharClass, this.flags);
    this.numRegexp++;
    if (t.length >= 2 && (t[1] === 'p' || t[1] === 'P')) {
      const parsed = this.parseUnicodeClass(t, []);
      if (parsed) {
        re.rune = parsed.out;
        this.push(re);
        return parsed.rest;
      }
    }
    const perl = this.parsePerlClassEscape(t, []);
    if (perl) {
      re.rune = perl.out;
      this.push(re);
      return perl.rest;
    }
    const { r, rest } = parseEscape(t);
    this.literal(r);
    return rest;
  }

  private newRegexp(op: number): Node {
    this.numRegexp++;
    return newNode(op);
  }

  private checkLimits(re: Node): void {
    if (this.numRunes > MAX_RUNES) throw new LimitError(ERR_LARGE);
    this.checkSize(re);
    this.checkHeight(re);
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Transcribes Go's checkSize step by step.
  private checkSize(re: Node): void {
    if (!this.size) {
      if (this.repeats === 0) this.repeats = 1;
      if (re.op === Op.Repeat) {
        let n = re.max === -1 ? re.min : re.max;
        if (n <= 0) n = 1;
        this.repeats = n > Math.floor(MAX_SIZE / this.repeats) ? MAX_SIZE : this.repeats * n;
      }
      if (this.numRegexp < Math.floor(MAX_SIZE / this.repeats)) return;
      this.size = new Map();
      for (const node of this.stack) this.checkSize(node);
    }
    if (this.calcSize(re, true) > MAX_SIZE) throw new LimitError(ERR_LARGE);
  }

  // code-gauge-allow functionNcss 36 -- Transcribes Go's calcSize step by step.
  private calcSize(re: Node, force: boolean): number {
    const sizes = this.size as Map<Node, number>;
    if (!force) {
      const cached = sizes.get(re);
      if (cached !== undefined) return cached;
    }
    let size = 0;
    switch (re.op) {
      case Op.Literal: {
        size = re.rune.length;
        break;
      }
      case Op.Capture:
      case Op.Star: {
        size = 2 + this.calcSize(re.sub[0], false);
        break;
      }
      case Op.Plus:
      case Op.Quest: {
        size = 1 + this.calcSize(re.sub[0], false);
        break;
      }
      case Op.Concat:
      case Op.Alternate: {
        for (const sub of re.sub) size += this.calcSize(sub, false);
        if (re.op === Op.Alternate && re.sub.length > 1) size += re.sub.length - 1;
        break;
      }
      case Op.Repeat: {
        const sub = this.calcSize(re.sub[0], false);
        if (re.max === -1) size = re.min === 0 ? 2 + sub : 1 + re.min * sub;
        else size = re.max * sub + (re.max - re.min);
        break;
      }
    }
    size = Math.max(1, size);
    sizes.set(re, size);
    return size;
  }

  private checkHeight(re: Node): void {
    if (this.numRegexp < MAX_HEIGHT) return;
    if (!this.height) {
      this.height = new Map();
      for (const node of this.stack) this.checkHeight(node);
    }
    if (this.calcHeight(re, true) > MAX_HEIGHT) throw new LimitError(ERR_NESTING_DEPTH);
  }

  private calcHeight(re: Node, force: boolean): number {
    const heights = this.height as Map<Node, number>;
    if (!force) {
      const cached = heights.get(re);
      if (cached !== undefined) return cached;
    }
    let h = 1;
    for (const sub of re.sub) h = Math.max(h, 1 + this.calcHeight(sub, false));
    heights.set(re, h);
    return h;
  }

  private push(re: Node): Node | undefined {
    this.numRunes += re.rune.length;
    const r = re.rune;
    if (re.op === Op.CharClass && r.length === 2 && r[0] === r[1]) {
      if (this.maybeConcat(r[0], this.flags & ~Flag.FoldCase)) return undefined;
      re.op = Op.Literal;
      re.rune = [r[0]];
      re.flags = this.flags & ~Flag.FoldCase;
    } else if (
      (re.op === Op.CharClass &&
        r.length === 4 &&
        r[0] === r[1] &&
        r[2] === r[3] &&
        simpleFold(r[0]) === r[2] &&
        simpleFold(r[2]) === r[0]) ||
      (re.op === Op.CharClass &&
        r.length === 2 &&
        r[0] + 1 === r[1] &&
        simpleFold(r[0]) === r[1] &&
        simpleFold(r[1]) === r[0])
    ) {
      if (this.maybeConcat(r[0], this.flags | Flag.FoldCase)) return undefined;
      re.op = Op.Literal;
      re.rune = [r[0]];
      re.flags = this.flags | Flag.FoldCase;
    } else {
      this.maybeConcat(-1, 0);
    }
    this.stack.push(re);
    this.checkLimits(re);
    return re;
  }

  private maybeConcat(r: number, flags: number): boolean {
    const n = this.stack.length;
    if (n < 2) return false;
    const re1 = this.stack[n - 1];
    const re2 = this.stack[n - 2];
    if (re1.op !== Op.Literal || re2.op !== Op.Literal || (re1.flags & Flag.FoldCase) !== (re2.flags & Flag.FoldCase)) {
      return false;
    }
    re2.rune = [...re2.rune, ...re1.rune];
    if (r >= 0) {
      re1.rune = [r];
      re1.flags = flags;
      return true;
    }
    this.stack.pop();
    return false;
  }

  private literal(rune: number): void {
    const re = this.newRegexp(Op.Literal);
    re.flags = this.flags;
    re.rune = [this.flags & Flag.FoldCase ? minFoldRune(rune) : rune];
    this.push(re);
  }

  private op(op: number): Node | undefined {
    const re = this.newRegexp(op);
    re.flags = this.flags;
    return this.push(re);
  }

  private repeat(op: number, min: number, max: number, before: string, afterText: string, lastRepeat: string): string {
    let after = afterText;
    let flags = this.flags;
    if (this.flags & Flag.PerlX) {
      if (after.length > 0 && after[0] === '?') {
        after = after.slice(1);
        flags ^= Flag.NonGreedy;
      }
      if (lastRepeat !== '') fail(ERR_INVALID_REPEAT_OP, lastRepeat.slice(0, lastRepeat.length - after.length));
    }
    const n = this.stack.length;
    if (n === 0 || this.stack[n - 1].op >= OP_PSEUDO) {
      fail(ERR_MISSING_REPEAT_ARGUMENT, before.slice(0, before.length - after.length));
    }
    const re = this.newRegexp(op);
    re.min = min;
    re.max = max;
    re.flags = flags;
    re.sub = [this.stack[n - 1]];
    this.stack[n - 1] = re;
    this.checkLimits(re);
    if (op === Op.Repeat && (min >= 2 || max >= 2) && !repeatIsValid(re, 1000)) {
      fail(ERR_INVALID_REPEAT_SIZE, before.slice(0, before.length - after.length));
    }
    return after;
  }

  private popOperands(): Node[] {
    let i = this.stack.length;
    while (i > 0 && this.stack[i - 1].op < OP_PSEUDO) i--;
    return this.stack.splice(i);
  }

  private concatenate(): Node | undefined {
    this.maybeConcat(-1, 0);
    const subs = this.popOperands();
    if (subs.length === 0) return this.push(this.newRegexp(Op.EmptyMatch));
    return this.push(this.collapse(subs, Op.Concat));
  }

  private alternate(): Node | undefined {
    const subs = this.popOperands();
    if (subs.length > 0) cleanAlt(subs.at(-1) as Node);
    if (subs.length === 0) return this.push(this.newRegexp(Op.NoMatch));
    return this.push(this.collapse(subs, Op.Alternate));
  }

  private collapse(subs: Node[], op: number): Node {
    if (subs.length === 1) return subs[0];
    let re = this.newRegexp(op);
    for (const sub of subs) {
      if (sub.op === op) re.sub.push(...sub.sub);
      else re.sub.push(sub);
    }
    if (op === Op.Alternate) {
      re.sub = this.factor(re.sub);
      if (re.sub.length === 1) re = re.sub[0];
    }
    return re;
  }

  private factor(subs: Node[]): Node[] {
    if (subs.length < 2) return subs;
    return removeEmptyRepeats(this.mergeCharClasses(this.factorLeadingRegexps(this.factorLeadingStrings(subs))));
  }

  /** Round 1 of Go's `factor`: factors out common literal prefixes. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Transcribes the first round of Go's factor.
  // code-gauge-allow functionNcss 35 -- Transcribes the first round of Go's factor.
  private factorLeadingStrings(sub: Node[]): Node[] {
    const out: Node[] = [];
    let str: number[] = [];
    let strflags = 0;
    let start = 0;
    for (let i = 0; i <= sub.length; i++) {
      let istr: number[] = [];
      let iflags = 0;
      if (i < sub.length) {
        ({ runes: istr, flags: iflags } = leadingString(sub[i]));
        if (iflags === strflags) {
          let same = 0;
          while (same < str.length && same < istr.length && str[same] === istr[same]) same++;
          if (same > 0) {
            str = str.slice(0, same);
            continue;
          }
        }
      }
      if (i === start + 1) {
        out.push(sub[start]);
      } else if (i > start + 1) {
        const prefix = this.newRegexp(Op.Literal);
        prefix.flags = strflags;
        prefix.rune = [...str];
        for (let j = start; j < i; j++) {
          sub[j] = this.removeLeadingString(sub[j], str.length);
          this.checkLimits(sub[j]);
        }
        const suffix = this.collapse(sub.slice(start, i), Op.Alternate);
        const re = this.newRegexp(Op.Concat);
        re.sub = [prefix, suffix];
        out.push(re);
      }
      start = i;
      str = istr;
      strflags = iflags;
    }
    return out;
  }

  /** Round 2 of Go's `factor`: factors out common simple leading pieces such as character classes. */
  private factorLeadingRegexps(sub: Node[]): Node[] {
    const out: Node[] = [];
    let start = 0;
    let first: Node | undefined;
    for (let i = 0; i <= sub.length; i++) {
      let ifirst: Node | undefined;
      if (i < sub.length) {
        ifirst = leadingRegexp(sub[i]);
        if (
          first &&
          equal(first, ifirst) &&
          (isCharClass(first) || (first.op === Op.Repeat && first.min === first.max && isCharClass(first.sub[0])))
        ) {
          continue;
        }
      }
      if (i === start + 1) {
        out.push(sub[start]);
      } else if (i > start + 1) {
        const prefix = first as Node;
        for (let j = start; j < i; j++) {
          sub[j] = this.removeLeadingRegexp(sub[j]);
          this.checkLimits(sub[j]);
        }
        const suffix = this.collapse(sub.slice(start, i), Op.Alternate);
        const re = this.newRegexp(Op.Concat);
        re.sub = [prefix, suffix];
        out.push(re);
      }
      start = i;
      first = ifirst;
    }
    return out;
  }

  /** Round 3 of Go's `factor`: merges runs of literals and character classes into one class. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Transcribes the third round of Go's factor.
  private mergeCharClasses(sub: Node[]): Node[] {
    const out: Node[] = [];
    let start = 0;
    for (let i = 0; i <= sub.length; i++) {
      if (i < sub.length && isCharClass(sub[i])) continue;
      if (i === start + 1) {
        out.push(sub[start]);
      } else if (i > start + 1) {
        let max = start;
        for (let j = start + 1; j < i; j++) {
          if (sub[max].op < sub[j].op || (sub[max].op === sub[j].op && sub[max].rune.length < sub[j].rune.length)) {
            max = j;
          }
        }
        [sub[start], sub[max]] = [sub[max], sub[start]];
        for (let j = start + 1; j < i; j++) mergeCharClass(sub[start], sub[j]);
        cleanAlt(sub[start]);
        out.push(sub[start]);
      }
      if (i < sub.length) out.push(sub[i]);
      start = i + 1;
    }
    return out;
  }

  private removeLeadingString(node: Node, n: number): Node {
    let re = node;
    if (re.op === Op.Concat && re.sub.length > 0) {
      const sub = this.removeLeadingString(re.sub[0], n);
      re.sub[0] = sub;
      if (sub.op === Op.EmptyMatch) {
        switch (re.sub.length) {
          case 0:
          case 1: {
            re.op = Op.EmptyMatch;
            re.sub = [];
            break;
          }
          case 2: {
            re = re.sub[1];
            break;
          }
          default: {
            re.sub.shift();
          }
        }
      }
      return re;
    }
    if (re.op === Op.Literal) {
      re.rune = re.rune.slice(n);
      if (re.rune.length === 0) re.op = Op.EmptyMatch;
    }
    return re;
  }

  private removeLeadingRegexp(re: Node): Node {
    if (re.op === Op.Concat && re.sub.length > 0) {
      re.sub.shift();
      switch (re.sub.length) {
        case 0: {
          re.op = Op.EmptyMatch;
          re.sub = [];
          break;
        }
        case 1: {
          return re.sub[0];
        }
      }
      return re;
    }
    return this.newRegexp(Op.EmptyMatch);
  }

  private parseVerticalBar(): void {
    this.concatenate();
    if (!this.swapVerticalBar()) this.op(OP_VERTICAL_BAR);
  }

  private swapVerticalBar(): boolean {
    const stack = this.stack;
    const n = stack.length;
    if (n >= 3 && stack[n - 2].op === OP_VERTICAL_BAR && isCharClass(stack[n - 1]) && isCharClass(stack[n - 3])) {
      let re1 = stack[n - 1];
      let re3 = stack[n - 3];
      if (re1.op > re3.op) {
        [re1, re3] = [re3, re1];
        stack[n - 3] = re3;
      }
      mergeCharClass(re3, re1);
      stack.pop();
      return true;
    }
    if (n >= 2) {
      const re1 = stack[n - 1];
      const re2 = stack[n - 2];
      if (re2.op === OP_VERTICAL_BAR) {
        if (n >= 3) cleanAlt(stack[n - 3]);
        stack[n - 2] = re1;
        stack[n - 1] = re2;
        return true;
      }
    }
    return false;
  }

  private parseRightParen(): void {
    this.concatenate();
    if (this.swapVerticalBar()) this.stack.pop();
    this.alternate();
    const n = this.stack.length;
    if (n < 2) fail(ERR_UNEXPECTED_PAREN, this.wholeRegexp);
    const re1 = this.stack[n - 1];
    const re2 = this.stack[n - 2];
    this.stack.length = n - 2;
    if (re2.op !== OP_LEFT_PAREN) fail(ERR_UNEXPECTED_PAREN, this.wholeRegexp);
    this.flags = re2.flags;
    if (re2.cap === 0) {
      this.push(re1);
    } else {
      re2.op = Op.Capture;
      re2.sub = [re1];
      this.push(re2);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Transcribes Go's parsePerlFlags step by step.
  // code-gauge-allow functionNcss 50 -- Transcribes Go's parsePerlFlags step by step.
  private parsePerlFlags(s: string): string {
    const startsWithP = s.length > 4 && s[2] === 'P' && s[3] === '<';
    const startsWithName = s.length > 3 && s[2] === '<';
    if (startsWithP || startsWithName) return this.parseNamedCapture(s, startsWithName ? 3 : 4);
    let t = s.slice(2);
    let flags = this.flags;
    let sign = 1;
    let sawFlag = false;
    loop: while (t !== '') {
      const next = nextRune(t);
      t = next.t;
      switch (next.c) {
        case 0x69: {
          flags |= Flag.FoldCase;
          sawFlag = true;
          break;
        }
        case 0x6d: {
          flags &= ~Flag.OneLine;
          sawFlag = true;
          break;
        }
        case 0x73: {
          flags |= Flag.DotNL;
          sawFlag = true;
          break;
        }
        case 0x55: {
          flags |= Flag.NonGreedy;
          sawFlag = true;
          break;
        }
        case 0x2d: {
          if (sign < 0) break loop;
          sign = -1;
          flags = ~flags & 0xff_ff;
          sawFlag = false;
          break;
        }
        case 0x3a:
        case 0x29: {
          if (sign < 0) {
            if (!sawFlag) break loop;
            flags = ~flags & 0xff_ff;
          }
          if (next.c === 0x3a) this.op(OP_LEFT_PAREN);
          this.flags = flags;
          return t;
        }
        default: {
          break loop;
        }
      }
    }
    return fail(ERR_INVALID_PERL_OP, s.slice(0, s.length - t.length));
  }

  private parseNamedCapture(t: string, exprStartPos: number): string {
    const end = t.indexOf('>');
    if (end === -1) {
      checkUTF8(t);
      fail(ERR_INVALID_NAMED_CAPTURE, t);
    }
    const capture = t.slice(0, end + 1);
    const name = t.slice(exprStartPos, end);
    checkUTF8(name);
    if (!isValidCaptureName(name)) fail(ERR_INVALID_NAMED_CAPTURE, capture);
    this.numCap++;
    const re = this.op(OP_LEFT_PAREN) as Node;
    re.cap = this.numCap;
    re.name = name;
    return t.slice(end + 1);
  }

  private parseClassChar(s: string, wholeClass: string): { r: number; rest: string } {
    if (s === '') fail(ERR_MISSING_BRACKET, wholeClass);
    if (s[0] === '\\') return parseEscape(s);
    const { c, t } = nextRune(s);
    return { r: c, rest: t };
  }

  private parsePerlClassEscape(s: string, r: RuneClass): { out: RuneClass; rest: string } | undefined {
    if (!(this.flags & Flag.PerlX) || s.length < 2 || s[0] !== '\\') return undefined;
    const group = PERL_GROUPS.get(s.slice(0, 2));
    if (!group) return undefined;
    return { out: this.appendGroup(r, group), rest: s.slice(2) };
  }

  private parseNamedClass(s: string, r: RuneClass): { out: RuneClass; rest: string } | undefined {
    if (s.length < 2 || s[0] !== '[' || s[1] !== ':') return undefined;
    const i = s.indexOf(':]', 2);
    if (i === -1) return undefined;
    const name = s.slice(0, i + 2);
    const group = POSIX_GROUPS.get(name);
    if (!group) fail(ERR_INVALID_CHAR_RANGE, name);
    return { out: this.appendGroup(r, group), rest: s.slice(i + 2) };
  }

  private appendGroup(r: RuneClass, group: CharGroup): RuneClass {
    const tmp = this.flags & Flag.FoldCase ? cleanClass(appendFoldedClass([], group.class)) : group.class;
    return group.sign < 0 ? appendNegatedClass(r, tmp) : appendClass(r, tmp);
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Transcribes Go's parseUnicodeClass step by step.
  // code-gauge-allow functionNcss 32 -- Transcribes Go's parseUnicodeClass step by step.
  private parseUnicodeClass(s: string, r: RuneClass): { out: RuneClass; rest: string } | undefined {
    if (!(this.flags & Flag.UnicodeGroups) || s.length < 2 || s[0] !== '\\' || (s[1] !== 'p' && s[1] !== 'P')) {
      return undefined;
    }
    let sign = s[1] === 'P' ? -1 : 1;
    const { c, t: afterName } = nextRune(s.slice(2));
    let t = afterName;
    let seq: string;
    let name: string;
    if (c === 0x7b) {
      const end = s.indexOf('}');
      if (end === -1) {
        checkUTF8(s);
        fail(ERR_INVALID_CHAR_RANGE, s);
      }
      seq = s.slice(0, end + 1);
      t = s.slice(end + 1);
      name = s.slice(3, end);
      checkUTF8(name);
    } else {
      seq = s.slice(0, s.length - t.length);
      name = seq.slice(2);
    }
    if (name !== '' && name[0] === '^') {
      sign = -sign;
      name = name.slice(1);
    }
    const { tab, fold, sign: tableSign } = unicodeTable(name);
    if (!tab) return fail(ERR_INVALID_CHAR_RANGE, seq);
    if (tableSign < 0) sign = -sign;
    if (!(this.flags & Flag.FoldCase) || !fold) {
      return { out: sign > 0 ? appendTable(r, tab) : appendNegatedTable(r, tab), rest: t };
    }
    const tmp = cleanClass(appendTable(appendTable([], tab), fold));
    return { out: sign > 0 ? appendClass(r, tmp) : appendNegatedClass(r, tmp), rest: t };
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Transcribes Go's parseClass step by step.
  // code-gauge-allow functionNcss 45 -- Transcribes Go's parseClass step by step.
  private parseClass(s: string): string {
    let t = s.slice(1);
    const re = this.newRegexp(Op.CharClass);
    re.flags = this.flags;
    let sign = 1;
    let runes: RuneClass = [];
    if (t !== '' && t[0] === '^') {
      sign = -1;
      t = t.slice(1);
      if (!(this.flags & Flag.ClassNL)) runes.push(10, 10);
    }
    let first = true;
    while (t === '' || t[0] !== ']' || first) {
      if (t !== '' && t[0] === '-' && !(this.flags & Flag.PerlX) && !first && (t.length === 1 || t[1] !== ']')) {
        fail(ERR_INVALID_CHAR_RANGE, t.slice(0, 1 + runeAt(t, 1).size));
      }
      first = false;
      if (t.length > 2 && t[0] === '[' && t[1] === ':') {
        const named = this.parseNamedClass(t, runes);
        if (named) {
          ({ out: runes, rest: t } = named);
          continue;
        }
      }
      const unicode = this.parseUnicodeClass(t, runes) ?? this.parsePerlClassEscape(t, runes);
      if (unicode) {
        ({ out: runes, rest: t } = unicode);
        continue;
      }
      const range = t;
      const low = this.parseClassChar(t, s);
      t = low.rest;
      let hi = low.r;
      if (t.length >= 2 && t[0] === '-' && t[1] !== ']') {
        const high = this.parseClassChar(t.slice(1), s);
        t = high.rest;
        hi = high.r;
        if (hi < low.r) fail(ERR_INVALID_CHAR_RANGE, range.slice(0, range.length - t.length));
      }
      runes = this.flags & Flag.FoldCase ? appendFoldedRange(runes, low.r, hi) : appendRange(runes, low.r, hi);
      this.spend(1);
    }
    runes = cleanClass(runes);
    re.rune = sign < 0 ? negateClass(runes) : runes;
    this.push(re);
    return t.slice(1);
  }
}
