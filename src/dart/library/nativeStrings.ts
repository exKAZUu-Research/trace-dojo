import { LIMITS } from '../../interpreter/limits';
import { stringOf } from '../format';
import { concatenate } from '../operators';
import type { Runtime } from '../runtime';
import { coreTypes, interfaceType } from '../types';
import { DartList, type DartObject, type Value } from '../values';
import { allMatchesOf, isRegExp, matchAt, type MatchState, newMatch } from './nativeRegExp';
import {
  define,
  defineConstructor,
  forEachIteratorValue,
  index,
  intArg,
  iteratorValues,
  named,
  newList,
  stringArg,
} from './nativeSupport';

function checkLength(runtime: Runtime, length: number): void {
  if (length > LIMITS.maxStringLength) runtime.throwError('OutOfMemoryError', '', []);
  runtime.spend(Math.ceil(length / 1024));
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
define('String.hashCode', (_runtime, receiver) => {
  // The VM hashes the UTF-16 code units with Jenkins' one-at-a-time hash, kept to 30 bits and never 0.
  const text = self(receiver);
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
});
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
  if (typeof pattern === 'string') return text.startsWith(pattern, index(at));
  return matchAt(runtime, pattern, text, index(at), true) !== undefined;
});
define('String.indexOf', (runtime, receiver, [pattern, start = 0n]) => {
  const text = self(receiver);
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'start');
  if (typeof pattern === 'string') return BigInt(text.indexOf(pattern, index(at)));
  const match = matchAt(runtime, pattern, text, index(at), false);
  return match ? BigInt(match.start) : -1n;
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
    if (matchAt(runtime, pattern, text, position, true)) return BigInt(position);
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
  if (from < 0n || from > BigInt(text.length)) rangeError(runtime, from, 0, text.length, 'start');
  if (to < from || to > BigInt(text.length)) rangeError(runtime, to, Number(from), text.length, 'end');
  return text.slice(index(from), index(to));
});
// Dart's whitespace, which unlike JavaScript's includes U+0085.
const DART_SPACE = String.raw`[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`;
const LEADING_SPACE = new RegExp(`^${DART_SPACE}+`);
const TRAILING_SPACE = new RegExp(`${DART_SPACE}+$`);
define('String.trim', (_runtime, receiver) => self(receiver).replace(LEADING_SPACE, '').replace(TRAILING_SPACE, ''));
define('String.trimLeft', (_runtime, receiver) => self(receiver).replace(LEADING_SPACE, ''));
define('String.trimRight', (_runtime, receiver) => self(receiver).replace(TRAILING_SPACE, ''));
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
  if (typeof pattern === 'string') return text.includes(pattern, index(at));
  return matchAt(runtime, pattern, text, index(at), false) !== undefined;
});

/** The matches of a pattern in a string, from `start`, as `Pattern.allMatches` gives them. */
function* matchesOf(runtime: Runtime, pattern: Value, text: string, start = 0): IterableIterator<MatchState> {
  if (typeof pattern === 'string') {
    let position = text.indexOf(pattern, start);
    while (position >= 0 && position <= text.length) {
      const end = position + pattern.length;
      runtime.spend();
      yield { start: position, end, groups: [pattern], names: undefined, input: text, pattern };
      const next = position + Math.max(1, pattern.length);
      if (next > text.length) break;
      position = text.indexOf(pattern, next);
    }
    return;
  }
  if (isRegExp(pattern)) {
    yield* allMatchesOf(runtime, pattern, text, start);
    return;
  }
  const iterable = runtime.invoke(
    pattern,
    'allMatches',
    { positional: [text, BigInt(start)], named: undefined },
    [],
    undefined
  );
  for (const match of iteratorValues(runtime, iterable, 0n, undefined)) {
    yield {
      start: Number(runtime.getProperty(match, 'start', undefined)),
      end: Number(runtime.getProperty(match, 'end', undefined)),
      groups: [],
      names: undefined,
      input: text,
      pattern,
      object: match,
    };
  }
}

function replaceWith(
  runtime: Runtime,
  text: string,
  matches: Iterable<MatchState>,
  replace: (match: MatchState) => string
): string {
  let result = '';
  let last = 0;
  for (const match of matches) {
    result += text.slice(last, match.start) + replace(match);
    last = match.end;
    checkLength(runtime, result.length);
  }
  return result + text.slice(last);
}

