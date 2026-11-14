// The groups and extensions `(...)`, `(?...)` of CPython's `re._parser._parse`.
import { strRepr } from '../../strings';
import { FLAG, MAXGROUPS, TYPE_FLAGS } from './constants';
import { parseSequence, type ParseState, parseSub, type SubPattern } from './parser';
import { codePointLength, PatternSyntaxError, type Tokenizer } from './tokenizer';

const FLAGS: Record<string, number> = {
  i: FLAG.IGNORECASE,
  L: FLAG.LOCALE,
  m: FLAG.MULTILINE,
  s: FLAG.DOTALL,
  x: FLAG.VERBOSE,
  a: FLAG.ASCII,
  u: FLAG.UNICODE,
};

const GLOBAL_FLAGS = FLAG.DEBUG;

export interface GroupContext {
  verbose: boolean;
  nested: number;
  first: boolean;
}

/** Parses what follows `(`, returning the new verbose mode when global flags changed it. */
// code-gauge-allow functionNcss 33 -- Transcribes the group branch of re._parser._parse in its order.
// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes the group branch of re._parser._parse in its order.
export function parseGroup(
  source: Tokenizer,
  state: ParseState,
  subpattern: SubPattern,
  context: GroupContext
): boolean | undefined {
  const start = source.tell() - 1;
  let group: { capture: boolean; atomic: boolean; name?: string; addFlags: number; delFlags: number } = {
    capture: true,
    atomic: false,
    addFlags: 0,
    delFlags: 0,
  };
  if (source.match('?')) {
    const char = source.get();
    if (char === undefined) throw source.error('unexpected end of pattern');
    const extension = parseExtension(source, state, subpattern, { ...context, start, char });
    if (extension === 'done') return undefined;
    if (extension === 'global') {
      if (!context.first || subpattern.data.length > 0)
        throw source.error('global flags not at the start of the expression', source.tell() - start);
      return (state.flags & FLAG.VERBOSE) !== 0;
    }
    group = { ...group, ...extension };
  }
  let gid: number | undefined;
  if (group.capture) {
    try {
      gid = state.opengroup(group.name);
    } catch (error) {
      if (!(error instanceof PatternSyntaxError)) throw error;
      throw source.error(error.msg, codePointLength(group.name ?? '') + 1);
    }
  }
  const subVerbose = (context.verbose || (group.addFlags & FLAG.VERBOSE) !== 0) && !(group.delFlags & FLAG.VERBOSE);
  const pattern = parseSub(source, state, subVerbose, context.nested + 1);
  if (!source.match(')')) throw source.error('missing ), unterminated subpattern', source.tell() - start);
  if (gid !== undefined) state.closegroup(gid, pattern);
  if (group.atomic) subpattern.data.push({ op: 'ATOMIC_GROUP', pattern });
  else
    subpattern.data.push({ op: 'SUBPATTERN', group: gid, addFlags: group.addFlags, delFlags: group.delFlags, pattern });
  return undefined;
}

type Extension =
  | 'done'
  | 'global'
  | { capture: boolean; atomic?: boolean; name?: string; addFlags?: number; delFlags?: number };

/** Parses the extension after `(?`: `done` when it added an item itself, or how to parse the group. */
// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes the `(?` branches of re._parser._parse in order.
function parseExtension(
  source: Tokenizer,
  state: ParseState,
  subpattern: SubPattern,
  context: GroupContext & { start: number; char: string }
): Extension {
  const { char, start } = context;
  if (char === 'P') return parsePythonExtension(source, state, subpattern);
  if (char === ':') return { capture: false };
  if (char === '#') {
    for (;;) {
      if (source.next === undefined) throw source.error('missing ), unterminated comment', source.tell() - start);
      if (source.get() === ')') return 'done';
    }
  }
  if (char === '=' || char === '!' || char === '<') {
    parseLookaround(source, state, subpattern, context);
    return 'done';
  }
  if (char === '(') {
    parseConditional(source, state, subpattern, context);
    return 'done';
  }
  if (char === '>') return { capture: false, atomic: true };
  if (FLAGS[char] !== undefined || char === '-') {
    const flags = parseFlags(source, state, char);
    if (flags === undefined) return 'global';
    return { capture: false, addFlags: flags[0], delFlags: flags[1] };
  }
  throw source.error(`unknown extension ?${char}`, codePointLength(char) + 1);
}

function parsePythonExtension(source: Tokenizer, state: ParseState, subpattern: SubPattern): Extension {
  if (source.match('<')) {
    const name = source.getuntil('>', 'group name');
    source.checkgroupname(name, 1);
    return { capture: true, name };
  }
  if (source.match('=')) {
    const name = source.getuntil(')', 'group name');
    source.checkgroupname(name, 1);
    const gid = state.groupdict.get(name);
    if (gid === undefined) throw source.error(`unknown group name ${strRepr(name)}`, codePointLength(name) + 1);
    if (!state.checkgroup(gid)) throw source.error('cannot refer to an open group', codePointLength(name) + 1);
    state.checklookbehindgroup(gid, source);
    subpattern.data.push({ op: 'GROUPREF', group: gid });
    return 'done';
  }
  const char = source.get();
  if (char === undefined) throw source.error('unexpected end of pattern');
  throw source.error(`unknown extension ?P${char}`, codePointLength(char) + 2);
}

