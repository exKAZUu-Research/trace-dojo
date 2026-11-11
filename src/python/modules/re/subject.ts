import { bytesLikeData, latin1Bytes, latin1Text, newBytes } from '../../bytesValues';
import { currentRuntime } from '../../runtimeContext';
import { hasSurrogates } from '../../strings';
import { typeError, typeName, unbox } from '../../types';
import type { PyValue } from '../../values';

/**
 * A string or bytes-like object that a pattern matches against, with its code points or bytes, since positions in
 * Python count them. A bytes subject's text holds one character per byte.
 */
export interface Subject {
  text: string;
  codes: number[];
  /** Whether every code point is one UTF-16 code unit, so that code point positions index `text` directly. */
  plain: boolean;
  isBytes: boolean;
  /** The object the program passed, which `Match.string` gives back. */
  original: PyValue;
}

/**
 * Reads what a method matches against, raising CPython's TypeError for other values and for a subject whose type
 * differs from a str (`isBytes` false) or bytes (`isBytes` true) pattern's; a `re.Scanner` pattern takes either.
 */
export function toSubject(value: PyValue, isBytes: boolean | undefined): Subject {
  const text = unbox(value);
  if (typeof text === 'string') {
    if (isBytes === true) throw typeError('cannot use a bytes pattern on a string-like object');
    return { ...codePoints(text), isBytes: false, original: value };
  }
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`expected string or bytes-like object, got '${typeName(value)}'`);
  if (isBytes === false) throw typeError('cannot use a string pattern on a bytes-like object');
  currentRuntime().scan(data.length);
  return { text: latin1Text(data), codes: [...data], plain: true, isBytes: true, original: value };
}

export function codePoints(text: string): Omit<Subject, 'isBytes' | 'original'> {
  currentRuntime().scan(text.length);
  if (!hasSurrogates(text)) {
    const codes = Array.from({ length: text.length }, (_, index) => text.codePointAt(index) as number);
    return { text, codes, plain: true };
  }
  const codes: number[] = [];
  for (const char of text) codes.push(char.codePointAt(0) as number);
  return { text, codes, plain: false };
}

export function substring(subject: Subject, start: number, end: number): string {
  if (subject.plain) return subject.text.slice(start, end);
  let result = '';
  for (let index = start; index < end; index++) result += String.fromCodePoint(subject.codes[index]);
  return result;
}

/** A slice of the subject as Python gives it: a str, or bytes for any bytes-like subject. */
export function sliceOf(subject: Subject, start: number, end: number): PyValue {
  const text = substring(subject, start, end);
  return subject.isBytes ? newBytes(latin1Bytes(text)) : text;
}

/** Joins pieces as str or bytes, raising CPython's TypeError for a piece of the other type. */
export function joinPieces(isBytes: boolean, pieces: readonly PyValue[]): PyValue {
  let text = '';
  for (const [index, piece] of pieces.entries()) {
    const value = unbox(piece);
    if (isBytes) {
      const data = bytesLikeData(piece);
      if (data === undefined) {
        throw typeError(`sequence item ${index}: expected a bytes-like object, ${typeName(piece)} found`);
      }
      text += latin1Text(data);
    } else {
      if (typeof value !== 'string') {
        throw typeError(`sequence item ${index}: expected str instance, ${typeName(piece)} found`);
      }
      text += value;
    }
  }
  currentRuntime().buildString(text.length);
  return isBytes ? newBytes(latin1Bytes(text)) : text;
}
