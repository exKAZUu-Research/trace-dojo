import { type AST, RegExpParser } from '@eslint-community/regexpp';

import { ExecutionLimitError } from '../../interpreter/limits';

/**
 * A backtracking matcher of ECMAScript regular expressions, the syntax and semantics of the VM's Irregexp, which
 * charges every step to the run's budget: the host's RegExp cannot be interrupted, so a pattern that backtracks
 * exponentially would hold the host's thread past every limit.
 *
 * The pattern compiles to instructions whose choice points live on an explicit stack, so long inputs need no host
 * recursion; registers (captures and loop counters) change through an undo trail that backtracking unwinds. Each
 * single-character atom is tested by a host RegExp of that atom alone, which cannot backtrack and keeps the host's
 * character classes, Unicode properties, and case folding.
 */
export interface RegExpFlags {
  multiLine: boolean;
  ignoreCase: boolean;
  unicode: boolean;
  dotAll: boolean;
}

export interface CompiledRegExp {
  readonly groupCount: number;
  /** The group numbers of each name, in the order the names first appear. */
  readonly names: ReadonlyMap<string, readonly number[]>;
  readonly unicode: boolean;
  readonly program: readonly Instruction[];
  readonly registerCount: number;
}

export interface RegExpMatchResult {
  start: number;
  end: number;
  /** Start and end offsets of capture groups, from group 1. */
  captures?: Int32Array;
}

interface RegExpBudget {
  charge: () => void;
  scratchSlots: number;
  reserveCaptures?: (slots: number) => void;
}

export function compileRegExp(source: string, flags: RegExpFlags, charge: () => void): CompiledRegExp {
  const pattern = new RegExpParser({ ecmaVersion: 2025 }).parsePattern(source, 0, source.length, {
    unicode: flags.unicode,
  });
  const captures = indexCaptures(pattern, charge);
  const compiler = new Compiler(captures, flags.unicode, charge);
  compiler.alternatives(pattern.alternatives, { ...flags, backward: false });
  compiler.emit({ op: 'succeed' });
  const names = new Map<string, number[]>();
  for (const [group, number] of captures.numbers) {
    if (group.name === null) continue;
    const numbers = names.get(group.name) ?? [];
    numbers.push(number);
    names.set(group.name, numbers);
  }
  return {
    groupCount: captures.numbers.size,
    names,
    unicode: flags.unicode,
    program: compiler.program,
    registerCount: 2 * (captures.numbers.size + 1) + 2 * compiler.loops,
  };
}

/** The first match at `start` (`sticky`) or after it. */
export function execRegExp(
  compiled: CompiledRegExp,
  input: string,
  start: number,
  sticky: boolean,
  { charge, scratchSlots, reserveCaptures }: RegExpBudget
): RegExpMatchResult | undefined {
  const machine = new Machine(compiled, input, charge, scratchSlots);
  const result = (position: number, end: number): RegExpMatchResult => {
    if (!reserveCaptures) return { start: position, end };
    reserveCaptures(2 * compiled.groupCount);
    return { start: position, end, captures: machine.registers.slice(2, 2 + 2 * compiled.groupCount) };
  };
  // As irregexp in Unicode mode: a start inside a surrogate pair first tries the pair's start, and the search visits
  // every code unit, where only assertions match inside a pair because no character starts there.
  if (compiled.unicode && isSurrogatePairAt(input, start - 1)) {
    const end = machine.attempt(start - 1);
    if (end >= 0) return result(start - 1, end);
  }
  for (let position = start; position <= input.length; position++) {
    const end = machine.attempt(position);
    if (end >= 0) return result(position, end);
    if (sticky) return undefined;
  }
  return undefined;
}

/** Tests one character at a position, giving the position past it (before it, backward) or -1. */
type CharTest = (input: string, position: number) => number;

type Instruction =
  | { op: 'char'; test: CharTest }
  | { op: 'split'; first: number; second: number }
  | { op: 'jump'; to: number }
  | { op: 'save'; register: number }
  | { op: 'assert'; test: (input: string, position: number) => boolean }
  | { op: 'backref'; groups: readonly number[]; backward: boolean; equal: (a: number, b: number) => boolean }
  /** A lookaround whose body follows it and ends with `succeed`; matching continues at `next`. */
  | { op: 'look'; negative: boolean; next: number }
  | { op: 'loopInit'; count: number }
  | { op: 'loop'; count: number; min: number; max: number; greedy: boolean; enter: number; exit: number }
  | { op: 'loopEnter'; start: number; firstRegister: number; endRegister: number }
  | { op: 'loopEnd'; count: number; start: number; min: number; decide: number }
  | { op: 'succeed' };

