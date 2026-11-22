// code-gauge-allow-file fileNcss -- String methods and buffers share bounds, matching, and formatting helpers.
import { LIMITS } from '../../interpreter/limits';
import { stringOf } from '../format';
import { concatenate } from '../operators';
import type { Runtime } from '../runtime';
import { asInstanceOf, coreTypes, interfaceType } from '../types';
import { DartList, DartObject, DartPackedList, type Value } from '../values';
import { BoundedStringParts, copyString, detachShorterString, StringParts, stringSlice } from './boundedStringParts';
import {
  allMatchesOf,
  hasPrefixMatch,
  isRegExp,
  type MatchState,
  matchText,
  newMatch,
  patternIndex,
} from './nativeRegExp';
import {
  define,
  defineConstructor,
  forEachIteratorValue,
  index,
  intArg,
  iteratorValues,
  named,
  registerPackedList,
  stringArg,
} from './nativeSupport';
import { isSurrogatePairAt } from './regExpEngine';
import { dartStringCase } from './stringCase';
import { trimDartEnd, trimDartStart, trimDartWhitespace } from './stringWhitespace';

function checkLength(runtime: Runtime, length: number): void {
  if (length > LIMITS.maxStringLength) runtime.throwError('OutOfMemoryError', '', []);
  runtime.spendString(length);
}

function rangeError(runtime: Runtime, value: bigint, min: number, max: number, name: string | undefined): never {
  runtime.throwError('RangeError', 'range', [value, BigInt(min), BigInt(max), name]);
}

function self(value: Value): string {
  return value as string;
}

define('String.[]', (runtime, receiver, [position]) => {
  const text = self(receiver);
  const at = intArg(runtime, position, 'index');
  if (at < 0n || at >= BigInt(text.length)) rangeError(runtime, at, 0, text.length - 1, 'index');
  return text[index(at)];
});
define('String.codeUnitAt', (runtime, receiver, [position]) => {
  const text = self(receiver);
  const at = intArg(runtime, position, 'index');
  if (at < 0n || at >= BigInt(text.length)) rangeError(runtime, at, 0, text.length - 1, 'length');
  // oxlint-disable-next-line unicorn/prefer-code-point -- Dart's code units are UTF-16 code units.
  return BigInt(text.charCodeAt(index(at)));
});
define('String.length', (_runtime, receiver) => BigInt(self(receiver).length));
define('String.hashCode', (runtime, receiver) => {
  const text = self(receiver);
  let cache = stringHashes.get(runtime);
  if (!cache) {
    cache = { hashes: new Map(), size: 0 };
    stringHashes.set(runtime, cache);
  }
  const cached = cache.hashes.get(text);
  if (cached !== undefined) return cached;
  const size = Math.max(1, text.length);
  runtime.spend(Math.ceil(size / 32));
  const hash = hashCodeUnits(text);
  if (cache.size + size > LIMITS.maxStringLength || cache.hashes.size === 1024) {
    cache.hashes.clear();
    cache.size = 0;
  }
  if (size <= LIMITS.maxStringLength) {
    runtime.allocate(1);
    // A substring key may otherwise keep its much larger source string alive.
    cache.hashes.set(copyString(runtime, text), hash);
    cache.size += size;
  }
  return hash;
});

const stringHashes = new WeakMap<Runtime, { hashes: Map<string, bigint>; size: number }>();

