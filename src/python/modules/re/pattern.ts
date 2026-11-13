// `re.Pattern`, `re.PatternError`, and the scanner behind `finditer`, as CPython's `_sre` module defines them.
import { bytesLikeData, latin1Text, PyBytes } from '../../bytesValues';
import { pyRepr, pyStr } from '../../conversions';
import { keyError } from '../../items';
import { toIndex } from '../../numbers';
import { callValue, isCallable } from '../../objects';
import { currentRuntime } from '../../runtimeContext';
import {
  builtinClass,
  defineMethod,
  dictClass,
  exceptionClassNamed,
  iteratorClass,
  newDict,
  newException,
  newTuple,
  None,
  NotImplemented,
  pyError,
  typeError,
  typeName,
  unbox,
  valueError,
} from '../../types';
import { DONE, type Kwargs, PyDict, PyError, PyIterator, PyObject, type PyValue } from '../../values';
import { builtinClassWithBase } from '../moduleClasses';
import { clinicArgs, pythonArgs } from './arguments';
import { readOnlyAttribute } from './attributes';
import { compilePattern, type Program } from './compiler';
import { FLAG } from './constants';
import { debugCode } from './debugCode';
import { disassemble, dumpPattern, printText } from './debugDump';
import { compileTemplate, expandTemplate, MatchObject, newMatch, truncate } from './match';
import { type Budget, Matcher, MatchState } from './matcher';
import { parse, type SubPattern } from './parser';
import { joinPieces, sliceOf, type Subject, toSubject } from './subject';
import { PatternSyntaxError, Tokenizer } from './tokenizer';

export const patternErrorClass = builtinClassWithBase('PatternError', exceptionClassNamed('Exception'), 're');

patternErrorClass.construct = (cls, args, kwargs) => {
  const bound = pythonArgs(
    'PatternError.__init__',
    [
      { name: 'msg', kind: 'positional' },
      { name: 'pattern', kind: 'positional', default: None },
      { name: 'pos', kind: 'positional', default: None },
    ],
    args,
    kwargs
  );
  return newPatternError(
    bound.get('msg') as PyValue,
    bound.get('pattern') as PyValue,
    bound.get('pos') as PyValue,
    cls
  );
};

function newPatternError(msg: PyValue, pattern: PyValue, pos: PyValue, cls = patternErrorClass): PyObject {
  let message = msg;
  let lineno: PyValue = None;
  let colno: PyValue = None;
  if (pattern !== None && pos !== None) {
    message = `${pyStr(msg)} at position ${pyStr(pos)}`;
    const data = bytesLikeData(pattern);
    const text = data === undefined ? unbox(pattern) : latin1Text(data);
    if (typeof text === 'string' && typeof pos === 'bigint') {
      // oxlint-disable-next-line typescript/no-misused-spread -- Positions count code points.
      const before = [...text].slice(0, Number(pos));
      lineno = BigInt(before.filter((char) => char === '\n').length + 1);
      colno = pos - BigInt(before.lastIndexOf('\n'));
      if (text.includes('\n')) message = `${message} (line ${lineno}, column ${colno})`;
    }
  }
  const error = newException(cls, [message]);
  for (const [key, value] of [
    ['msg', msg],
    ['pattern', pattern],
    ['pos', pos],
    ['lineno', lineno],
    ['colno', colno],
  ] as const)
    error.dict.set(key, value);
  return error;
}

/** The Python exception for an error of the parser or the compiler, about `pattern`. */
export function syntaxError(error: PatternSyntaxError, pattern: PyValue): PyError {
  switch (error.kind) {
    case 'pattern': {
      const position = error.pos === undefined ? None : BigInt(error.pos);
      const exception = newPatternError(error.msg, error.pos === undefined ? None : pattern, position);
      return new PyError(exception as never);
    }
    case 'overflow': {
      return pyError('OverflowError', error.msg);
    }
    case 'value': {
      return valueError(error.msg);
    }
    case 'index': {
      return pyError('IndexError', error.msg);
    }
  }
}

export const patternClass = builtinClass('Pattern');
patternClass.typeName = 're.Pattern';
patternClass.module = 're';
patternClass.construct = () => {
  throw typeError("cannot create 're.Pattern' instances");
};

const scannerClass = builtinClass('SRE_Scanner');
scannerClass.typeName = '_sre.SRE_Scanner';
scannerClass.module = '_sre';

const mappingProxyClass = builtinClass('mappingproxy');
// A non-builtin class makes item assignment fail, as on CPython's read-only mapping proxy.
mappingProxyClass.isBuiltin = false;