interface Context extends RegExpFlags {
  backward: boolean;
}

interface CaptureIndex {
  numbers: Map<AST.CapturingGroup, number>;
  loops: Map<AST.Quantifier, { firstRegister: number; endRegister: number }>;
}

class Compiler {
  readonly program: Instruction[] = [];
  loops = 0;
  private readonly testCache = new Map<string, CharTest>();

  constructor(
    private readonly captures: CaptureIndex,
    private readonly unicode: boolean,
    private readonly charge: () => void
  ) {}

  emit(instruction: Instruction): number {
    this.charge();
    this.program.push(instruction);
    return this.program.length - 1;
  }

  alternatives(alternatives: readonly AST.Alternative[], context: Context): void {
    const jumps: Extract<Instruction, { op: 'jump' }>[] = [];
    for (const [position, alternative] of alternatives.entries()) {
      if (position === alternatives.length - 1) {
        this.sequence(alternative.elements, context);
        break;
      }
      const split: Extract<Instruction, { op: 'split' }> = { op: 'split', first: this.program.length + 1, second: 0 };
      this.emit(split);
      this.sequence(alternative.elements, context);
      const jump: Extract<Instruction, { op: 'jump' }> = { op: 'jump', to: 0 };
      this.emit(jump);
      jumps.push(jump);
      split.second = this.program.length;
    }
    for (const jump of jumps) jump.to = this.program.length;
  }

  private sequence(elements: readonly AST.Element[], context: Context): void {
    const ordered = context.backward ? elements.toReversed() : elements;
    for (const element of ordered) this.element(element, context);
  }

  private element(element: AST.Element, context: Context): void {
    switch (element.type) {
      case 'Character':
      case 'CharacterClass':
      case 'CharacterSet':
      case 'ExpressionCharacterClass': {
        this.emit({ op: 'char', test: this.charTest(element, context) });
        return;
      }
      case 'Group': {
        this.alternatives(element.alternatives, element.modifiers ? modified(context, element.modifiers) : context);
        return;
      }
      case 'CapturingGroup': {
        const group = this.captureNumber(element);
        this.emit({ op: 'save', register: 2 * group + (context.backward ? 1 : 0) });
        this.alternatives(element.alternatives, context);
        this.emit({ op: 'save', register: 2 * group + (context.backward ? 0 : 1) });
        return;
      }
      case 'Quantifier': {
        this.quantifier(element, context);
        return;
      }
      case 'Assertion': {
        this.assertion(element, context);
        return;
      }
      case 'Backreference': {
        const resolved = element.ambiguous ? element.resolved : [element.resolved];
        this.emit({
          op: 'backref',
          groups: resolved.map((group) => this.captureNumber(group)),
          backward: context.backward,
          equal: context.ignoreCase ? caseInsensitiveEqual(context.unicode) : (a, b) => a === b,
        });
        return;
      }
    }
  }

  private captureNumber(group: AST.CapturingGroup): number {
    this.charge();
    return this.captures.numbers.get(group) as number;
  }

  /** ECMAScript's RepeatMatcher: a counted loop that clears its groups each iteration and stops on an empty one. */
  private quantifier(element: AST.Quantifier, context: Context): void {
    if (element.max === 0) return;
    const loop = this.loops++;
    const count = 2 * (this.captures.numbers.size + 1) + 2 * loop;
    const range = this.captures.loops.get(element);
    this.emit({ op: 'loopInit', count });
    const decide: Extract<Instruction, { op: 'loop' }> = {
      op: 'loop',
      count,
      min: element.min,
      max: element.max,
      greedy: element.greedy,
      enter: 0,
      exit: 0,
    };
    const decideAt = this.emit(decide);
    decide.enter = this.emit({
      op: 'loopEnter',
      start: count + 1,
      firstRegister: range?.firstRegister ?? 0,
      endRegister: range?.endRegister ?? 0,
    });
    this.element(element.element, context);
    this.emit({ op: 'loopEnd', count, start: count + 1, min: element.min, decide: decideAt });
    decide.exit = this.program.length;
  }

