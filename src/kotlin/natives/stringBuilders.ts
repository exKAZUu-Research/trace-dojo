import { charToString, formatPrimitive, stringOf } from '../format';
import type { Frame } from '../runtime';
import { StringBuilderStorage } from '../stringBuilderStorage';
import { KObject, UNIT, type Value } from '../values';
import { charSequence, type Sequence } from './charSequences';
import { checkStringIndex, compareStrings, reverseKeepingPairs, stringRangeError, substring } from './core';
import { defineNative, defineNativeProperty, throwError } from './registry';

const BUILDER = 'kotlin.text.StringBuilder';

export function defineStringBuilders(): void {
  defineConstructors();
  defineReaders();
  defineAppenders();
  defineEditors();
}

function defineConstructors(): void {
  defineNative(`${BUILDER}.<init>()`, (_frame, instance) => {
    (instance as KObject).builder = new StringBuilderStorage(16);
    return UNIT;
  });
  defineNative(`${BUILDER}.<init>(Int)`, (frame, instance, [capacity]) => {
    const size = capacity as number;
    if (size < 0) throwError(frame, 'java.lang.NegativeArraySizeException', String(size));
    frame.runtime.allocateString(frame, size, 0);
    (instance as KObject).builder = new StringBuilderStorage(size);
    return UNIT;
  });
  defineNative(`${BUILDER}.<init>(String)`, (frame, instance, [content]) => {
    const value = content as string;
    (instance as KObject).builder = new StringBuilderStorage(value.length + 16);
    appendText(frame, instance, value);
    return UNIT;
  });
  defineNative(`${BUILDER}.<init>(CharSequence)`, (frame, instance, [content]) => {
    const size = charSequence(frame, content).length();
    if (size < 0) throwError(frame, 'java.lang.NegativeArraySizeException', `Negative length: ${size}`);
    frame.runtime.allocateString(frame, size + 16, 0);
    (instance as KObject).builder = new StringBuilderStorage(size + 16);
    appendSequence(frame, instance, content);
    return UNIT;
  });
}

function defineReaders(): void {
  defineNativeProperty(`${BUILDER}.length`, (_frame, receiver) => builder(receiver).length);
  defineNative(`${BUILDER}.get(Int)`, (frame, receiver, [index]) => {
    const storage = builder(receiver);
    const position = index as number;
    checkStringIndex(frame, position, storage.length);
    return storage.codeAt(position);
  });
  defineNative(`${BUILDER}.subSequence(Int, Int)`, builderSubstring);
  defineNative(`${BUILDER}.substring(Int, Int)`, builderSubstring);
  defineNative(`${BUILDER}.substring(Int)`, (frame, receiver, [start]) =>
    builderSubstring(frame, receiver, [start, builder(receiver).length])
  );
  defineNative(`${BUILDER}.indexOf(String)`, (_frame, receiver, [value]) =>
    builder(receiver)
      .text()
      .indexOf(value as string)
  );
  defineNative(`${BUILDER}.lastIndexOf(String)`, (_frame, receiver, [value]) =>
    builder(receiver)
      .text()
      .lastIndexOf(value as string)
  );
  defineNative(`${BUILDER}.compareTo(StringBuilder)`, (_frame, receiver, [other]) =>
    compareStrings(builder(receiver).text(), builder(other).text())
  );
  defineNative(`${BUILDER}.toString()`, (frame, receiver) => {
    const storage = builder(receiver);
    frame.runtime.allocateString(frame, storage.length);
    return storage.text();
  });
}

function builderSubstring(frame: Frame, receiver: Value, [start, end]: Value[]): string {
  return substring(frame, builder(receiver).text(), start as number, end as number);
}