function hashCodeUnits(text: string): bigint {
  // The VM hashes the UTF-16 code units with Jenkins' one-at-a-time hash, kept to 30 bits and never 0.
  let hash = 0;
  for (let position = 0; position < text.length; position++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- The VM hashes UTF-16 code units.
    hash = (hash + text.charCodeAt(position)) >>> 0;
    hash = (hash + (hash << 10)) >>> 0;
    hash = (hash ^ (hash >>> 6)) >>> 0;
  }
  hash = (hash + (hash << 3)) >>> 0;
  hash = (hash ^ (hash >>> 11)) >>> 0;
  hash = (hash + (hash << 15)) >>> 0;
  return BigInt(hash & 0x3f_ff_ff_ff || 1);
}
define('String.==', (_runtime, receiver, [other]) => receiver === other);
define('String.compareTo', (runtime, receiver, [other]) => {
  const a = self(receiver);
  const b = stringArg(runtime, other, 'other');
  return a < b ? -1n : a > b ? 1n : 0n;
});
define('String.endsWith', (runtime, receiver, [other]) => self(receiver).endsWith(stringArg(runtime, other, 'other')));
define('String.startsWith', (runtime, receiver, [pattern, start = 0n]) => {
  const text = self(receiver);
  const at = intArg(runtime, start, 'index');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, undefined);
  return hasPrefixMatch(runtime, pattern, text, index(at));
});
define('String.indexOf', (runtime, receiver, [pattern, start = 0n]) => {
  const text = self(receiver);
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'start');
  return BigInt(patternIndex(runtime, pattern, text, index(at)));
});
define('String.lastIndexOf', (runtime, receiver, [pattern, start]) => {
  const text = self(receiver);
  let at = text.length;
  if (start !== undefined) {
    const value = intArg(runtime, start, 'start');
    if (value < 0n || value > BigInt(text.length)) rangeError(runtime, value, 0, text.length, undefined);
    at = index(value);
  }
  if (typeof pattern === 'string') {
    if (at + pattern.length > text.length) at = text.length - pattern.length;
    return BigInt(text.lastIndexOf(pattern, at));
  }
  for (let position = at; position >= 0; position--) {
    if (hasPrefixMatch(runtime, pattern, text, position)) return BigInt(position);
  }
  return -1n;
});
define('String.isEmpty', (_runtime, receiver) => self(receiver).length === 0);
define('String.isNotEmpty', (_runtime, receiver) => self(receiver).length > 0);
define('String.+', (runtime, receiver, [other]) =>
  concatenate(runtime, self(receiver), stringArg(runtime, other, 'other'))
);
define('String.substring', (runtime, receiver, [start, end]) => {
  const text = self(receiver);
  const from = intArg(runtime, start, 'start');
  const to = end === undefined ? BigInt(text.length) : intArg(runtime, end, 'end');
  return substringBetween(runtime, text, from, to);
});
define('String.trim', (runtime, receiver) =>
  detachShorterString(runtime, self(receiver), trimDartWhitespace(self(receiver)))
);
define('String.trimLeft', (runtime, receiver) =>
  detachShorterString(runtime, self(receiver), trimDartStart(self(receiver)))
);
define('String.trimRight', (runtime, receiver) =>
  detachShorterString(runtime, self(receiver), trimDartEnd(self(receiver)))
);
define('String.*', (runtime, receiver, [times]) => {
  const count = intArg(runtime, times, 'times');
  if (count <= 0n) return '';
  const text = self(receiver);
  checkLength(runtime, text.length * Number(count));
  return text.repeat(Number(count));
});
define('String.padLeft', (runtime, receiver, [width, padding = ' ']) => {
  const text = self(receiver);
  const delta = Number(intArg(runtime, width, 'width')) - text.length;
  if (delta <= 0) return text;
  const pad = stringArg(runtime, padding, 'padding');
  checkLength(runtime, text.length + pad.length * delta);
  return pad.repeat(delta) + text;
});
define('String.padRight', (runtime, receiver, [width, padding = ' ']) => {
  const text = self(receiver);
  const delta = Number(intArg(runtime, width, 'width')) - text.length;
  if (delta <= 0) return text;
  const pad = stringArg(runtime, padding, 'padding');
  checkLength(runtime, text.length + pad.length * delta);
  return text + pad.repeat(delta);
});
define('String.contains', (runtime, receiver, [pattern, start = 0n]) => {
  const text = self(receiver);
  const at = intArg(runtime, start, 'startIndex');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'startIndex');
  return patternIndex(runtime, pattern, text, index(at)) >= 0;
});

