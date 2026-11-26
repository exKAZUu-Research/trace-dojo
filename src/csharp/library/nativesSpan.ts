// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { defineNatives, type NativeCall } from '../natives';
import { PendingException } from '../numeric';
import { runtimeSimpleName, valuesEqual } from '../objects';
import { isSpecial, type NamedType, type Type } from '../types';
import { type CsArray, CsObject, type CsString, CsStruct, freshString, stringText, type Value } from '../values';
import { evaluatorOf, fail, libraryType, newArray, typeArgument } from './support';

const SPAN = 'System.ReadOnlySpan`1';

/** The elements a span views: a stretch of an array's live storage, of a string's characters, or of UTF-8 bytes. */
export interface SpanView {
  values: readonly Value[];
  start: number;
  length: number;
}

const EMPTY: SpanView = { values: [], start: 0, length: 0 };

/** A `ReadOnlySpan<T>` over elements, which a `default` span, holding no view, leaves empty. */
export function newSpan(type: NamedType, view: SpanView): CsStruct {
  const span = new CsStruct(type, []);
  span.native = view;
  return span;
}

function viewOf(value: Value): SpanView {
  return ((value as CsStruct).native as SpanView | undefined) ?? EMPTY;
}

function spanOf(call: NativeCall, view: SpanView): CsStruct {
  return newSpan(libraryType(call, SPAN, [typeArgument(call)]), view);
}

function arrayView(array: Value): SpanView {
  const values = (array as CsArray | undefined)?.values ?? [];
  return { values, start: 0, length: values.length };
}

function elements(view: SpanView): Value[] {
  return view.values.slice(view.start, view.start + view.length);
}

function outOfRange(): never {
  throw new PendingException(
    'System.ArgumentOutOfRangeException',
    'Specified argument was out of the range of valid values.'
  );
}

function slice(view: SpanView, start: number, length = view.length - start): SpanView {
  if (start < 0 || length < 0 || start + length > view.length) outOfRange();
  return { values: view.values, start: view.start + start, length };
}

/** The type argument's name as `Type.Name` gives it, which `ToString()` shows. */
function elementName(type: Type): string {
  return runtimeSimpleName(type);
}

/** The enumerator of a span, at the element before its next one. */
interface SpanCursor {
  view: SpanView;
  index: number;
}

