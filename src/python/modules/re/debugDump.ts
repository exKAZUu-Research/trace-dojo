// What `re.DEBUG` prints: `SubPattern.dump` of re._parser and `dis` of re._compiler, as text.
import { callValue } from '../../objects';
import { currentRuntime } from '../../runtimeContext';
import { strRepr } from '../../strings';
import type { PyValue } from '../../values';
import { MAXREPEAT } from './constants';
import { AT_NAMES, CATEGORY_NAMES, OPCODE_NAMES } from './debugCode';
import type { Item, SubPattern } from './parser';

/** Writes text as `print(text, end='')` does, to the program's `sys.stdout`. */
export function printText(text: string): void {
  callValue(currentRuntime().builtins.get('print') as PyValue, [text], new Map([['end', '']]));
}

/** `SubPattern.dump`. */
export function dumpPattern(pattern: SubPattern, level = 0): string {
  let text = '';
  for (const item of pattern.data) text += dumpItem(item, level);
  return text;
}

const indent = (level: number): string => '  '.repeat(level);
const repeatBound = (value: number): string => (value === MAXREPEAT ? 'MAXREPEAT' : String(value));

// code-gauge-allow functionNcss 32 -- One case per kind of argument, as SubPattern.dump has.
function dumpItem(item: Item, level: number): string {
  const head = indent(level) + item.op;
  switch (item.op) {
    case 'IN': {
      return `${head}\n${item.set.map((each) => `${indent(level + 1)}${setItemText(each)}\n`).join('')}`;
    }
    case 'BRANCH': {
      return `${head}\n${item.branches.map((branch) => dumpPattern(branch, level + 1)).join(`${indent(level)}OR\n`)}`;
    }
    case 'GROUPREF_EXISTS': {
      const no = item.no && item.no.data.length > 0 ? `${indent(level)}ELSE\n${dumpPattern(item.no, level + 1)}` : '';
      return `${head} ${item.group}\n${dumpPattern(item.yes, level + 1)}${no}`;
    }
    case 'ATOMIC_GROUP': {
      return `${head}\n${dumpPattern(item.pattern, level + 1)}`;
    }
    case 'SUBPATTERN': {
      const group = item.group === undefined ? 'None' : String(item.group);
      return `${head} ${group} ${item.addFlags} ${item.delFlags}\n${dumpPattern(item.pattern, level + 1)}`;
    }
    case 'MAX_REPEAT':
    case 'MIN_REPEAT':
    case 'POSSESSIVE_REPEAT': {
      return `${head} ${item.min} ${repeatBound(item.max)}\n${dumpPattern(item.item, level + 1)}`;
    }
    case 'ASSERT':
    case 'ASSERT_NOT': {
      return `${head} ${item.dir}\n${dumpPattern(item.pattern, level + 1)}`;
    }
    case 'FAILURE': {
      return `${head}\n`;
    }
    case 'ANY': {
      return `${head} None\n`;
    }
    case 'AT': {
      return `${head} AT_${item.at}\n`;
    }
    case 'GROUPREF': {
      return `${head} ${item.group}\n`;
    }
    default: {
      return `${head} ${item.code}\n`;
    }
  }
}

function setItemText(item: Extract<Item, { op: 'IN' }>['set'][number]): string {
  switch (item.op) {
    case 'LITERAL': {
      return `LITERAL ${item.code}`;
    }
    case 'RANGE': {
      return `RANGE (${item.lo}, ${item.hi})`;
    }
    case 'CATEGORY': {
      return `CATEGORY ${CATEGORY_NAMES[item.category]}`;
    }
    case 'NEGATE': {
      return 'NEGATE None';
    }
  }
}

const NO_ARGUMENT = new Set(['SUCCESS', 'FAILURE', 'ANY', 'ANY_ALL', 'MAX_UNTIL', 'MIN_UNTIL', 'NEGATE']);
const LITERALS = new Set([
  'LITERAL',
  'NOT_LITERAL',
  'LITERAL_IGNORE',
  'NOT_LITERAL_IGNORE',
  'LITERAL_UNI_IGNORE',
  'NOT_LITERAL_UNI_IGNORE',
  'LITERAL_LOC_IGNORE',
  'NOT_LITERAL_LOC_IGNORE',
]);
const NUMBER_ARGUMENT = new Set(['MARK', 'GROUPREF', 'GROUPREF_IGNORE', 'GROUPREF_UNI_IGNORE', 'GROUPREF_LOC_IGNORE']);
const REPEATS = new Set(['REPEAT', 'REPEAT_ONE', 'MIN_REPEAT_ONE', 'POSSESSIVE_REPEAT', 'POSSESSIVE_REPEAT_ONE']);

const hex = (value: number): string => `0x${value.toString(16)}`;
const charRepr = (code: number): string => strRepr(String.fromCodePoint(code));
const hexCode = (words: number[]): string =>
  `[${words.map((word) => `0x${word.toString(16).padStart(8, '0')}`).join(', ')}]`;

/** `re._compiler.dis`. */
export function disassemble(code: number[]): string {
  return new Disassembler(code).run();
}

class Disassembler {
  private readonly labels = new Set<number>();
  private level = 0;
  private output = '';
  private readonly offsetWidth: number;

  constructor(private readonly code: number[]) {
    this.offsetWidth = String(code.length - 1).length;
  }

  run(): string {
    this.dis(0, this.code.length);
    return this.output;
  }

