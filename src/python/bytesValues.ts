import { bytesLiteral } from './bytesLiteral';
import { chargeSlots, currentRuntime } from './runtimeContext';
import {
  bytearrayClass,
  bytesClass,
  classOf,
  exceptionClassNamed,
  memoryviewClass,
  newException,
  pyError,
  typeError,
  typeName,
} from './types';
import { type PyClass, PyError, PyObject, type PyValue } from './values';

/** A `bytes` or `bytearray` object, whose bytes a bytearray may change and resize in place. */
export class PyBytes extends PyObject {
  private buffer: Uint8Array;
  private size: number;
  /** The unreleased memoryviews of this object, which forbid resizing it while the program can reach them. */
  readonly views = new Set<PyMemoryView>();

  constructor(cls: PyClass, data: Uint8Array) {
    super(cls);
    chargeSlots(bytesSlots(data.length));
    this.buffer = data;
    this.size = data.length;
  }

  get data(): Uint8Array {
    return this.buffer.subarray(0, this.size);
  }

  get length(): number {
    return this.size;
  }

  get isMutable(): boolean {
    return this.cls.isSubclassOf(bytearrayClass);
  }

  /** Raises CPython's BufferError while a memoryview the program can reach exports this object's buffer. */
  checkNoExports(): void {
    if (this.hasExports()) {
      throw new PyError(
        newException(exceptionClassNamed('BufferError'), ['Existing exports of data: object cannot be re-sized'])
      );
    }
  }

  /** Whether a memoryview the program can reach exports this object's buffer. */
  hasExports(): boolean {
    if (this.views.size > 0) this.releaseUnreachableViews();
    return this.views.size > 0;
  }

  /** Releases the views the program can no longer reach, which CPython would have freed already. */
  private releaseUnreachableViews(): void {
    const reachable = currentRuntime().reachableObjects();
    for (const view of this.views) if (!reachable.has(view)) view.release();
  }

  /** Replaces the bytes from `start` up to `end` with `insert`, resizing the buffer as needed. */
  splice(start: number, end: number, insert: Uint8Array): void {
    const delta = insert.length - (end - start);
    if (delta !== 0) this.checkNoExports();
    const size = this.size + delta;
    if (size > this.buffer.length) {
      currentRuntime().allocate(bytesSlots(size));
      const grown = new Uint8Array(Math.max(size, this.buffer.length * 2, 16));
      grown.set(this.buffer.subarray(0, this.size));
      this.buffer = grown;
    }
    this.buffer.copyWithin(start + insert.length, end, this.size);
    this.buffer.set(insert, start);
    this.size = size;
  }

  /** Resizes this bytearray in place, checking the allocation budget before growing the underlying buffer. */
  resize(requested: bigint): void {
    if (requested === BigInt(this.size)) return;
    this.checkNoExports();
    if (requested > BigInt(Number.MAX_SAFE_INTEGER)) currentRuntime().ensureRoom(Number.MAX_SAFE_INTEGER);
    const size = Number(requested);
    if (size < this.size) {
      this.size = size;
      return;
    }
    if (size > this.buffer.length) {
      currentRuntime().allocate(bytesSlots(size));
      const grown = new Uint8Array(Math.max(size, this.buffer.length * 2, 16));
      grown.set(this.buffer.subarray(0, this.size));
      this.buffer = grown;
    } else {
      this.buffer.fill(0, this.size, size);
    }
    this.size = size;
  }
}

/** The slots of storage a buffer of `length` bytes is charged, eight bytes to a slot. */
function bytesSlots(length: number): number {
  return Math.ceil(length / 8);
}

/** A `memoryview`: a one-dimensional view of items of `format` over the bytes of a bytes or bytearray object. */
export class PyMemoryView extends PyObject {
  released = false;
  /** The dimensions of a view that cast() gave more than one, or undefined for a one-dimensional view. */
  shape?: number[];
  /**
   * The distance in bytes between the rows of a multi-dimensional view a slice with a step took, whose rows are then
   * apart; undefined when its rows follow one another, as the items within a row always do.
   */
  rowStride?: number;
  /** The object that exported the memory, as `array.array`, which `obj` shows; undefined for the source itself. */
  exporter?: PyValue;