type StringMatch = DartObject | MatchState;

function* matchesOf(runtime: Runtime, pattern: Value, text: string, start?: number): IterableIterator<StringMatch> {
  if (typeof pattern === 'string') {
    let position = text.indexOf(pattern, start ?? 0);
    while (position >= 0 && position <= text.length) {
      const end = position + pattern.length;
      runtime.spend();
      yield { start: position, end, input: text, pattern };
      const next = position + Math.max(1, pattern.length);
      if (next > text.length) break;
      position = text.indexOf(pattern, next);
    }
    return;
  }
  if (isRegExp(runtime, pattern)) {
    yield* allMatchesOf(runtime, pattern, text, start ?? 0);
    return;
  }
  const iterable = runtime.invoke(
    pattern,
    'allMatches',
    { positional: start === undefined ? [text] : [text, BigInt(start)], named: undefined },
    [],
    undefined
  );
  for (const match of iteratorValues(runtime, iterable, 0n, undefined)) {
    yield match as DartObject;
  }
}

function boundary(runtime: Runtime, match: StringMatch, name: 'start' | 'end'): bigint {
  return match instanceof DartObject
    ? intArg(runtime, runtime.getProperty(match, name, undefined), name)
    : BigInt(match[name]);
}

function matchObject(runtime: Runtime, match: StringMatch): DartObject {
  if (match instanceof DartObject) return match;
  if (typeof match.pattern === 'string') {
    return runtime.links.construct(runtime, '_StringMatch', '', [BigInt(match.start), match.input, match.pattern]);
  }
  return newMatch(runtime, match);
}

function replaceWith(
  runtime: Runtime,
  text: string,
  matches: Iterable<StringMatch>,
  replace: (match: StringMatch) => string
): string {
  const result = new BoundedStringParts(runtime);
  let last = 0n;
  for (const match of matches) {
    result.append(text.slice(index(last), index(boundary(runtime, match, 'start'))));
    result.append(replace(match));
    last = boundary(runtime, match, 'end');
  }
  result.append(text.slice(index(last)));
  return detachShorterString(runtime, text, result.text());
}

function mappedReplacement(runtime: Runtime, replace: Value): (match: StringMatch) => string {
  return (match) => {
    const value = runtime.callValue(
      replace,
      { positional: [matchObject(runtime, match)], named: undefined },
      [],
      runtime.userCallRow
    );
    return stringOf(runtime, value);
  };
}

define('String.replaceFirst', (runtime, receiver, [from, to, start = 0n]) => {
  const text = self(receiver);
  const at = intArg(runtime, start, 'startIndex');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'startIndex');
  const replacement = stringArg(runtime, to, 'to');
  for (const match of matchesOf(runtime, from, text, at === 0n ? undefined : index(at))) {
    return replaceMatch(runtime, text, match, replacement);
  }
  return text;
});
define('String.replaceFirstMapped', (runtime, receiver, [from, replace, start = 0n]) => {
  const text = self(receiver);
  const at = intArg(runtime, start, 'startIndex');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'startIndex');
  const replacement = mappedReplacement(runtime, replace);
  for (const match of matchesOf(runtime, from, text, index(at))) {
    return replaceMatch(runtime, text, match, replacement(match));
  }
  return text;
});

