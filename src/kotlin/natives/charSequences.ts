import { callFunction, getPropertyValue } from '../dispatch';
import { charToString, stringOf } from '../format';
import type { Frame } from '../runtime';
import { KObject, type Value } from '../values';
import { checkStringIndex, substring } from './core';
import { foldJdkCodePoint } from './jdkCase';
import { libraryClass, throwError } from './registry';
import { textSearch } from './textSearch';

export interface Sequence {
  length: () => number;
  at: (index: number) => number;
  subSequenceText: (from: number, to: number) => string;
  charge: () => void;
}

export function sequenceAll(frame: Frame, value: Value, predicate: (char: number) => boolean): boolean {
  const source = charSequence(frame, value);
  for (let index = 0; index < source.length(); index++) {
    if (!predicate(source.at(index))) return false;
  }
  return true;
}

export function sequenceMatchesAt(
  frame: Frame,
  value: Value,
  other: Value,
  index: number,
  ignoreCase: boolean
): boolean {
  if (!ignoreCase && typeof value === 'string' && typeof other === 'string')
    return textSearch(frame, value, other, false).matchesAt(index);
  const target = charSequence(frame, other);
  return regionMatches(charSequence(frame, value), index, target, 0, target.length(), ignoreCase);
}

export function sequenceIndexOf(
  frame: Frame,
  value: Value,
  other: Value,
  start: number,
  ignoreCase: boolean,
  backwards = false
): number {
  if (typeof value === 'string' && typeof other === 'string') {
    const search = textSearch(frame, value, other, ignoreCase);
    return backwards ? search.lastIndexOf(start) : search.indexOf(start);
  }
  const source = charSequence(frame, value);
  return searchRegions(source, charSequence(frame, other), start, ignoreCase, backwards);
}

export function sequenceIndexOfChar(
  frame: Frame,
  value: Value,
  char: number,
  start: number,
  ignoreCase: boolean,
  backwards = false
): number {
  if (typeof value === 'string') {
    const search = textSearch(frame, value, charToString(char), ignoreCase, true);
    return backwards ? search.lastIndexOf(start) : search.indexOf(start);
  }
  const source = charSequence(frame, value);
  const last = source.length() - 1;
  return findIndex(
    (index) => charactersEqual(source.at(index), char, ignoreCase),
    backwards ? Math.min(start, last) : Math.max(0, start),
    backwards ? 0 : last,
    backwards
  );
}

export function sequenceIndexOfAnyChar(
  frame: Frame,
  value: Value,
  chars: number[],
  start: number,
  ignoreCase: boolean,
  backwards: boolean
): number {
  if (chars.length === 1) return sequenceIndexOfChar(frame, value, chars[0], start, ignoreCase, backwards);
  return findAnyChar(charSequence(frame, value), chars, start, ignoreCase, backwards);
}

export function sequenceFindAnyString(
  frame: Frame,
  value: Value,
  strings: string[],
  start: number,
  ignoreCase: boolean,
  backwards: boolean
): { index: number; delimiter: string } | undefined {
  if (!ignoreCase && strings.length === 1) {
    const index = sequenceIndexOf(frame, value, strings[0], start, false, backwards);
    return index === -1 ? undefined : { index, delimiter: strings[0] };
  }
  if (typeof value === 'string') {
    const matchers = strings.map((text) => textSearch(frame, value, text, ignoreCase));
    const charge = sequenceWork(frame);
    let found = -1;
    const index = findIndex(
      (index) => {
        found = matchers.findIndex((matcher) => {
          charge();
          return matcher.matchesAt(index);
        });
        return found !== -1;
      },
      backwards ? Math.min(start, value.length - 1) : Math.max(0, start),
      backwards ? 0 : value.length,
      backwards
    );
    return index === -1 ? undefined : { index, delimiter: strings[found] };
  }
  const source = charSequence(frame, value);
  const targets = strings.map((text) => charSequence(frame, text));
  const match = findAnyString(source, targets, start, ignoreCase, backwards);
  return match && { index: match.index, delimiter: strings[match.position] };
}

export function sequenceRegionMatches(
  frame: Frame,
  left: Value,
  right: Value,
  { from, otherFrom, count, ignoreCase }: { from: number; otherFrom: number; count: number; ignoreCase: boolean }
): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    if (from < 0 || otherFrom < 0 || from > left.length - count || otherFrom > right.length - count) return false;
    if (count <= 0) return true;
    return textSearch(
      frame,
      left.slice(from, from + count),
      right.slice(otherFrom, otherFrom + count),
      ignoreCase
    ).matchesAt(0);
  }
  return regionMatches(charSequence(frame, left), from, charSequence(frame, right), otherFrom, count, ignoreCase);
}