  // code-gauge-allow functionParameterCount 7 -- Each view field is set once at creation, as CPython's buffer struct.
  constructor(
    readonly source: PyBytes,
    readonly offset: number,
    readonly count: number,
    /** The distance in bytes between consecutive items. */
    readonly stride: number,
    readonly format: string,
    readonly itemsize: number,
    readonly readonly: boolean
  ) {
    super(memoryviewClass);
    source.views.add(this);
  }

  get nbytes(): number {
    return this.count * this.itemsize;
  }

  /** The position in the source of the item at `index`, counting the items of all rows in order. */
  itemOffset(index: number): number {
    if (this.rowStride === undefined || !this.shape) return this.offset + index * this.stride;
    const rowItems = this.shape.slice(1).reduce((product, size) => product * size, 1);
    return this.offset + Math.floor(index / rowItems) * this.rowStride + (index % rowItems) * this.itemsize;
  }

  /** The bytes of the item at `index`, a view into the source. */
  itemBytes(index: number): Uint8Array {
    const start = this.itemOffset(index);
    return this.source.data.subarray(start, start + this.itemsize);
  }

  /** A copy of the viewed bytes, in item order. */
  toBytes(): Uint8Array {
    this.checkReleased();
    if (this.stride === this.itemsize && this.rowStride === undefined)
      return this.source.data.slice(this.offset, this.offset + this.nbytes);
    const result = new Uint8Array(this.nbytes);
    for (let index = 0; index < this.count; index++) result.set(this.itemBytes(index), index * this.itemsize);
    return result;
  }

  checkReleased(): void {
    if (this.released) throw valueErrorReleased();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.source.views.delete(this);
  }
}

function valueErrorReleased(): Error {
  return pyError('ValueError', 'operation forbidden on released memoryview object');
}

export function newBytes(data: Uint8Array): PyBytes {
  return new PyBytes(bytesClass, data);
}

export function newByteArray(data: Uint8Array): PyBytes {
  return new PyBytes(bytearrayClass, data);
}

/** A new bytes or bytearray object of the same class as `self`, as the methods of both return. */
export function sameKind(self: PyBytes, data: Uint8Array): PyBytes {
  return new PyBytes(self.isMutable ? bytearrayClass : bytesClass, data);
}

/** The bytes of a bytes-like object (bytes, bytearray, or memoryview), or undefined for any other value. */
export function bytesLikeData(value: PyValue): Uint8Array | undefined {
  if (value instanceof PyBytes) return value.data;
  if (value instanceof PyMemoryView) return value.toBytes();
  // A Python class implements the buffer protocol with `__buffer__` (PEP 688), as `array.array` does.
  if (value instanceof PyObject && !value.cls.isBuiltin && value.cls.lookup('__buffer__') !== undefined) {
    const view = currentRuntime().bufferView(value);
    try {
      return view.toBytes();
    } finally {
      view.release();
    }
  }
  return undefined;
}

/** The bytes of a bytes-like argument, raising CPython's TypeError for any other value. */
export function requireBytesLike(value: PyValue, message = 'a bytes-like object is required, not'): Uint8Array {
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`${message} '${typeName(value)}'`);
  return data;
}

export function isBytesLike(value: PyValue): boolean {
  return value instanceof PyBytes || value instanceof PyMemoryView;
}

/** The bytes of a string whose characters are all below U+0100, one byte per character. */
export function latin1Bytes(text: string): Uint8Array {
  const data = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) data[index] = text.codePointAt(index) as number;
  return data;
}

/** The string with one character per byte, which lets JavaScript's string search work on bytes. */
export function latin1Text(data: Uint8Array): string {
  let text = '';
  for (let start = 0; start < data.length; start += 8192) {
    text += String.fromCodePoint(...data.subarray(start, start + 8192));
  }
  return text;
}

export function bytesRepr(value: PyBytes): string {
  currentRuntime().scan(value.length);
  return bytesText(value);
}

/** The repr of a bytes or bytearray object, without charging the runtime, as the trace shows it. */
export function bytesText(value: PyBytes): string {
  if (!value.isMutable) return `b${bytesLiteral(value.data)}`;
  // CPython's bytearray repr picks the quotes as bytes does but always escapes single quotes.
  return `${classOf(value).name}(b${bytesLiteral(value.data, true)})`;
}

export { bytearrayClass, bytesClass, memoryviewClass };