function replaceMatch(runtime: Runtime, text: string, match: StringMatch, replacement: string): string {
  const start = boundary(runtime, match, 'start');
  const end = boundary(runtime, match, 'end');
  return replaceRange(runtime, text, start, end, replacement);
}
define('String.replaceAll', (runtime, receiver, [from, to]) => {
  const text = self(receiver);
  const replacement = stringArg(runtime, to, 'replace');
  return replaceWith(runtime, text, matchesOf(runtime, from, text), () => replacement);
});
define('String.replaceAllMapped', (runtime, receiver, [from, replace]) => {
  const text = self(receiver);
  return replaceWith(runtime, text, matchesOf(runtime, from, text), mappedReplacement(runtime, replace));
});
define('String.replaceRange', (runtime, receiver, [start, end, replacement]) => {
  const text = self(receiver);
  const from = intArg(runtime, start, 'start');
  const to = end === undefined ? BigInt(text.length) : intArg(runtime, end, 'end');
  return replaceRange(runtime, text, from, to, stringArg(runtime, replacement, 'replacement'));
});

function replaceRange(runtime: Runtime, text: string, from: bigint, to: bigint, inserted: string): string {
  if (from < 0n || from > BigInt(text.length)) rangeError(runtime, from, 0, text.length, 'start');
  if (to < from || to > BigInt(text.length)) rangeError(runtime, to, Number(from), text.length, 'end');
  checkLength(runtime, text.length - Number(to - from) + inserted.length);
  return detachShorterString(runtime, text, text.slice(0, index(from)) + inserted + text.slice(index(to)));
}
define('String.split', (runtime, receiver, [pattern]) => {
  const text = self(receiver);
  const stringType = interfaceType(coreTypes.string);
  runtime.allocate(1);
  if (typeof pattern === 'string') {
    return new DartList(coreTypes.list, stringType, splitAtString(runtime, text, pattern), true);
  }
  const matches = matchesOf(runtime, pattern, text);
  const parts: Value[] = [];
  const append = (begin: bigint, end: bigint): void => {
    runtime.allocate(1);
    parts.push(substringBetween(runtime, text, begin, end));
  };
  let previous = 0n;
  let start = 0n;
  const length = BigInt(text.length);
  try {
    if (text.length === 0 && !matches.next().done) return new DartList(coreTypes.list, stringType, parts, true);
    while (start !== length) {
      const { value: match, done } = matches.next();
      if (done || boundary(runtime, match, 'start') === length) break;
      const end = boundary(runtime, match, 'end');
      if (start === end && end === previous) {
        start++;
        continue;
      }
      append(previous, boundary(runtime, match, 'start'));
      start = previous = end;
    }
    append(previous, length);
    return new DartList(coreTypes.list, stringType, parts, true);
  } finally {
    matches.return?.();
  }
});
function splitAtString(runtime: Runtime, text: string, separator: string): string[] {
  if (separator === '') {
    runtime.allocate(text.length);
    return text.split('');
  }
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf(separator, start);
    runtime.allocate(1);
    if (end === -1) {
      parts.push(stringSlice(runtime, text, start));
      return parts;
    }
    parts.push(stringSlice(runtime, text, start, end));
    start = end + separator.length;
  }
}

define('String.splitMapJoin', (runtime, receiver, [pattern], namedArgs) => {
  const text = self(receiver);
  const onMatch = named(namedArgs, 'onMatch', undefined);
  const onNonMatch = named(namedArgs, 'onNonMatch', undefined);
  const nonMatch = (part: string): string =>
    onNonMatch === undefined
      ? part
      : stringOf(
          runtime,
          runtime.callValue(onNonMatch, { positional: [part], named: undefined }, [], runtime.userCallRow)
        );
  const result = new BoundedStringParts(runtime);
  const mapMatch =
    onMatch === undefined
      ? (match: StringMatch) => firstMatchGroup(runtime, match)
      : mappedReplacement(runtime, onMatch);
  const matches = pattern === '' ? emptyPatternMatches(text, runtime) : matchesOf(runtime, pattern, text);
  let last = 0n;
  for (const match of matches) {
    result.append(nonMatch(substringBetween(runtime, text, last, boundary(runtime, match, 'start'))));
    result.append(mapMatch(match));
    last = boundary(runtime, match, 'end');
  }
  result.append(nonMatch(substringBetween(runtime, text, last, BigInt(text.length))));
  return result.text();
});