function mappedReplacement(runtime: Runtime, replace: Value): (match: MatchState) => string {
  return (match) => {
    const value = runtime.callValue(
      replace,
      { positional: [match.object ?? newMatch(runtime, match)], named: undefined },
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
  const [match] = matchesOf(runtime, from, text, index(at));
  return match ? replaceWith(runtime, text, [match], () => replacement) : text;
});
define('String.replaceFirstMapped', (runtime, receiver, [from, replace, start = 0n]) => {
  const text = self(receiver);
  const at = intArg(runtime, start, 'startIndex');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'startIndex');
  const [match] = matchesOf(runtime, from, text, index(at));
  return match ? replaceWith(runtime, text, [match], mappedReplacement(runtime, replace)) : text;
});
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
  if (from < 0n || from > BigInt(text.length)) rangeError(runtime, from, 0, text.length, 'start');
  if (to < from || to > BigInt(text.length)) rangeError(runtime, to, Number(from), text.length, 'end');
  return text.slice(0, index(from)) + stringArg(runtime, replacement, 'replacement') + text.slice(index(to));
});
define('String.split', (runtime, receiver, [pattern]) => {
  const text = self(receiver);
  const stringType = interfaceType(coreTypes.string);
  if (typeof pattern === 'string') {
    if (pattern.length === 0) return newList(runtime, stringType, text.split(''));
    return newList(runtime, stringType, text.split(pattern));
  }
  if (text.length === 0) {
    const empty = matchAt(runtime, pattern, text, 0, true);
    return newList(runtime, stringType, empty ? [] : ['']);
  }
  const parts: Value[] = [];
  let start = 0;
  for (const match of matchesOf(runtime, pattern, text)) {
    if (match.end === match.start && (match.start === 0 || match.start === text.length)) continue;
    parts.push(text.slice(start, match.start));
    start = match.end;
  }
  parts.push(text.slice(start));
  return newList(runtime, stringType, parts);
});
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
  let result = '';
  let last = 0;
  for (const match of matchesOf(runtime, pattern, text)) {
    result += nonMatch(text.slice(last, match.start));
    result += onMatch === undefined ? text.slice(match.start, match.end) : mappedReplacement(runtime, onMatch)(match);
    last = match.end;
  }
  return result + nonMatch(text.slice(last));
});
define('String.codeUnits', (runtime, receiver) => {
  const text = self(receiver);
  runtime.allocate(text.length + 1);
  const units = new DartList(
    coreTypes.list,
    interfaceType(coreTypes.int),
    // oxlint-disable-next-line unicorn/prefer-code-point -- Dart's code units are UTF-16 code units.
    Array.from({ length: text.length }, (_, position) => BigInt(text.charCodeAt(position))),
    false,
    true
  );
  units.vmType = interfaceType(runtime.links.classNamed('CodeUnits'));
  return units;
});
define('String.runes', (runtime, receiver) => runtime.links.construct(runtime, 'Runes', '', [receiver]));
define('String.toLowerCase', (_runtime, receiver) => mapCase(self(receiver), false));
define('String.toUpperCase', (_runtime, receiver) => mapCase(self(receiver), true));

/**
 * Case mapping as the VM does it: one UTF-16 code unit at a time with Unicode's simple mappings, so `ß` and ligatures
 * stay as they are, a final sigma is not special, and `İ` lowercases to `i`.
 */
function mapCase(text: string, upper: boolean): string {
  let result = '';
  for (const unit of text.split('')) {
    if (unit === '\u0130' && !upper) {
      result += 'i';
      continue;
    }
    const mapped = upper ? unit.toUpperCase() : unit.toLowerCase();
    result += mapped.length === 1 ? mapped : unit;
  }
  return result;
}
define('String.toString', (_runtime, receiver) => receiver);
define('String.allMatches', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'string');
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'start');
  const matches = Array.from(matchesOf(runtime, receiver, text, index(at)), (match) =>
    runtime.links.construct(runtime, '_StringMatch', '', [BigInt(match.start), text, receiver])
  );
  const list = newList(runtime, interfaceType(runtime.links.classNamed('Match')), matches, false);
  return runtime.links.construct(runtime, '_StringAllMatchesIterable', '_', [list]);
});
define('String.matchAsPrefix', (runtime, receiver, [input, start = 0n]) => {
  const text = stringArg(runtime, input, 'string');
  const at = intArg(runtime, start, 'start');
  if (at < 0n || at > BigInt(text.length)) rangeError(runtime, at, 0, text.length, 'start');
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
  return stringFromCharCodes(runtime, codes, from, to);
});
define('String.fromCharCode', (runtime, _receiver, [code]) => characterOf(runtime, intArg(runtime, code, 'charCode')));
define('String.fromEnvironment', (_runtime, _receiver, _args, namedArgs) => named(namedArgs, 'defaultValue', ''));

// code-gauge-allow functionCognitiveComplexity 16 -- The VM distinguishes invalid codes in lists and iterators.
function stringFromCharCodes(runtime: Runtime, codes: Value, from: bigint, to: bigint | undefined): string {
  const parts: string[] = [];
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
    parts.push(text);
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
  return parts.join('');
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
  text: string;
  values(): Iterable<Value>;
}

function bufferOf(receiver: Value): BufferState {
  return (receiver as DartObject).native as unknown as BufferState;
}

defineConstructor('StringBuffer.new', (runtime, instance, args) => {
  const object = instance as DartObject;
  const content = args.positional[0];
  object.native = { text: content === undefined ? '' : stringOf(runtime, content), values: () => [] };
  return;
});
define('StringBuffer.length', (_runtime, receiver) => BigInt(bufferOf(receiver).text.length));
define('StringBuffer.isEmpty', (_runtime, receiver) => bufferOf(receiver).text.length === 0);
define('StringBuffer.isNotEmpty', (_runtime, receiver) => bufferOf(receiver).text.length > 0);
define('StringBuffer.write', (runtime, receiver, [value]) => appendBuffer(runtime, receiver, stringOf(runtime, value)));
define('StringBuffer.writeCharCode', (runtime, receiver, [code]) =>
  appendBuffer(runtime, receiver, characterOf(runtime, intArg(runtime, code, 'charCode')))
);
define('StringBuffer.writeln', (runtime, receiver, args) =>
  appendBuffer(runtime, receiver, `${args.length === 0 ? '' : stringOf(runtime, args[0])}\n`)
);
define('StringBuffer.clear', (_runtime, receiver) => {
  bufferOf(receiver).text = '';
  return;
});
define('StringBuffer.toString', (_runtime, receiver) => bufferOf(receiver).text);

function appendBuffer(runtime: Runtime, receiver: Value, text: string): undefined {
  const buffer = bufferOf(receiver);
  checkLength(runtime, buffer.text.length + text.length);
  buffer.text += text;
  return undefined;
}

export function characterOf(runtime: Runtime, code: bigint): string {
  if (code < 0n || code > 0x10_ff_ffn) rangeError(runtime, code, 0, 0x10_ff_ff, undefined);
  return String.fromCodePoint(Number(code));
}
