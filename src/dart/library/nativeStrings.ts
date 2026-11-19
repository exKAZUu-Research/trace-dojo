import { LIMITS } from '../../interpreter/limits';
import { stringOf } from '../format';
import { concatenate } from '../operators';
import type { Runtime } from '../runtime';
import { coreTypes, interfaceType } from '../types';
import { DartList, type DartObject, type Value } from '../values';
import { allMatchesOf, isRegExp, matchAt, type MatchState, newMatch } from './nativeRegExp';
import { define, defineConstructor, index, intArg, iterableValues, named, newList, stringArg } from './nativeSupport';

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
define('String.trim', (_runtime, receiver) => self(receiver).trim());
define('String.trimLeft', (_runtime, receiver) => self(receiver).trimStart());
define('String.trimRight', (_runtime, receiver) => self(receiver).trimEnd());
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
function matchesOf(runtime: Runtime, pattern: Value, text: string, start = 0): MatchState[] {
  if (typeof pattern === 'string') {
    const result: MatchState[] = [];
    if (pattern.length === 0) {
      for (let position = start; position <= text.length; position++)
        result.push({ start: position, end: position, groups: [''], names: undefined, input: text, pattern });
      return result;
    }
    let position = text.indexOf(pattern, start);
    while (position >= 0) {
      result.push({
        start: position,
        end: position + pattern.length,
        groups: [pattern],
        names: undefined,
        input: text,
        pattern,
      });
      position = text.indexOf(pattern, position + pattern.length);
    }
    return result;
  }
  if (isRegExp(pattern)) return allMatchesOf(runtime, pattern, text, start);
  const iterable = runtime.invoke(
    pattern,
    'allMatches',
    { positional: [text, BigInt(start)], named: undefined },
    [],
    undefined
  );
  return iterableValues(runtime, iterable).map((match) => ({
    start: Number(runtime.getProperty(match, 'start', undefined)),
    end: Number(runtime.getProperty(match, 'end', undefined)),
    groups: [runtime.invoke(match, 'group', { positional: [0n], named: undefined }, [], undefined) as string],
    names: undefined,
    input: text,
    pattern,
    object: match,
  }));
}

function replaceWith(
  runtime: Runtime,
  text: string,
  matches: MatchState[],
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
  const matches = matchesOf(runtime, receiver, text, index(at)).map((match) =>
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
  const values = iterableValues(runtime, codes).map((code) => Number(intArg(runtime, code, 'charCodes')));
  const from = Number(intArg(runtime, start, 'start'));
  const to = end === undefined ? values.length : Number(intArg(runtime, end, 'end'));
  if (from < 0 || from > values.length) rangeError(runtime, BigInt(from), 0, values.length, 'start');
  if (to < from || to > values.length) rangeError(runtime, BigInt(to), from, values.length, 'end');
  return values
    .slice(from, to)
    .map((code) => {
      if (code < 0 || code > 0x10_ff_ff) rangeError(runtime, BigInt(code), 0, 0x10_ff_ff, undefined);
      return String.fromCodePoint(code);
    })
    .join('');
});
define('String.fromCharCode', (runtime, _receiver, [code]) => {
  const value = Number(intArg(runtime, code, 'charCode'));
  if (value < 0 || value > 0x10_ff_ff) rangeError(runtime, BigInt(value), 0, 0x10_ff_ff, undefined);
  return String.fromCodePoint(value);
});
define('String.fromEnvironment', (_runtime, _receiver, _args, namedArgs) => named(namedArgs, 'defaultValue', ''));

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
define('StringBuffer.write', (runtime, receiver, [value]) => {
  const buffer = bufferOf(receiver);
  const text = stringOf(runtime, value);
  checkLength(runtime, buffer.text.length + text.length);
  buffer.text += text;
  return;
});
define('StringBuffer.writeCharCode', (runtime, receiver, [code]) => {
  bufferOf(receiver).text += String.fromCodePoint(Number(intArg(runtime, code, 'charCode')));
  return;
});
define('StringBuffer.writeln', (runtime, receiver, [value = '']) => {
  const buffer = bufferOf(receiver);
  const text = `${stringOf(runtime, value)}\n`;
  checkLength(runtime, buffer.text.length + text.length);
  buffer.text += text;
  return;
});
define('StringBuffer.clear', (_runtime, receiver) => {
  bufferOf(receiver).text = '';
  return;
});
define('StringBuffer.toString', (_runtime, receiver) => bufferOf(receiver).text);