function firstMatchGroup(runtime: Runtime, match: StringMatch): string {
  const group =
    match instanceof DartObject
      ? runtime.invoke(match, '[]', { positional: [0n], named: undefined }, [], runtime.userCallRow)
      : matchText(runtime, match);
  if (group === undefined) runtime.throwTypeError('Null check operator used on a null value');
  return group as string;
}

function* emptyPatternMatches(input: string, runtime: Runtime): IterableIterator<MatchState> {
  for (let position = 0; position <= input.length; position += isSurrogatePairAt(input, position) ? 2 : 1) {
    runtime.spend();
    yield { start: position, end: position, input, pattern: '' };
  }
}

function substringBetween(runtime: Runtime, text: string, start: bigint, end: bigint): string {
  if (start < 0n || start > BigInt(text.length)) rangeError(runtime, start, 0, text.length, 'start');
  if (end < start || end > BigInt(text.length)) rangeError(runtime, end, Number(start), text.length, 'end');
  return stringSlice(runtime, text, index(start), index(end));
}

registerPackedList('CodeUnits');

define('String.codeUnits', (runtime, receiver) => {
  runtime.allocate(1);
  return new DartPackedList(runtime.links.classNamed('CodeUnits'), self(receiver));
});
define('String.runes', (runtime, receiver) => runtime.links.construct(runtime, 'Runes', '', [receiver]));
define('String.toLowerCase', (runtime, receiver) => mapCase(runtime, self(receiver), false));
define('String.toUpperCase', (runtime, receiver) => mapCase(runtime, self(receiver), true));

function mapCase(runtime: Runtime, text: string, upper: boolean): string {
  runtime.spendString(text.length);
  return dartStringCase(text, upper);
}
define('String.toString', (_runtime, receiver) => receiver);
define('String.allMatches', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'string');
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'start');
  return runtime.links.construct(runtime, '_StringAllMatchesIterable', '_', [text, receiver, at]);
});
define('String.matchAsPrefix', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'string');
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, undefined);
  const pattern = self(receiver);
  if (!text.startsWith(pattern, index(at))) return;
  return runtime.links.construct(runtime, '_StringMatch', '', [at, text, pattern]);
});
define('String.fromCharCodes', (runtime, _receiver, [codes, start = 0n, end]) => {
  const from = intArg(runtime, start, 'start');
  if (from < 0n) runtime.throwError('RangeError', 'range', [from, 0n, undefined, 'start']);
  const to = end === undefined ? undefined : intArg(runtime, end, 'end');
  if (to !== undefined && to < from) runtime.throwError('RangeError', 'range', [to, from, undefined, 'end']);
  if (to === from) return '';
  const length = efficientCharacterCount(runtime, codes);
  if (length !== undefined && from >= length) return '';
  return stringFromCharCodes(
    runtime,
    codes,
    from,
    length !== undefined && (to === undefined || to > length) ? length : to
  );
});
define('String.fromCharCode', (runtime, _receiver, [code]) => characterOf(runtime, intArg(runtime, code, 'charCode')));
define('String.fromEnvironment', (_runtime, _receiver, _args, namedArgs) => named(namedArgs, 'defaultValue', ''));

