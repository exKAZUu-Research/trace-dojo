// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { utf8Encode } from '../literals';
import { callDynamic } from '../methods';
import { currentRuntime } from '../native';
import { GoPanic } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { appendValues } from '../sliceOps';
import { ANY, BASIC, ERROR_TYPE, sliceOf, type Type } from '../types';
import { copyValue, GoFunc, type GoStruct, Iface, Pointer, Slice, type Value } from '../values';

export const INT = BASIC.int;
export const STRING = BASIC.string;
export const BOOL = BASIC.bool;
export const FLOAT64 = BASIC.float64;
export const BYTES = sliceOf(BASIC.uint8);
export const ANY_SLICE = sliceOf(ANY);
export { ANY, ERROR_TYPE };

/** Writes UTF-8 bytes to standard output. */
export function writeStdout(bytes: string): void {
  currentRuntime().writeStdout(bytes);
}

/** Writes UTF-8 bytes to standard error. */
export function writeStderr(bytes: string): void {
  currentRuntime().writeStderr(bytes);
}

/** Panics with a plain `string` value, as Go's library `panic("...")` calls do. */
export function stringPanic(message: string): never {
  throw new GoPanic(new Iface(BASIC.string, message));
}

/** Loads the struct behind a pointer receiver, raising Go's nil-pointer panic when the receiver is nil. */
export function receiverStruct(receiver: Value): GoStruct {
  if (!(receiver instanceof Pointer)) nilPointerPanic();
  return receiver.load() as GoStruct;
}

/** Spends operations in proportion to the work a library call does on `size` items. */
export function spendFor(size: number): void {
  currentRuntime().spend(1 + Math.floor(size / 16));
}

export function sliceValues(value: Value): Value[] {
  return (value as Slice | undefined)?.values() ?? [];
}

export function sliceOfValues(values: Value[]): Slice {
  currentRuntime().allocate(values.length);
  return new Slice(values, 0, values.length, values.length);
}

export function bytesOf(value: Value): string {
  return sliceValues(value)
    .map((byte) => String.fromCharCode(Number(byte as bigint)))
    .join('');
}

export function byteSlice(bytes: string): Slice {
  return sliceOfValues(Array.from(bytes, (char) => BigInt(char.charCodeAt(0))));
}

/** `append(slice, bytes...)` for a []byte, which writes into spare capacity and grows as Go's append does. */
export function appendBytes(slice: Value, bytes: string): Slice | undefined {
  const runtime = currentRuntime();
  spendFor(bytes.length);
  return appendValues(
    slice as Slice | undefined,
    Array.from(bytes, (char) => BigInt(char.charCodeAt(0))),
    BASIC.uint8,
    () => 0n,
    (count) => runtime.allocate(count)
  );
}

/** Calls a function value from the library, as `sort.Slice` calls its less function. */
export function callFunction(fn: Value, args: Value[]): Value | Value[] {
  if (!(fn instanceof GoFunc)) nilPointerPanic();
  return fn.call(args.map(copyValue));
}

/** Calls a method of an interface value, as `sort.Sort` calls `Less`. */
export function callMethod(receiver: Value, name: string, args: Value[] = []): Value | Value[] {
  return callDynamic(receiver as Iface, name, args.map(copyValue));
}

/** The text of an error value, for messages that quote it. */
export function errorText(error: Value): string {
  return callMethod(error, 'Error') as string;
}

export function goString(text: string): string {
  return utf8Encode(text);
}

export function boxed(type: Type, value: Value): Iface {
  return new Iface(type, copyValue(value));
}