  private assertion(element: AST.Assertion, context: Context): void {
    switch (element.kind) {
      case 'start': {
        const { multiLine } = context;
        this.emit({
          op: 'assert',
          test: (input, position) => position === 0 || (multiLine && isLineTerminator(codeUnitAt(input, position - 1))),
        });
        return;
      }
      case 'end': {
        const { multiLine } = context;
        this.emit({
          op: 'assert',
          test: (input, position) =>
            position === input.length || (multiLine && isLineTerminator(codeUnitAt(input, position))),
        });
        return;
      }
      case 'word': {
        const word = hostTest(String.raw`\w`, context, false);
        const { negate } = element;
        this.emit({
          op: 'assert',
          test: (input, position) => {
            const before = position > 0 && word(input, position - 1) >= 0;
            const after = position < input.length && word(input, position) >= 0;
            return (before !== after) !== negate;
          },
        });
        return;
      }
      case 'lookahead':
      case 'lookbehind': {
        const look: Extract<Instruction, { op: 'look' }> = { op: 'look', negative: element.negate, next: 0 };
        this.emit(look);
        this.alternatives(element.alternatives, { ...context, backward: element.kind === 'lookbehind' });
        this.emit({ op: 'succeed' });
        look.next = this.program.length;
        return;
      }
    }
  }

  private charTest(
    element: AST.Character | AST.CharacterClass | AST.CharacterSet | AST.ExpressionCharacterClass,
    context: Context
  ): CharTest {
    if (element.type === 'Character' && !context.ignoreCase) {
      return literalTest(element.value, this.unicode, context.backward);
    }
    // A character stands alone by its code point, since its escape may read differently out of its context.
    const source =
      element.type === 'Character'
        ? this.unicode
          ? String.raw`\u{${element.value.toString(16)}}`
          : String.raw`\u${element.value.toString(16).padStart(4, '0')}`
        : element.raw;
    const key = `${flagsOf(context)}${context.backward ? '<' : '>'}${source}`;
    let test = this.testCache.get(key);
    if (!test) {
      test = hostTest(source, context, context.backward);
      this.testCache.set(key, test);
    }
    return test;
  }
}

function modified(context: Context, modifiers: AST.Modifiers): Context {
  const result = { ...context };
  for (const [flags, value] of [
    [modifiers.add, true],
    [modifiers.remove, false],
  ] as const) {
    if (!flags) continue;
    if (flags.ignoreCase) result.ignoreCase = value;
    if (flags.multiline) result.multiLine = value;
    if (flags.dotAll) result.dotAll = value;
  }
  return result;
}

function indexCaptures(pattern: AST.Pattern, charge: () => void): CaptureIndex {
  const numbers = new Map<AST.CapturingGroup, number>();
  const loops: CaptureIndex['loops'] = new Map();
  const visit = (node: AST.Node): void => {
    charge();
    const first = numbers.size + 1;
    if (node.type === 'CapturingGroup') numbers.set(node, first);
    for (const child of childrenOf(node)) visit(child);
    if (node.type === 'Quantifier' && first <= numbers.size)
      loops.set(node, { firstRegister: 2 * first, endRegister: 2 * numbers.size + 2 });
  };
  visit(pattern);
  return { numbers, loops };
}

function childrenOf(node: AST.Node): readonly AST.Node[] {
  switch (node.type) {
    case 'Pattern':
    case 'Group':
    case 'CapturingGroup': {
      return node.alternatives;
    }
    case 'Assertion': {
      return node.kind === 'lookahead' || node.kind === 'lookbehind' ? node.alternatives : [];
    }
    case 'Alternative': {
      return node.elements;
    }
    case 'Quantifier': {
      return [node.element];
    }
    default: {
      return [];
    }
  }
}

function flagsOf(context: RegExpFlags): string {
  return `${context.ignoreCase ? 'i' : ''}${context.multiLine ? 'm' : ''}${context.unicode ? 'u' : ''}${context.dotAll ? 's' : ''}`;
}

/** A test of one atom by a sticky host RegExp of that atom alone, which matches at most one character. */
function hostTest(source: string, flags: RegExpFlags, backward: boolean): CharTest {
  const regex = new RegExp(source, `${flagsOf(flags)}y`);
  const forward = (input: string, position: number): number => {
    // A sticky host RegExp in Unicode mode steps back to the pair's start, but no character starts inside a pair.
    if (flags.unicode && isSurrogatePairAt(input, position - 1)) return -1;
    regex.lastIndex = position;
    return regex.test(input) ? regex.lastIndex : -1;
  };
  if (!backward) return forward;
  return (input, position) => {
    if (position === 0) return -1;
    const start = flags.unicode && isSurrogatePairAt(input, position - 2) ? position - 2 : position - 1;
    return forward(input, start) === position ? start : -1;
  };
}