export function sequenceContentEquals(frame: Frame, left: Value, right: Value, ignoreCase: boolean): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (typeof left === 'string' && typeof right === 'string') {
    return ignoreCase && left.length === right.length && textSearch(frame, left, right, true).matchesAt(0);
  }
  const first = charSequence(frame, left);
  const second = charSequence(frame, right);
  if (first.length() !== second.length()) return false;
  const length = first.length();
  for (let index = 0; index < length; index++) {
    if (!charactersEqual(first.at(index), second.at(index), ignoreCase)) return false;
  }
  return true;
}

export function sequenceSplit(
  frame: Frame,
  value: Value,
  delimiters: string[],
  { ignoreCase, byChar, limit }: { ignoreCase: boolean; byChar: boolean; limit: number }
): { singleton: boolean; parts: string[] } {
  if (limit < 0)
    throwError(frame, 'java.lang.IllegalArgumentException', `Limit must be non-negative, but was ${limit}`);
  const source = charSequence(frame, value);
  const [delimiter] = delimiters;
  if (delimiters.length === 1 && delimiter !== '') {
    const target = charSequence(frame, delimiter);
    const first = searchRegions(source, target, 0, ignoreCase, false);
    if (first === -1 || limit === 1) return { singleton: true, parts: [stringOf(frame, value)] };
    return { singleton: false, parts: splitByOne(source, target, first, limit, ignoreCase) };
  }
  const find = byChar
    ? charDelimiterSearch(
        source,
        delimiters.map((value) =>
          // oxlint-disable-next-line unicorn/prefer-code-point -- a Kotlin delimiter Char is a single code unit.
          value.charCodeAt(0)
        ),
        ignoreCase
      )
    : stringDelimiterSearch(frame, source, delimiters, ignoreCase);
  return { singleton: false, parts: splitByDelimiters(frame, source, limit, find) };
}

export function sequenceLines(frame: Frame, value: Value): string[] {
  const source = charSequence(frame, value);
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    let end = source.length();
    const length = source.length();
    let separator = 0;
    for (let index = start; index < length; index++) {
      const char = source.at(index);
      if (char !== 10 && char !== 13) continue;
      end = index;
      separator = char === 13 && index + 1 < source.length() && source.at(index + 1) === 10 ? 2 : 1;
      break;
    }
    parts.push(source.subSequenceText(start, end));
    if (separator === 0) return parts;
    start = end + separator;
  }
}

export function charSequence(frame: Frame, value: Value): Sequence {
  const access = sequenceAccess(frame, value);
  const charge = sequenceWork(frame);
  return {
    charge,
    length: () => {
      charge();
      return access.length();
    },
    at: (index) => {
      charge();
      return access.at(index);
    },
    subSequenceText: (from, to) => {
      charge();
      return access.subSequenceText(from, to);
    },
  };
}

function sequenceWork(frame: Frame): () => void {
  let remaining = 1;
  return () => {
    if (--remaining > 0) return;
    frame.runtime.spend();
    remaining = 64;
  };
}

function sequenceAccess(frame: Frame, value: Value): Omit<Sequence, 'charge'> {
  if (typeof value === 'string') {
    return {
      length: () => value.length,
      // oxlint-disable-next-line unicorn/prefer-code-point -- CharSequence characters are UTF-16 code units.
      at: (index) => value.charCodeAt(index),
      subSequenceText: (from, to) => value.slice(from, to),
    };
  }
  if (value instanceof KObject && value.builder) {
    const storage = value.builder;
    return {
      length: () => storage.length,
      at: (index) => {
        checkStringIndex(frame, index, storage.readableLength);
        return storage.codeAt(index);
      },
      subSequenceText: (from, to) => {
        frame.runtime.spend(1 + Math.floor(storage.length / 64));
        return substring(frame, storage.text(), from, to);
      },
    };
  }
  const owner = libraryClass('kotlin.CharSequence');
  const length = owner.members.get('length')?.find((member) => member.kind === 'property');
  const get = owner.members.get('get')?.find((member) => member.kind === 'function');
  const subSequence = owner.members.get('subSequence')?.find((member) => member.kind === 'function');
  if (!length || !get || !subSequence) throw new Error('Missing CharSequence members');
  return {
    length: () => getPropertyValue(length, frame, value) as number,
    at: (index) => callFunction(get, frame, value, [index], undefined) as number,
    subSequenceText: (from, to) => stringOf(frame, callFunction(subSequence, frame, value, [from, to], undefined)),
  };
}