export class PatternObject extends PyObject {
  readonly indexgroup: (string | undefined)[] = [];

  // code-gauge-allow functionParameterCount 7 -- Each field of a compiled pattern is set once at creation.
  constructor(
    /** The pattern's text, one character per byte for bytes, which a `re.Scanner` pattern has none of. */
    readonly source: string | undefined,
    readonly flags: number,
    readonly program: Program,
    readonly groups: number,
    readonly groupindex: Map<string, number>,
    /** The str or bytes object the pattern was compiled from. */
    readonly sourceValue: PyValue,
    /** Whether the pattern is a bytes pattern, or undefined for a `re.Scanner` pattern, which matches either. */
    readonly isBytes: boolean | undefined
  ) {
    super(patternClass);
    for (const [name, index] of groupindex) this.indexgroup[index] = name;
  }
}

/**
 * Compiles a str or bytes pattern with `flags`, as `re._compiler.compile` does, which prints the pattern compiled with
 * `re.DEBUG` unless that `compile` printed it already.
 */
export function compileRegex(sourceValue: PyValue, flags: number, printsDebug = true): PatternObject {
  const isBytes = sourceValue instanceof PyBytes;
  const source = isBytes ? latin1Text(sourceValue.data) : (unbox(sourceValue) as string);
  try {
    const parsed = parse(source, flags, !isBytes);
    const allFlags = parsed.state.flags | flags;
    if (allFlags & FLAG.DEBUG && printsDebug) printDebug(parsed, allFlags);
    const program = compilePattern(parsed, allFlags);
    const runtime = currentRuntime();
    runtime.scan(source.length + program.code.length);
    for (const charset of program.charsets) {
      runtime.scan((charset.lowered?.size ?? 0) + (charset.literals?.size ?? 0) + charset.items.length);
    }
    const { groups, groupdict } = parsed.state;
    return new PatternObject(source, allFlags, program, groups - 1, groupdict, sourceValue, isBytes);
  } catch (error) {
    if (error instanceof PatternSyntaxError) throw syntaxError(error, sourceValue);
    throw error;
  }
}

/** Prints what CPython prints for `re.DEBUG`: the parsed pattern, then the code it compiles to. */
function printDebug(parsed: SubPattern, flags: number): void {
  printText(dumpPattern(parsed));
  const code = debugCode(parsed, flags);
  printText(`\n${disassemble(code)}`);
}

/** Raises the TypeError of `flags & VERBOSE` in `re._parser.parse` for flags that are not integers. */
export function checkFlagsOperand(source: string, flags: PyValue, isText = true): void {
  if (typeof flags === 'bigint' || typeof flags === 'boolean') return;
  // CPython tokenizes the pattern first, so a trailing backslash reports its bad escape instead.
  void new Tokenizer(source, isText);
  throw typeError(`unsupported operand type(s) for &: '${typeName(flags)}' and 'int'`);
}

function asPattern(value: PyValue): PatternObject {
  return value as PatternObject;
}

function runtimeBudget(): Budget {
  const runtime = currentRuntime();
  let pending = 0;
  return {
    charge(count: number): void {
      pending += count;
      if (pending < 8) return;
      runtime.spend(pending >> 3);
      pending &= 7;
    },
  };
}

const MAXSIZE = 9_223_372_036_854_775_807n;

/** Reads a `Py_ssize_t` argument. */
function toSize(value: PyValue | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const index = toIndex(value);
  if (index > MAXSIZE || index < -MAXSIZE - 1n)
    throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
  return Number(index);
}

interface SearchArgs {
  subject: Subject;
  state: MatchState;
  matcher: Matcher;
}

export function startSearch(pattern: PatternObject, string: PyValue, pos?: PyValue, endpos?: PyValue): SearchArgs {
  const subject = toSubject(string, pattern.isBytes);
  const state = new MatchState(subject.codes, toSize(pos, 0), toSize(endpos, Number.MAX_SAFE_INTEGER));
  return { subject, state, matcher: new Matcher(pattern.program, state, runtimeBudget()) };
}

function method(
  name: string,
  params: readonly string[],
  required: number,
  run: (pattern: PatternObject, args: (PyValue | undefined)[]) => PyValue
): void {
  defineMethod(patternClass, name, (self, args, kwargs: Kwargs) =>
    run(asPattern(self), clinicArgs(name, params, required, args, kwargs))
  );
}

const SEARCH_PARAMS = ['string', 'pos', 'endpos'] as const;

