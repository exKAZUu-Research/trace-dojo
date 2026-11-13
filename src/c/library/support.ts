import type { RecordValue, Scalar, Value } from '../arith';
import { CRuntimeError } from '../errors';
import { type PointerRanges, replacePointerRanges, slicePointerRanges } from '../pointerBounds';
import type { Runtime } from '../runtime';
import { type CType, INT_PROPERTIES } from '../types';

/** Reads the bytes of a null-terminated string, without its terminator. */
export function readCString(runtime: Runtime, address: number, limit = Number.POSITIVE_INFINITY): Uint8Array {
  if (address === 0) throw new CRuntimeError('nullArgument');
  const block = runtime.memory.locate(address, Math.min(1, limit));
  const start = address - block.base;
  let end = start;
  while (end - start < limit) {
    if (end >= block.size) throw new CRuntimeError('unterminatedString');
    if (block.initialized[end] !== 255) throw new CRuntimeError('uninitialized');
    if (block.bytes[end] === 0) break;
    end++;
  }
  runtime.spend(Math.ceil((end - start) / 64));
  return block.bytes.slice(start, end);
}

/** Reads `size` bytes, which must all hold values. */
export function readBytes(runtime: Runtime, address: number, size: number): Uint8Array {
  if (size === 0) return new Uint8Array();
  if (address === 0) throw new CRuntimeError('nullArgument');
  const block = runtime.memory.locate(address, size);
  const offset = address - block.base;
  for (let index = offset; index < offset + size; index++) {
    if (block.initialized[index] !== 255) throw new CRuntimeError('uninitialized');
  }
  runtime.spend(Math.ceil(size / 64));
  return block.bytes.slice(offset, offset + size);
}

/** Reads bytes and which of them hold values, for functions that copy memory as it is. */
export function readRaw(runtime: Runtime, address: number, size: number): RecordValue {
  if (size === 0) return { bytes: new Uint8Array(), initialized: new Uint8Array() };
  if (address === 0) throw new CRuntimeError('nullArgument');
  const block = runtime.memory.locate(address, size);
  const offset = address - block.base;
  runtime.spend(Math.ceil(size / 64));
  return {
    pointerRanges: slicePointerRanges(block.pointerRanges, offset, size),
    bytes: block.bytes.slice(offset, offset + size),
    initialized: block.initialized.slice(offset, offset + size),
  };
}

export function writeBytes(
  runtime: Runtime,
  address: number,
  bytes: Uint8Array,
  initialized?: Uint8Array,
  pointerRanges?: PointerRanges
): void {
  if (bytes.length === 0) return;
  if (address === 0) throw new CRuntimeError('nullArgument');
  const block = runtime.memory.locate(address, bytes.length);
  if (block.isReadOnly) throw new CRuntimeError('readOnly');
  const offset = address - block.base;
  replacePointerRanges(block.pointerRanges, offset, bytes.length, pointerRanges);
  block.bytes.set(bytes, offset);
  if (initialized) block.initialized.set(initialized, offset);
  else block.initialized.fill(255, offset, offset + bytes.length);
  runtime.spend(Math.ceil(bytes.length / 64));
}

export function asNumber(value: Value | undefined): number {
  return Number(value as Scalar);
}

export function asAddress(value: Value | undefined): number {
  return value as number;
}

/** A size argument (`size_t`), as a number. */
export function asSize(value: Value | undefined): number {
  const size = Number(value as bigint);
  return size;
}

export function cString(text: string): Uint8Array {
  return Uint8Array.from([...new TextEncoder().encode(text), 0]);
}

export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function latin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
}

export function isWideType(type: CType): boolean {
  return type.kind === 'int' && INT_PROPERTIES[type.name].size === 8;
}

/** Writes the output of a C stream, decoding its bytes as UTF-8 as a terminal does. */
export class ByteStream {
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly write: (text: string) => void) {}

  bytes(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true });
    if (text) this.write(text);
  }

  flush(): void {
    const text = this.decoder.decode();
    if (text) this.write(text);
  }
}

/** Whether ASCII text appears in bytes at a position. */
export function startsWithAt(bytes: Uint8Array, index: number, text: string): boolean {
  for (let offset = 0; offset < text.length; offset++) {
    if (bytes[index + offset] !== text.codePointAt(offset)) return false;
  }
  return true;
}
