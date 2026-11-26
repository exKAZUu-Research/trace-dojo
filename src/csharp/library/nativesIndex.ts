import { defineNatives, type NativeCall } from '../natives';
import { type CsArray, CsBox, CsStruct, type Value } from '../values';
import { failOutOfRange, libraryType, newArray } from './support';

/** An Index keeps its value as .NET does: the value itself from the start, its complement from the end. */
function indexOf(call: NativeCall, value: number): CsStruct {
  return new CsStruct(libraryType(call, 'System.Index'), [value]);
}

function encodedIndex(value: Value): number {
  return ((value instanceof CsBox ? value.value : value) as CsStruct).fields[0] as number;
}

function newIndex(call: NativeCall, value: number, fromEnd: boolean): CsStruct {
  if (value < 0) failOutOfRange(call, 'value', 'Non-negative number required.');
  return indexOf(call, fromEnd ? ~value : value);
}

function indexValue(encoded: number): number {
  return encoded < 0 ? ~encoded : encoded;
}

function indexOffset(encoded: number, length: number): number {
  return encoded < 0 ? length + encoded + 1 : encoded;
}

function indexText(encoded: number): string {
  return encoded < 0 ? `^${~encoded}` : String(encoded);
}

function rangeOf(call: NativeCall, start: Value, end: Value): CsStruct {
  return new CsStruct(libraryType(call, 'System.Range'), [start, end]);
}

function rangeParts(value: Value): [number, number] {
  const fields = ((value instanceof CsBox ? value.value : value) as CsStruct).fields;
  return [encodedIndex(fields[0]), encodedIndex(fields[1])];
}

/** `Range.GetOffsetAndLength`, which rejects a range outside the length as .NET does. */
function offsetAndLength(call: NativeCall, range: Value, length: number): [number, number] {
  const [start, end] = rangeParts(range);
  const offset = indexOffset(start, length);
  const stop = indexOffset(end, length);
  if (stop > length || offset > stop)
    failOutOfRange(call, 'length', 'Specified argument was out of the range of valid values.');
  return [offset, stop - offset];
}

defineNatives({
  'System.Index..ctor': (call, receiver, [value, fromEnd]) => {
    const index = newIndex(call, value as number, fromEnd as boolean);
    (receiver as CsStruct).fields[0] = index.fields[0];
  },
  'System.Index.get_Start': (call) => indexOf(call, 0),
  'System.Index.get_End': (call) => indexOf(call, ~0),
  'System.Index.FromStart': (call, _receiver, [value]) => newIndex(call, value as number, false),
  'System.Index.FromEnd': (call, _receiver, [value]) => newIndex(call, value as number, true),
  'System.Index.get_Value': (_call, receiver) => indexValue(encodedIndex(receiver)),
  'System.Index.get_IsFromEnd': (_call, receiver) => encodedIndex(receiver) < 0,
  'System.Index.GetOffset': (_call, receiver, [length]) => indexOffset(encodedIndex(receiver), length as number),
  'System.Index.Equals(object?)': (_call, receiver, [other]) => {
    const value = other instanceof CsBox ? other.value : other;
    return (
      value instanceof CsStruct &&
      value.type.symbol.fullName === 'System.Index' &&
      encodedIndex(value) === encodedIndex(receiver)
    );
  },
  'System.Index.Equals(Index)': (_call, receiver, [other]) => encodedIndex(other as Value) === encodedIndex(receiver),
  'System.Index.GetHashCode': (_call, receiver) => encodedIndex(receiver),
  'System.Index.op_Implicit': (call, _receiver, [value]) => newIndex(call, value as number, false),
  'System.Index.ToString': (_call, receiver) => indexText(encodedIndex(receiver)),
  'System.Range..ctor': (_call, receiver, [start, end]) => {
    (receiver as CsStruct).fields[0] = start as Value;
    (receiver as CsStruct).fields[1] = end as Value;
  },
  'System.Range.get_Start': (_call, receiver) => ((receiver as CsStruct).fields[0] as CsStruct).clone(),
  'System.Range.get_End': (_call, receiver) => ((receiver as CsStruct).fields[1] as CsStruct).clone(),
  'System.Range.get_All': (call) => rangeOf(call, indexOf(call, 0), indexOf(call, ~0)),
  'System.Range.StartAt': (call, _receiver, [start]) => rangeOf(call, start as Value, indexOf(call, ~0)),
  'System.Range.EndAt': (call, _receiver, [end]) => rangeOf(call, indexOf(call, 0), end as Value),
  'System.Range.GetOffsetAndLength': (call, receiver, [length]) => {
    const [offset, count] = offsetAndLength(call, receiver, length as number);
    const int = libraryType(call, 'System.Int32');
    return new CsStruct(libraryType(call, 'System.ValueTuple', [int, int]), [offset, count]);
  },
  'System.Range.Equals(object?)': (_call, receiver, [other]) => {
    const value = other instanceof CsBox ? other.value : other;
    if (!(value instanceof CsStruct) || value.type.symbol.fullName !== 'System.Range') return false;
    const [a, b] = rangeParts(receiver);
    const [c, d] = rangeParts(value);
    return a === c && b === d;
  },
  'System.Range.Equals(Range)': (_call, receiver, [other]) => {
    const [a, b] = rangeParts(receiver);
    const [c, d] = rangeParts(other as Value);
    return a === c && b === d;
  },
  'System.Range.GetHashCode': (_call, receiver) => {
    const [a, b] = rangeParts(receiver);
    return Math.imul(a, 31) + b;
  },
  'System.Range.ToString': (_call, receiver) => {
    const [start, end] = rangeParts(receiver);
    return `${indexText(start)}..${indexText(end)}`;
  },
  'System.Runtime.CompilerServices.RuntimeHelpers.GetSubArray': (call, _receiver, [array, range]) => {
    const source = array as CsArray;
    const [offset, length] = offsetAndLength(call, range as Value, source.values.length);
    return newArray(call, call.typeArgs[0], source.values.slice(offset, offset + length));
  },
});