defineNatives({
  [`${SPAN}..ctor`]: (_call, receiver, [array]) => {
    (receiver as CsStruct).native = arrayView(array as Value);
    return;
  },
  [`${SPAN}.get_Length`]: (_call, receiver) => viewOf(receiver).length,
  [`${SPAN}.get_IsEmpty`]: (_call, receiver) => viewOf(receiver).length === 0,
  [`${SPAN}.get_Item`]: (_call, receiver, [index]) => {
    const view = viewOf(receiver);
    const offset = index as number;
    if (offset < 0 || offset >= view.length)
      throw new PendingException('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
    return view.values[view.start + offset];
  },
  [`${SPAN}.get_Empty`]: (call) => spanOf(call, EMPTY),
  [`${SPAN}.ToArray`]: (call, receiver) => newArray(call, typeArgument(call), elements(viewOf(receiver))),
  [`${SPAN}.Slice(int)`]: (call, receiver, [start]) => spanOf(call, slice(viewOf(receiver), start as number)),
  [`${SPAN}.Slice(int, int)`]: (call, receiver, [start, length]) =>
    spanOf(call, slice(viewOf(receiver), start as number, length as number)),
  [`${SPAN}.ToString`]: (call, receiver) => {
    const view = viewOf(receiver);
    const element = typeArgument(call);
    if (isSpecial(element, 'char'))
      return freshString((elements(view) as number[]).map((code) => String.fromCharCode(code)).join(''));
    return freshString(`System.ReadOnlySpan<${elementName(element)}>[${view.length}]`);
  },
  // Two spans are equal when they view the same elements of the same storage.
  [`${SPAN}.op_Equality`]: (_call, _receiver, [left, right]) => sameView(viewOf(left as Value), viewOf(right as Value)),
  [`${SPAN}.op_Inequality`]: (_call, _receiver, [left, right]) =>
    !sameView(viewOf(left as Value), viewOf(right as Value)),
  [`${SPAN}.op_Implicit`]: (call, _receiver, [array]) => spanOf(call, arrayView(array as Value)),
  [`${SPAN}.GetEnumerator`]: (call, receiver) => {
    const enumerator = new CsStruct(libraryType(call, `${SPAN}+Enumerator`, [typeArgument(call)]), []);
    enumerator.native = { view: viewOf(receiver), index: -1 } satisfies SpanCursor;
    return enumerator;
  },
  [`${SPAN}+Enumerator.MoveNext`]: (_call, receiver) => {
    const cursor = (receiver as CsStruct).native as SpanCursor | undefined;
    if (!cursor || cursor.index + 1 >= cursor.view.length) return false;
    cursor.index++;
    return true;
  },
  [`${SPAN}+Enumerator.get_Current`]: (_call, receiver) => {
    const cursor = (receiver as CsStruct).native as SpanCursor | undefined;
    return cursor ? cursor.view.values[cursor.view.start + cursor.index] : undefined;
  },
  'System.MemoryExtensions.SequenceEqual': (call, _receiver, [first, second]) => {
    const a = elements(viewOf(first as Value));
    const b = elements(viewOf(second as Value));
    const evaluator = evaluatorOf(call);
    return a.length === b.length && a.every((value, index) => valuesEqual(evaluator, value, b[index], call.frame));
  },
  'System.String.op_Implicit': (call, _receiver, [text]) => {
    const characters = text === undefined ? '' : stringText(text as CsString | string);
    const values = Array.from({ length: characters.length }, (_unused, index) => characters.charCodeAt(index));
    return newSpan(call.method.returnType as NamedType, { values, start: 0, length: values.length });
  },
});

function sameView(a: SpanView, b: SpanView): boolean {
  return a.length === b.length && (a.length === 0 || (a.values === b.values && a.start === b.start));
}

const ENCODING = 'System.Text.Encoding';

/** Decodes UTF-8 as .NET does, putting U+FFFD for each invalid sequence. */
function decodeUtf8(bytes: readonly Value[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes as number[]));
}

defineNatives({
  [`${ENCODING}.get_UTF8`]: (call) => {
    let encoding = utf8Encodings.get(call.frame.runtime);
    if (!encoding) {
      encoding = new CsObject(libraryType(call, ENCODING), []);
      utf8Encodings.set(call.frame.runtime, encoding);
    }
    return encoding;
  },
  // A lone surrogate counts as the three bytes of U+FFFD, which both .NET's replacement fallback and the host write.
  [`${ENCODING}.GetByteCount(char[])`]: (_call, _receiver, [chars]) => {
    if (chars === undefined) fail('System.ArgumentNullException', undefined, 'chars');
    const text = String.fromCharCode(...(chars as CsArray).values.map((unit) => unit as number));
    return new TextEncoder().encode(text).length;
  },
  [`${ENCODING}.GetByteCount(string)`]: (_call, _receiver, [text]) => {
    if (text === undefined) fail('System.ArgumentNullException', undefined, 'chars');
    return new TextEncoder().encode(stringText(text as CsString | string)).length;
  },
  [`${ENCODING}.GetBytes(string)`]: (call, _receiver, [text]) => {
    if (text === undefined) fail('System.ArgumentNullException', undefined, 's');
    const bytes = [...new TextEncoder().encode(stringText(text as CsString | string))];
    return newArray(call, libraryType(call, 'System.Byte'), bytes);
  },
  [`${ENCODING}.GetString(byte[])`]: (_call, _receiver, [bytes]) => {
    if (bytes === undefined) fail('System.ArgumentNullException', undefined, 'bytes');
    return freshString(decodeUtf8((bytes as CsArray).values));
  },
  [`${ENCODING}.GetString(ReadOnlySpan<byte>)`]: (_call, _receiver, [span]) =>
    freshString(decodeUtf8(elements(viewOf(span as Value)))),
});

/** The run's one `Encoding.UTF8`, which every read of the property gives. */
const utf8Encodings = new WeakMap<object, CsObject>();