  private print(start: number, args: (string | number)[], to?: number): void {
    const parts = [...args];
    if (to !== undefined) {
      this.labels.add(to);
      parts.push(`(to ${to})`);
    }
    const mark = this.labels.has(start) ? ':' : '.';
    this.output += `${String(start).padStart(this.offsetWidth)}${mark} ${'  '.repeat(this.level - 1)}${parts.join(' ')}\n`;
  }

  private print2(args: string[]): void {
    this.output += `${' '.repeat(this.offsetWidth + 2 * this.level)}${args.join(' ')}\n`;
  }

  private dis(from: number, end: number): void {
    this.level++;
    for (let index = from; index < end;) index = this.instruction(index);
    this.level--;
  }

  /** Prints the instruction at `start`, returning the position of the next one. */
  private instruction(start: number): number {
    const { code } = this;
    const name = OPCODE_NAMES[code[start]];
    const i = start + 1;
    if (NO_ARGUMENT.has(name)) {
      this.print(start, [name]);
      return i;
    }
    if (LITERALS.has(name)) {
      this.print(start, [name, `${hex(code[i])} (${charRepr(code[i])})`]);
      return i + 1;
    }
    if (NUMBER_ARGUMENT.has(name)) {
      this.print(start, [name, code[i]]);
      return i + 1;
    }
    return this.structured(name, start);
  }

  /** Prints an instruction with a named argument, a skip, or a nested body. */
  // code-gauge-allow functionNcss 48 -- One case per kind of opcode, as re._compiler.dis has.
  private structured(name: string, start: number): number {
    const { code } = this;
    const i = start + 1;
    switch (name) {
      case 'AT': {
        this.print(start, [name, AT_NAMES[code[i]].slice(3)]);
        return i + 1;
      }
      case 'CATEGORY': {
        this.print(start, [name, CATEGORY_NAMES[code[i]].slice(9)]);
        return i + 1;
      }
      case 'RANGE':
      case 'RANGE_UNI_IGNORE': {
        const [lo, hi] = [code[i], code[i + 1]];
        this.print(start, [name, `${hex(lo)} ${hex(hi)} (${charRepr(lo)}-${charRepr(hi)})`]);
        return i + 2;
      }
      case 'CHARSET': {
        this.print(start, [name, hexCode(code.slice(i, i + 8))]);
        return i + 8;
      }
      case 'JUMP': {
        this.print(start, [name, code[i]], i + code[i]);
        return i + 1;
      }
      case 'GROUPREF_EXISTS': {
        const [arg, skip] = [code[i], code[i + 1]];
        this.print(start, [name, arg, skip], i + skip);
        return i + 2;
      }
      case 'BIGCHARSET': {
        return this.bigCharset(start);
      }
      case 'BRANCH': {
        return this.branch(start);
      }
      case 'INFO': {
        return this.info(start);
      }
      default: {
        return this.nested(name, start);
      }
    }
  }

  /** Prints an instruction whose body follows it, and the body. */
  private nested(name: string, start: number): number {
    const { code } = this;
    const i = start + 1;
    const skip = code[i];
    if (REPEATS.has(name)) {
      this.print(start, [name, skip, code[i + 1], repeatBound(code[i + 2])], i + skip);
      this.dis(i + 3, i + skip);
    } else if (name === 'ASSERT' || name === 'ASSERT_NOT') {
      this.print(start, [name, skip, code[i + 1]], i + skip);
      this.dis(i + 2, i + skip);
    } else {
      this.print(start, [name, skip], i + skip);
      this.dis(i + 1, i + skip);
    }
    return i + skip;
  }

  private bigCharset(start: number): number {
    const { code } = this;
    let i = start + 1;
    const blocks = code[i];
    i++;
    const mapping: number[] = [];
    for (const word of code.slice(i, i + 64))
      mapping.push(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24);
    this.print(start, ['BIGCHARSET', blocks, `[${mapping.join(', ')}]`]);
    i += 64;
    this.level++;
    for (let block = 0; block < blocks; block++) {
      this.print2([hexCode(code.slice(i, i + 8))]);
      i += 8;
    }
    this.level--;
    return i;
  }

  private branch(start: number): number {
    const { code } = this;
    let i = start + 1;
    let skip = code[i];
    this.print(start, ['BRANCH', skip], i + skip);
    while (skip) {
      this.dis(i + 1, i + skip);
      i += skip;
      skip = code[i];
      if (skip) this.print(i, ['branch', skip], i + skip);
      else this.print(i, ['FAILURE']);
    }
    return i + 1;
  }

  private info(start: number): number {
    const { code } = this;
    const i = start + 1;
    const [skip, flags, min, max] = [code[i], code[i + 1], code[i + 2], code[i + 3]];
    this.print(start, ['INFO', skip, `0b${flags.toString(2)}`, min, repeatBound(max)], i + skip);
    let from = i + 4;
    if (flags & 1) {
      const [length, prefixSkip] = [code[i + 4], code[i + 5]];
      this.print2(['  prefix_skip', String(prefixSkip)]);
      from = i + 6;
      const prefix = code.slice(from, from + length);
      const text = strRepr(prefix.map((each) => String.fromCodePoint(each)).join(''));
      this.print2(['  prefix', `[${prefix.map(hex).join(', ')}]`, `(${text})`]);
      from += length;
      this.print2(['  overlap', `[${code.slice(from, from + length).join(', ')}]`]);
      from += length;
    }
    if (flags & 4) {
      this.level++;
      this.print2(['in']);
      this.dis(from, i + skip);
      this.level--;
    }
    return i + skip;
  }
}