function efficientCharacterCount(runtime: Runtime, codes: Value): bigint | undefined {
  if (codes instanceof DartList) return BigInt(codes.elements.length);
  const type = runtime.runtimeTypeOf(codes);
  if (type.kind === 'interface' && asInstanceOf(type, runtime.links.classNamed('EfficientLengthIterable')))
    return intArg(runtime, runtime.getProperty(codes, 'length', undefined), 'length');
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity -- The VM distinguishes invalid codes in lists and iterators.
function stringFromCharCodes(runtime: Runtime, codes: Value, from: bigint, to: bigint | undefined): string {
  const parts = new StringParts();
  let length = 0;
  let invalidCode: bigint | undefined;
  const add = (value: Value): void => {
    const code = intArg(runtime, value, 'charCodes');
    if (code < 0n || code > 0x10_ff_ffn) {
      if (invalidCode === undefined || code < 0n || code > 0x3f_ff_ff_ff_ff_ff_ff_ffn) invalidCode = code;
      return;
    }
    const text = String.fromCodePoint(Number(code));
    length += text.length;
    if (length > LIMITS.maxStringLength) runtime.throwError('OutOfMemoryError', '', []);
    parts.append(text);
  };
  if (codes instanceof DartList) {
    const end = to === undefined ? codes.elements.length : Math.min(Number(to), codes.elements.length);
    for (let position = Number(from); position < end; position++) {
      add(codes.elements[position]);
      runtime.spend();
    }
  } else {
    forEachIteratorValue(runtime, codes, from, to, add);
  }
  if (invalidCode !== undefined) throwCharCodesError(runtime, codes, invalidCode);
  return parts.text();
}

function throwCharCodesError(runtime: Runtime, codes: Value, invalidCode: bigint): never {
  if (codes instanceof DartList) {
    const showList = invalidCode < 0n || invalidCode > 0x3f_ff_ff_ff_ff_ff_ff_ffn;
    runtime.throwError('ArgumentError', '', showList ? [codes] : []);
  }
  runtime.throwError('ArgumentError', 'value', [
    codes,
    'charCodes',
    'Contains invalid character code, not 0 <= code <= 0x10FFFF',
  ]);
}

// StringBuffer

interface BufferState {
  parts: BoundedStringParts;
  snapshot: string | undefined;
  readonly text: string;
  values(): Iterable<Value>;
}

defineConstructor('StringBuffer.new', (runtime, instance, args) => {
  const object = instance as DartObject;
  const state: BufferState = {
    parts: new BoundedStringParts(runtime),
    snapshot: undefined,
    get text() {
      if (this.snapshot === undefined) {
        runtime.spendString(this.parts.length);
        this.snapshot = this.parts.text();
      }
      return this.snapshot;
    },
    values: () => [],
  };
  object.native = state as unknown as DartObject['native'];
  writeBufferValue(runtime, object, args.positional);
});
define('StringBuffer.length', (_runtime, receiver) => BigInt(bufferOf(receiver).parts.length));
define('StringBuffer.write', (runtime, receiver, [value]) => appendBuffer(receiver, stringOf(runtime, value)));
define('StringBuffer.writeCharCode', (runtime, receiver, [code]) =>
  appendBuffer(receiver, characterOf(runtime, intArg(runtime, code, 'charCode')))
);
define('StringBuffer.writeln', (runtime, receiver, args) => {
  writeBufferValue(runtime, receiver, args);
  return appendBuffer(receiver, '\n');
});
define('StringBuffer.clear', (runtime, receiver) => {
  const buffer = bufferOf(receiver);
  buffer.parts = new BoundedStringParts(runtime);
  buffer.snapshot = '';
});
define('StringBuffer.toString', (_runtime, receiver) => bufferOf(receiver).text);

function writeBufferValue(runtime: Runtime, receiver: Value, args: readonly Value[]): void {
  const content = args.length === 0 ? '' : args[0];
  runtime.invoke(receiver, 'write', { positional: [content], named: undefined }, [], undefined);
}

function appendBuffer(receiver: Value, text: string): undefined {
  if (text.length === 0) return;
  const buffer = bufferOf(receiver);
  buffer.parts.append(text);
  buffer.snapshot = undefined;
}

function bufferOf(receiver: Value): BufferState {
  return (receiver as DartObject).native as unknown as BufferState;
}

export function characterOf(runtime: Runtime, code: bigint): string {
  if (code < 0n || code > 0x10_ff_ffn) rangeError(runtime, code, 0, 0x10_ff_ff, undefined);
  return String.fromCodePoint(Number(code));
}