for (const kind of ['match', 'fullmatch', 'search'] as const) {
  method(kind, SEARCH_PARAMS, 1, (pattern, [string, pos, endpos]) => {
    const { subject, state, matcher } = startSearch(pattern, string as PyValue, pos, endpos);
    state.matchAll = kind === 'fullmatch';
    const found = kind === 'search' ? matcher.search() : matcher.match();
    return found ? newMatch(pattern, subject, state) : None;
  });
}

method('findall', SEARCH_PARAMS, 1, (pattern, [string, pos, endpos]) => {
  const { subject, state, matcher } = startSearch(pattern, string as PyValue, pos, endpos);
  const items: PyValue[] = [];
  while (state.start <= state.end) {
    state.reset();
    state.ptr = state.start;
    if (!matcher.search()) break;
    items.push(findallItem(pattern, subject, state));
    state.mustAdvance = state.ptr === state.start;
    state.start = state.ptr;
  }
  return currentRuntime().listOf(items);
});

function findallItem(pattern: PatternObject, subject: Subject, state: MatchState): PyValue {
  if (pattern.groups === 0) return sliceOf(subject, state.start, state.ptr);
  const groups: PyValue[] = [];
  for (let group = 1; group <= pattern.groups; group++) {
    const [start, end] = state.groupSpan(group);
    groups.push(sliceOf(subject, Math.max(start, 0), Math.max(end, 0)));
  }
  return pattern.groups === 1 ? groups[0] : newTuple(groups);
}

/** A scanner, whose `search` and `match` give successive matches, as `_sre.SRE_Scanner`. */
export class ScannerObject extends PyObject {
  private exhausted = false;

  constructor(
    readonly pattern: PatternObject,
    private readonly search: SearchArgs
  ) {
    super(scannerClass);
  }

  next(kind: 'match' | 'search'): PyValue {
    const { state, matcher, subject } = this.search;
    if (this.exhausted) return None;
    state.reset();
    state.ptr = state.start;
    if (!(kind === 'search' ? matcher.search() : matcher.match())) {
      this.exhausted = true;
      return None;
    }
    const match = newMatch(this.pattern, subject, state);
    state.mustAdvance = state.ptr === state.start;
    state.start = state.ptr;
    return match;
  }
}

method('scanner', SEARCH_PARAMS, 1, (pattern, [string, pos, endpos]) => {
  return new ScannerObject(pattern, startSearch(pattern, string as PyValue, pos, endpos));
});
for (const kind of ['match', 'search'] as const) {
  defineMethod(scannerClass, kind, (self, args, kwargs) => {
    clinicArgs(kind, [], 0, args, kwargs);
    return (self as ScannerObject).next(kind);
  });
}
readOnlyAttribute(scannerClass, 'pattern', 'member', (self) => (self as ScannerObject).pattern);

method('finditer', SEARCH_PARAMS, 1, (pattern, [string, pos, endpos]) => {
  const scanner = new ScannerObject(pattern, startSearch(pattern, string as PyValue, pos, endpos));
  let finished = false;
  return new PyIterator(iteratorClass('callable_iterator'), () => {
    if (finished) return DONE;
    const match = scanner.next('search');
    if (match === None) {
      finished = true;
      return DONE;
    }
    return match;
  });
});

method('split', ['string', 'maxsplit'], 1, (pattern, [string, maxsplitValue]) => {
  const { subject, state, matcher } = startSearch(pattern, string as PyValue);
  const maxsplit = toSize(maxsplitValue, 0);
  const items: PyValue[] = [];
  let last = state.start;
  for (let count = 0; maxsplit === 0 || count < maxsplit; count++) {
    state.reset();
    state.ptr = state.start;
    if (!matcher.search()) break;
    items.push(sliceOf(subject, last, state.start));
    for (let group = 1; group <= pattern.groups; group++) {
      const [start, end] = state.groupSpan(group);
      items.push(start < 0 ? None : sliceOf(subject, start, end));
    }
    state.mustAdvance = state.ptr === state.start;
    last = state.ptr;
    state.start = state.ptr;
  }
  items.push(sliceOf(subject, last, state.endpos));
  return currentRuntime().listOf(items);
});

for (const kind of ['sub', 'subn'] as const) {
  method(kind, ['repl', 'string', 'count'], 2, (pattern, [repl, string, count]) => {
    const [text, replaced] = substitute(pattern, repl as PyValue, string as PyValue, count);
    return kind === 'sub' ? text : newTuple([text, BigInt(replaced)]);
  });
}