function parseLookaround(
  source: Tokenizer,
  state: ParseState,
  subpattern: SubPattern,
  context: GroupContext & { start: number; char: string }
): void {
  let { char } = context;
  let dir: 1 | -1 = 1;
  const outerLookbehind = state.lookbehindgroups;
  if (char === '<') {
    const next = source.get();
    if (next === undefined) throw source.error('unexpected end of pattern');
    if (next !== '=' && next !== '!') throw source.error(`unknown extension ?<${next}`, codePointLength(next) + 2);
    char = next;
    dir = -1;
    if (outerLookbehind === undefined) state.lookbehindgroups = state.groups;
  }
  const pattern = parseSub(source, state, context.verbose, context.nested + 1);
  if (dir < 0 && outerLookbehind === undefined) state.lookbehindgroups = undefined;
  if (!source.match(')')) throw source.error('missing ), unterminated subpattern', source.tell() - context.start);
  if (char === '=') subpattern.data.push({ op: 'ASSERT', dir, pattern });
  else if (pattern.data.length > 0) subpattern.data.push({ op: 'ASSERT_NOT', dir, pattern });
  else subpattern.data.push({ op: 'FAILURE' });
}

function parseConditional(
  source: Tokenizer,
  state: ParseState,
  subpattern: SubPattern,
  context: GroupContext & { start: number }
): void {
  const condname = source.getuntil(')', 'group name');
  const nameLength = codePointLength(condname);
  let condgroup: number;
  if (/^[0-9]+$/.test(condname)) {
    const number = BigInt(condname);
    if (number === 0n) throw source.error('bad group number', nameLength + 1);
    if (number >= BigInt(MAXGROUPS)) throw source.error(`invalid group reference ${number}`, nameLength + 1);
    condgroup = Number(number);
    if (!state.grouprefpos.has(condgroup)) state.grouprefpos.set(condgroup, source.tell() - nameLength - 1);
  } else {
    source.checkgroupname(condname, 1);
    const found = state.groupdict.get(condname);
    if (found === undefined) throw source.error(`unknown group name ${strRepr(condname)}`, nameLength + 1);
    condgroup = found;
  }
  state.checklookbehindgroup(condgroup, source);
  const yes = parseSequence(source, state, context.verbose, context.nested + 1);
  let no: SubPattern | undefined;
  if (source.match('|')) {
    no = parseSequence(source, state, context.verbose, context.nested + 1);
    if (source.next === '|') throw source.error('conditional backref with more than two branches');
  }
  if (!source.match(')')) throw source.error('missing ), unterminated subpattern', source.tell() - context.start);
  subpattern.data.push({ op: 'GROUPREF_EXISTS', group: condgroup, yes, no });
}

/** Parses inline flags, returning undefined for global flags `(?x)` or the flags a scoped group adds and removes. */
function parseFlags(source: Tokenizer, state: ParseState, first: string): [number, number] | undefined {
  const [addFlags, end] = first === '-' ? [0, first] : parseAddedFlags(source, first);
  if (end === ')') {
    state.flags |= addFlags;
    return undefined;
  }
  if (addFlags & GLOBAL_FLAGS) throw source.error('bad inline flags: cannot turn on global flag', 1);
  const delFlags = end === '-' ? parseRemovedFlags(source) : 0;
  if (addFlags & delFlags) throw source.error('bad inline flags: flag turned on and off', 1);
  return [addFlags, delFlags];
}

/** Parses the flags before `-`, `:`, or `)`, returning them with the character that ends them. */
// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes re._parser._parse_flags and its error order.
function parseAddedFlags(source: Tokenizer, first: string): [number, string] {
  let char = first;
  let addFlags = 0;
  for (;;) {
    const flag = FLAGS[char];
    if (char === 'L' && source.isText) throw source.error("bad inline flags: cannot use 'L' flag with a str pattern");
    if (char === 'u' && !source.isText)
      throw source.error("bad inline flags: cannot use 'u' flag with a bytes pattern");
    addFlags |= flag;
    if (flag & TYPE_FLAGS && (addFlags & TYPE_FLAGS) !== flag)
      throw source.error("bad inline flags: flags 'a', 'u' and 'L' are incompatible");
    const next = source.get();
    if (next === undefined) throw source.error('missing -, : or )');
    if (next === ')' || next === '-' || next === ':') return [addFlags, next];
    if (FLAGS[next] === undefined)
      throw source.error(isAlpha(next) ? 'unknown flag' : 'missing -, : or )', codePointLength(next));
    char = next;
  }
}

/** Parses the flags between `-` and `:`. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes re._parser._parse_flags and its error order.
function parseRemovedFlags(source: Tokenizer): number {
  let char = source.get();
  if (char === undefined) throw source.error('missing flag');
  if (FLAGS[char] === undefined)
    throw source.error(isAlpha(char) ? 'unknown flag' : 'missing flag', codePointLength(char));
  let delFlags = 0;
  for (;;) {
    const flag = FLAGS[char];
    if (flag & TYPE_FLAGS) throw source.error("bad inline flags: cannot turn off flags 'a', 'u' and 'L'");
    delFlags |= flag;
    char = source.get();
    if (char === undefined) throw source.error('missing :');
    if (char === ':') return delFlags;
    if (FLAGS[char] === undefined)
      throw source.error(isAlpha(char) ? 'unknown flag' : 'missing :', codePointLength(char));
  }
}

/** `str.isalpha()` for a token, which is false for an escape such as `\d`. */
function isAlpha(token: string): boolean {
  return /^\p{L}+$/u.test(token);
}