function splitByOne(source: Sequence, target: Sequence, first: number, limit: number, ignoreCase: boolean): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let match = first; match !== -1; match = searchRegions(source, target, from, ignoreCase, false)) {
    parts.push(source.subSequenceText(from, match));
    from = match + target.length();
    if (limit > 0 && parts.length === limit - 1) break;
  }
  parts.push(source.subSequenceText(from, source.length()));
  return parts;
}

type DelimiterSearch = (start: number) => { index: number; length: number } | undefined;

function charDelimiterSearch(source: Sequence, delimiters: number[], ignoreCase: boolean): DelimiterSearch {
  return (start) => {
    const index = findAnyChar(source, delimiters, start, ignoreCase, false);
    return index === -1 ? undefined : { index, length: 1 };
  };
}

function findAnyChar(
  source: Sequence,
  chars: number[],
  start: number,
  ignoreCase: boolean,
  backwards: boolean
): number {
  const last = source.length() - 1;
  return findIndex(
    (index) => {
      const char = source.at(index);
      return chars.some((other) => {
        source.charge();
        return charactersEqual(char, other, ignoreCase);
      });
    },
    backwards ? Math.min(start, last) : Math.max(0, start),
    backwards ? 0 : last,
    backwards
  );
}

function stringDelimiterSearch(
  frame: Frame,
  source: Sequence,
  delimiters: string[],
  ignoreCase: boolean
): DelimiterSearch {
  const targets = delimiters.map((value) => charSequence(frame, value));
  return (start) => findAnyString(source, targets, start, ignoreCase, false);
}

function findAnyString(
  source: Sequence,
  targets: Sequence[],
  start: number,
  ignoreCase: boolean,
  backwards: boolean
): { index: number; length: number; position: number } | undefined {
  const last = source.length();
  const step = backwards ? -1 : 1;
  const from = backwards ? Math.min(start, last - 1) : Math.max(0, start);
  const to = backwards ? 0 : last;
  for (let index = from; (to - index) * step >= 0; index += step) {
    const position = targets.findIndex((target) =>
      regionMatches(target, 0, source, index, target.length(), ignoreCase)
    );
    if (position !== -1) return { index, length: targets[position].length(), position };
  }
}

function splitByDelimiters(frame: Frame, source: Sequence, limit: number, find: DelimiterSearch): string[] {
  const parts: string[] = [];
  const length = source.length();
  if (length < 0)
    throwError(
      frame,
      'java.lang.IllegalArgumentException',
      `Cannot coerce value to an empty range: maximum ${length} is less than minimum 0.`
    );
  let from = 0;
  let searchAt = from;
  while ((limit === 0 || parts.length < limit - 1) && searchAt <= source.length()) {
    const match = find(searchAt);
    if (!match) break;
    parts.push(source.subSequenceText(from, match.index));
    from = match.index + match.length;
    searchAt = from + (match.length === 0 ? 1 : 0);
  }
  parts.push(source.subSequenceText(from, source.length()));
  return parts;
}

function searchRegions(
  source: Sequence,
  target: Sequence,
  start: number,
  ignoreCase: boolean,
  backwards: boolean
): number {
  const match = (index: number): boolean => regionMatches(target, 0, source, index, target.length(), ignoreCase);
  if (backwards) return findIndex(match, Math.min(start, source.length() - 1), 0, true);
  const end = source.length();
  return findIndex(match, Math.max(start, 0), Math.min(end, source.length()), false);
}

// code-gauge-allow functionParameterCount 6 -- both input offsets, the region length, and case handling follow Kotlin's region matching contract.
function regionMatches(
  first: Sequence,
  firstOffset: number,
  second: Sequence,
  secondOffset: number,
  length: number,
  ignoreCase: boolean
): boolean {
  if (
    firstOffset < 0 ||
    secondOffset < 0 ||
    firstOffset > first.length() - length ||
    secondOffset > second.length() - length
  )
    return false;
  for (let offset = 0; offset < length; offset++) {
    if (!charactersEqual(first.at(firstOffset + offset), second.at(secondOffset + offset), ignoreCase)) return false;
  }
  return true;
}

function findIndex(predicate: (index: number) => boolean, start: number, stop: number, backwards: boolean): number {
  const step = backwards ? -1 : 1;
  for (let index = start; (stop - index) * step >= 0; index += step) {
    if (predicate(index)) return index;
  }
  return -1;
}

function charactersEqual(left: number, right: number, ignoreCase: boolean): boolean {
  return left === right || (ignoreCase && foldJdkCodePoint(left) === foldJdkCodePoint(right));
}