function literalTest(codePoint: number, unicode: boolean, backward: boolean): CharTest {
  const width = codePoint > 0xff_ff ? 2 : 1;
  const matchesAt = (input: string, start: number): boolean => {
    if (!unicode) return codeUnitAt(input, start) === codePoint;
    // In Unicode mode the input is code points, so a lone surrogate does not match half of a pair.
    if (width === 1 && (isSurrogatePairAt(input, start) || isSurrogatePairAt(input, start - 1))) return false;
    return input.codePointAt(start) === codePoint;
  };
  if (backward) {
    return (input, position) => {
      const start = position - width;
      return start >= 0 && matchesAt(input, start) ? start : -1;
    };
  }
  return (input, position) => (position + width <= input.length && matchesAt(input, position) ? position + width : -1);
}

/** Whether two code units (code points, in Unicode mode) canonicalize alike, as `/a/i` matching `b` tells. */
function caseInsensitiveEqual(unicode: boolean): (a: number, b: number) => boolean {
  const cache = new Map<number, RegExp>();
  return (a, b) => {
    if (a === b) return true;
    let regex = cache.get(a);
    if (!regex) {
      regex = unicode
        ? new RegExp(String.raw`^\u{${a.toString(16)}}$`, 'iu')
        : new RegExp(String.raw`^\u${a.toString(16).padStart(4, '0')}$`, 'i');
      cache.set(a, regex);
    }
    return regex.test(String.fromCodePoint(b));
  };
}

/** A UTF-16 code unit, which non-Unicode patterns and line terminators read. */
function codeUnitAt(text: string, position: number): number {
  // oxlint-disable-next-line unicorn/prefer-code-point -- Patterns outside Unicode mode match UTF-16 code units.
  return text.charCodeAt(position);
}

/** Whether two spans of the input read alike, character by character, under `equal`. */
function sameText(
  input: string,
  from: number,
  start: number,
  length: number,
  unicode: boolean,
  equal: (a: number, b: number) => boolean
): boolean {
  for (let offset = 0; offset < length;) {
    const expected = unicode ? (input.codePointAt(from + offset) as number) : codeUnitAt(input, from + offset);
    const actual = unicode ? (input.codePointAt(start + offset) as number) : codeUnitAt(input, start + offset);
    if (!equal(expected, actual)) return false;
    offset += expected > 0xff_ff ? 2 : 1;
  }
  return true;
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x20_28 || code === 0x20_29;
}

export function isSurrogatePairAt(input: string, position: number): boolean {
  if (position < 0 || position + 1 >= input.length) return false;
  const high = codeUnitAt(input, position);
  const low = codeUnitAt(input, position + 1);
  return high >= 0xd8_00 && high <= 0xdb_ff && low >= 0xdc_00 && low <= 0xdf_ff;
}

class Machine {
  readonly registers: Int32Array;
  private scratch = new Int32Array(0);
  private undoLength = 0;
  private choiceLength = 0;
  private position = 0;

  constructor(
    private readonly compiled: CompiledRegExp,
    private readonly input: string,
    private readonly charge: () => void,
    private readonly scratchSlots: number
  ) {
    if (compiled.registerCount > scratchSlots) throw new ExecutionLimitError('storage');
    this.registers = new Int32Array(compiled.registerCount);
  }

  /** Matches from one start position, giving the end or -1. */
  attempt(start: number): number {
    this.registers.fill(-1);
    this.undoLength = 0;
    return this.run(0, start);
  }

  private run(startPc: number, startPosition: number): number {
    const { program } = this.compiled;
    const undoBase = this.undoLength;
    const choiceBase = this.choiceLength;
    let pc = startPc;
    this.position = startPosition;
    try {
      for (;;) {
        this.charge();
        const instruction = program[pc];
        if (instruction.op === 'succeed') return this.position;
        pc = this.step(instruction, pc);
        if (pc >= 0) continue;
        if (this.choiceLength === choiceBase) {
          this.undo(undoBase);
          return -1;
        }
        const choice = this.scratch.length - this.choiceLength;
        this.choiceLength -= 3;
        pc = this.scratch[choice];
        this.position = this.scratch[choice + 1];
        this.undo(this.scratch[choice + 2]);
      }
    } finally {
      this.choiceLength = choiceBase;
    }
  }