/** `pattern_subx`: replaces up to `count` matches, returning the new string and the number of replacements. */
function substitute(
  pattern: PatternObject,
  repl: PyValue,
  string: PyValue,
  countValue: PyValue | undefined
): [PyValue, number] {
  const template = isCallable(repl) ? undefined : compileTemplate(pattern, repl);
  const { subject, state, matcher } = startSearch(pattern, string);
  const limit = toSize(countValue, 0);
  const pieces: PyValue[] = [];
  let last = 0;
  let replaced = 0;
  while (limit === 0 || replaced < limit) {
    state.ptr = state.start;
    if (!matcher.search()) break;
    if (last < state.start) pieces.push(sliceOf(subject, last, state.start));
    const match = newMatch(pattern, subject, state);
    const item = template ? expandTemplate(template, match, true) : callValue(repl, [match]);
    if (item !== None) pieces.push(item);
    last = state.ptr;
    replaced++;
    state.mustAdvance = state.ptr === state.start;
    state.start = state.ptr;
    state.reset();
  }
  if (last < state.endpos) pieces.push(sliceOf(subject, last, state.endpos));
  return [joinPieces(subject.isBytes, pieces), replaced];
}

function property(name: string, get: (pattern: PatternObject) => PyValue): void {
  const kind = name === 'groupindex' ? 'getset' : 'member';
  readOnlyAttribute(patternClass, name, kind, (self) => get(asPattern(self)));
}

property('pattern', (pattern) => pattern.sourceValue);
property('flags', (pattern) => BigInt(pattern.flags));
property('groups', (pattern) => BigInt(pattern.groups));
property('groupindex', (pattern) => {
  if (pattern.groupindex.size === 0) return newDict();
  const proxy = newDict([...pattern.groupindex].map(([name, index]) => [name, BigInt(index)]));
  proxy.cls = mappingProxyClass;
  return proxy;
});

const FLAG_NAMES: [number, string][] = [
  [FLAG.IGNORECASE, 'IGNORECASE'],
  [FLAG.LOCALE, 'LOCALE'],
  [FLAG.MULTILINE, 'MULTILINE'],
  [FLAG.DOTALL, 'DOTALL'],
  [FLAG.UNICODE, 'UNICODE'],
  [FLAG.VERBOSE, 'VERBOSE'],
  [FLAG.DEBUG, 'DEBUG'],
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- The name of the re.ASCII flag.
  [FLAG.ASCII, 'ASCII'],
];

defineMethod(patternClass, '__repr__', (self) => {
  const pattern = asPattern(self);
  let flags = pattern.flags;
  if ((flags & (FLAG.LOCALE | FLAG.UNICODE | FLAG.ASCII)) === FLAG.UNICODE) flags &= ~FLAG.UNICODE;
  const source = truncate(pattern.source === undefined ? 'None' : pyRepr(pattern.sourceValue), 200);
  if (flags === 0) return `re.compile(${source})`;
  const names: string[] = [];
  for (const [flag, name] of FLAG_NAMES) {
    if (flags & flag) {
      names.push(`re.${name}`);
      flags &= ~flag;
    }
  }
  if (flags) names.push(`0x${flags.toString(16)}`);
  return `re.compile(${source}, ${names.join('|')})`;
});
defineMethod(patternClass, '__eq__', (self, [other]) => {
  if (!(other instanceof PatternObject)) return NotImplemented;
  const pattern = asPattern(self);
  return (
    pattern === other ||
    (pattern.source !== undefined &&
      pattern.flags === other.flags &&
      pattern.source === other.source &&
      pattern.isBytes === other.isBytes)
  );
});
defineMethod(patternClass, '__hash__', (self) => {
  const pattern = asPattern(self);
  if (pattern.source === undefined) return currentRuntime().hashOf(BigInt(pattern.identity));
  return currentRuntime().hashOf(newTuple([pattern.source, pattern.isBytes ?? false, BigInt(pattern.flags)]));
});
defineMethod(patternClass, '__copy__', (self) => self);
defineMethod(patternClass, '__deepcopy__', (self) => self);

defineMethod(mappingProxyClass, '__getitem__', (self, [key]) => {
  const value = (self as PyDict).store.get(key);
  if (value === undefined) throw keyError(key);
  return value;
});
for (const name of ['__len__', '__contains__', 'keys', 'values', 'items', 'get', 'copy']) {
  const fn = dictClass.lookup(name);
  if (fn) mappingProxyClass.dict.set(name, fn);
}
defineMethod(
  mappingProxyClass,
  '__repr__',
  (self) => `mappingproxy(${pyRepr(new PyDict(dictClass, (self as PyDict).store))})`
);

export { MatchObject };