function defineAppenders(): void {
  defineNative(`${BUILDER}.append(Any?)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, stringOf(frame, value))
  );
  defineNative(`${BUILDER}.append(String?)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, (value as string | undefined) ?? 'null')
  );
  defineNative(`${BUILDER}.append(CharSequence?)`, (frame, receiver, [value]) =>
    appendSequence(frame, receiver, value)
  );
  defineNative(`${BUILDER}.append(CharSequence?, Int, Int)`, (frame, receiver, [value, from, to]) =>
    appendSequenceRange(frame, receiver, charSequence(frame, value ?? 'null'), from as number, to as number)
  );
  defineNative(`${BUILDER}.append(Char)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, charToString(value as number))
  );
  defineNative(`${BUILDER}.append(Int)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, String(value as number))
  );
  defineNative(`${BUILDER}.append(Long)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, String(value as bigint))
  );
  defineNative(`${BUILDER}.append(Double)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, formatPrimitive('Double', value as number))
  );
  defineNative(`${BUILDER}.append(Boolean)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, String(value as boolean))
  );
  defineNative(`${BUILDER}.append(CharArray?)`, (frame, receiver, [value]) =>
    appendText(frame, receiver, charArrayText(frame, value))
  );
}

function defineEditors(): void {
  defineInsertions();
  defineReplacements();
  defineNative(`${BUILDER}.reverse()`, (frame, receiver) => {
    const storage = builder(receiver);
    return replaceText(frame, receiver, 0, storage.length, reverseKeepingPairs(storage.text()));
  });
  defineNative(`${BUILDER}.setLength(Int)`, (frame, receiver, [length]) => {
    const storage = builder(receiver);
    const size = length as number;
    if (size < 0) throwError(frame, 'java.lang.StringIndexOutOfBoundsException', `String index out of range: ${size}`);
    frame.runtime.allocateString(frame, size, Math.max(0, size - storage.length));
    storage.resize(size);
    return UNIT;
  });
}

function defineInsertions(): void {
  defineNative(`${BUILDER}.insert(Int, Any?)`, (frame, receiver, [index, value]) =>
    insertText(frame, receiver, index as number, stringOf(frame, value))
  );
  defineNative(`${BUILDER}.insert(Int, String?)`, (frame, receiver, [index, value]) =>
    insertText(frame, receiver, index as number, (value as string | undefined) ?? 'null')
  );
  defineNative(`${BUILDER}.insert(Int, CharArray?)`, (frame, receiver, [index, value]) => {
    const position = index as number;
    checkInsertPosition(frame, position, builder(receiver).length);
    return replaceText(frame, receiver, position, position, charArrayText(frame, value));
  });
  defineNative(`${BUILDER}.insert(Int, CharSequence?)`, (frame, receiver, [index, value]) => {
    const source = charSequence(frame, value ?? 'null');
    return insertSequenceRange(frame, receiver, index as number, source, 0, source.length());
  });
  defineNative(`${BUILDER}.insert(Int, CharSequence?, Int, Int)`, (frame, receiver, [index, value, from, to]) =>
    insertSequenceRange(
      frame,
      receiver,
      index as number,
      charSequence(frame, value ?? 'null'),
      from as number,
      to as number
    )
  );
}

function defineReplacements(): void {
  defineNative(`${BUILDER}.replace(Int, Int, String)`, (frame, receiver, [start, end, value]) =>
    replaceRange(frame, receiver, start as number, end as number, value as string)
  );
  defineNative(`${BUILDER}.delete(Int, Int)`, (frame, receiver, [start, end]) =>
    replaceRange(frame, receiver, start as number, end as number, '')
  );
  defineNative(`${BUILDER}.deleteCharAt(Int)`, (frame, receiver, [index]) => {
    const position = index as number;
    checkStringIndex(frame, position, builder(receiver).length);
    return replaceText(frame, receiver, position, position + 1, '');
  });
  defineNative(`${BUILDER}.setCharAt(Int, Char)`, (frame, receiver, [index, char]) => {
    const position = index as number;
    checkStringIndex(frame, position, builder(receiver).length);
    replaceText(frame, receiver, position, position + 1, charToString(char as number), 1);
    return UNIT;
  });
}

function appendSequence(frame: Frame, receiver: Value, value: Value): Value {
  if (value === undefined || typeof value === 'string') return appendText(frame, receiver, value ?? 'null');
  if (value instanceof KObject && value.builder) return appendText(frame, receiver, value.builder.text());
  const source = charSequence(frame, value);
  return appendSequenceRange(frame, receiver, source, 0, source.length());
}

function appendSequenceRange(frame: Frame, receiver: Value, source: Sequence, from: number, to: number): Value {
  checkSequenceRange(frame, source, from, to);
  const storage = builder(receiver);
  const length = to - from;
  frame.runtime.allocateString(frame, storage.length + length, length);
  storage.append(length, (index) => source.at(from + index));
  return receiver;
}

function appendText(frame: Frame, receiver: Value, value: string): Value {
  const storage = builder(receiver);
  frame.runtime.allocateString(frame, storage.length + value.length, value.length);
  storage.appendText(value);
  return receiver;
}

function insertSequenceRange(
  frame: Frame,
  receiver: Value,
  position: number,
  source: Sequence,
  from: number,
  to: number
): Value {
  const storage = builder(receiver);
  const previous = storage.position();
  checkInsertPosition(frame, position, previous.length);
  checkSequenceRange(frame, source, from, to);
  const length = to - from;
  frame.runtime.allocateString(frame, previous.length + length, previous.length - position + length);
  storage.insert(position, length, (index) => source.at(from + index), previous);
  return receiver;
}

function checkSequenceRange(frame: Frame, source: Sequence, from: number, to: number): void {
  const available = source.length();
  if (from < 0 || to < from || to > available)
    throwError(
      frame,
      'java.lang.IndexOutOfBoundsException',
      `Range [${from}, ${to}) out of bounds for length ${available}`
    );
}

function insertText(frame: Frame, receiver: Value, position: number, value: string): Value {
  const count = builder(receiver).length;
  checkInsertPosition(frame, position, count);
  return replaceText(frame, receiver, position, position, value);
}

function checkInsertPosition(frame: Frame, position: number, count: number): void {
  if (position < 0 || position > count) stringRangeError(frame, position, count, count);
}

function replaceRange(frame: Frame, receiver: Value, from: number, end: number, value: string): Value {
  const count = builder(receiver).length;
  const to = Math.min(end, count);
  if (from < 0 || from > to) stringRangeError(frame, from, to, count);
  return replaceText(frame, receiver, from, to, value);
}

function replaceText(frame: Frame, receiver: Value, from: number, to: number, value: string, work?: number): Value {
  const storage = builder(receiver);
  const remaining = storage.length - to;
  frame.runtime.allocateString(frame, from + value.length + remaining, work ?? remaining + value.length);
  storage.replace(from, to, value);
  return receiver;
}

function charArrayText(frame: Frame, value: Value): string {
  if (value === undefined)
    throwError(frame, 'java.lang.NullPointerException', 'Cannot read the array length because "str" is null');
  return ((value as KObject).items as number[]).map(charToString).join('');
}

function builder(value: Value): StringBuilderStorage {
  return (value as KObject).builder as StringBuilderStorage;
}