  /** Runs one instruction, giving the next pc or -1 to backtrack. */
  // code-gauge-allow functionNcss -- The machine's dispatch, one case per instruction.
  private step(instruction: Exclude<Instruction, { op: 'succeed' }>, pc: number): number {
    const { registers, position } = this;
    switch (instruction.op) {
      case 'char': {
        return this.advanceTo(instruction.test(this.input, position), pc);
      }
      case 'backref': {
        return this.advanceTo(this.backreference(instruction, position), pc);
      }
      case 'split': {
        this.pushChoice(instruction.second);
        return instruction.first;
      }
      case 'jump': {
        return instruction.to;
      }
      case 'save': {
        this.set(instruction.register, position);
        return pc + 1;
      }
      case 'assert': {
        return instruction.test(this.input, position) ? pc + 1 : -1;
      }
      case 'look': {
        const mark = this.undoLength;
        const matched = this.run(pc + 1, position) >= 0;
        this.position = position;
        if (matched !== instruction.negative) return instruction.next;
        this.undo(mark);
        return -1;
      }
      case 'loopInit': {
        this.set(instruction.count, 0);
        return pc + 1;
      }
      case 'loop': {
        return this.decide(instruction);
      }
      case 'loopEnter': {
        for (let register = instruction.firstRegister; register < instruction.endRegister; register++) {
          if (registers[register] !== -1) this.set(register, -1);
        }
        this.set(instruction.start, position);
        return pc + 1;
      }
      case 'loopEnd': {
        const count = registers[instruction.count];
        // An iteration past the minimum that matched nothing fails, which ends loops over empty matches.
        if (count >= instruction.min && position === registers[instruction.start]) return -1;
        this.set(instruction.count, count + 1);
        return instruction.decide;
      }
    }
  }

  private advanceTo(next: number, pc: number): number {
    if (next < 0) return -1;
    this.position = next;
    return pc + 1;
  }

  /** Whether a loop runs another iteration: required below its minimum, a choice between its minimum and maximum. */
  private decide(instruction: Extract<Instruction, { op: 'loop' }>): number {
    const count = this.registers[instruction.count];
    if (count < instruction.min) return instruction.enter;
    if (count >= instruction.max) return instruction.exit;
    const [first, second] = instruction.greedy
      ? [instruction.enter, instruction.exit]
      : [instruction.exit, instruction.enter];
    this.pushChoice(second);
    return first;
  }

  private backreference(instruction: Extract<Instruction, { op: 'backref' }>, position: number): number {
    const { registers, input } = this;
    const group = instruction.groups.find((number) => registers[2 * number] >= 0 && registers[2 * number + 1] >= 0);
    if (group === undefined) return position;
    const from = registers[2 * group];
    const length = registers[2 * group + 1] - from;
    const start = instruction.backward ? position - length : position;
    if (start < 0 || start + length > input.length) return -1;
    if (!sameText(input, from, start, length, this.compiled.unicode, instruction.equal)) return -1;
    return instruction.backward ? start : start + length;
  }

  private set(register: number, value: number): void {
    this.reserve(2);
    this.scratch[this.undoLength++] = register;
    this.scratch[this.undoLength++] = this.registers[register];
    this.registers[register] = value;
  }

  private undo(length: number): void {
    while (this.undoLength > length) {
      const value = this.scratch[--this.undoLength];
      this.registers[this.scratch[--this.undoLength]] = value;
    }
  }

  private pushChoice(pc: number): void {
    this.reserve(3);
    this.choiceLength += 3;
    const start = this.scratch.length - this.choiceLength;
    this.scratch[start] = pc;
    this.scratch[start + 1] = this.position;
    this.scratch[start + 2] = this.undoLength;
  }

  private reserve(slots: number): void {
    const needed = this.undoLength + this.choiceLength + slots;
    if (needed <= this.scratch.length) return;
    const maximum = this.scratchSlots - this.registers.length;
    if (needed > maximum) throw new ExecutionLimitError('storage');
    const capacity = Math.min(maximum, Math.max(64, needed, 2 * this.scratch.length));
    const next = new Int32Array(capacity);
    // The undo trail grows from the start and choices from the end so they share the same limit.
    next.set(this.scratch.subarray(0, this.undoLength));
    next.set(this.scratch.subarray(this.scratch.length - this.choiceLength), capacity - this.choiceLength);
    this.scratch = next;
  }
}
