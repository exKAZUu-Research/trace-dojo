import type { Scalar, Value } from '../arith';
import { CRuntimeError, ProgramAbort, ProgramExit } from '../errors';
import type { NativeFunction, Runtime } from '../runtime';
import { type CType, pointerTo, VOID } from '../types';
import { parseFloatPrefix, parseIntegerPrefix } from './numberParsing';
import { asAddress, asNumber, asSize, readCString, readRaw, writeBytes } from './support';

export const ERANGE = 34;

const VOID_POINTER = pointerTo(VOID);

function malloc(runtime: Runtime, size: number): number {
  // macOS returns NULL for a size it cannot allocate, and a unique pointer for size 0.
  if (!Number.isSafeInteger(size) || size > 0x7f_ff_ff_ff || !runtime.reserve(size)) return 0;
  const block = runtime.memory.allocate(size, 'heap');
  return block.base;
}

export function free(runtime: Runtime, address: number): void {
  if (address === 0) return;
  const block = runtime.memory.findBase(address);
  if (!block || !block.isHeap) {
    if (runtime.memory.wasFreed(address)) throw new CRuntimeError('doubleFree');
    throw new CRuntimeError('invalidFree');
  }
  if (block.turtle) runtime.world.remove(block.turtle);
  runtime.memory.release(block);
}

/** A struct of two members of `size` bytes each, as `div` and `ldiv` return. */
function quotientRemainder(quotient: bigint, remainder: bigint, size: 4 | 8): Value {
  const bytes = new Uint8Array(size * 2);
  const view = new DataView(bytes.buffer);
  if (size === 4) {
    view.setInt32(0, Number(quotient), true);
    view.setInt32(4, Number(remainder), true);
  } else {
    view.setBigInt64(0, quotient, true);
    view.setBigInt64(8, remainder, true);
  }
  return { bytes, initialized: new Uint8Array(size * 2).fill(255) };
}

function divide(x: bigint, y: bigint, bits: 32 | 64): { quotient: bigint; remainder: bigint } {
  if (y === 0n) throw new CRuntimeError('divisionByZero');
  const min = -(1n << BigInt(bits - 1));
  if (x === min && y === -1n)
    throw new CRuntimeError('custom', '割り算の結果が、整数の型の範囲を超えました（オーバーフロー）。');
  return { quotient: x / y, remainder: x % y };
}

function absolute(bits: 32 | 64): NativeFunction {
  return (_runtime, [value]) => {
    const number = BigInt(value as Scalar);
    if (number === -(1n << BigInt(bits - 1)))
      throw new CRuntimeError('custom', 'abs の結果が、整数の型の範囲を超えました（オーバーフロー）。');
    const result = number < 0n ? -number : number;
    return bits === 32 ? Number(result) : result;
  };
}

/** `strtol` and its relatives: the integer at the start of a string, clamped to the type with `errno` set. */
function strtoInteger(bits: 32 | 64, signed: boolean, wide: boolean): NativeFunction {
  return (runtime, [text, end, base]) => {
    const bytes = readCString(runtime, asAddress(text));
    const parsed = parseIntegerPrefix(bytes, asNumber(base));
    let value = parsed.value;
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
    if (signed) {
      if (value > max) {
        value = max;
        setErrno(runtime, ERANGE);
      } else if (value < min) {
        value = min;
        setErrno(runtime, ERANGE);
      }
    } else if (parsed.magnitude > max) {
      value = max;
      setErrno(runtime, ERANGE);
    } else {
      // strtoul negates the converted magnitude in the unsigned type.
      value = BigInt.asUintN(bits, value);
    }
    if (asAddress(end) !== 0) storePointer(runtime, asAddress(end), asAddress(text) + parsed.length);
    return wide ? value : Number(value);
  };
}

function strtoFloat(isFloat: boolean): NativeFunction {
  return (runtime, [text, end]) => {
    const bytes = readCString(runtime, asAddress(text));
    const parsed = parseFloatPrefix(bytes);
    let value = parsed.value;
    if (isFloat) value = Math.fround(value);
    if (parsed.length > 0 && Number.isFinite(value) === false && !parsed.isInfinityText && !Number.isNaN(value)) {
      setErrno(runtime, ERANGE);
    }
    if (parsed.length > 0 && value === 0 && parsed.isNonzeroText) setErrno(runtime, ERANGE);
    if (asAddress(end) !== 0) storePointer(runtime, asAddress(end), asAddress(text) + parsed.length);
    return value;
  };
}

function storePointer(runtime: Runtime, address: number, value: number): void {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, value % 2 ** 32, true);
  view.setUint32(4, Math.floor(value / 2 ** 32), true);
  writeBytes(runtime, address, bytes);
}

export function setErrno(runtime: Runtime, value: number): void {
  runtime.errno = value;
}

/** Calls a comparison function the program passed, as `qsort` and `bsearch` do. */
function comparator(runtime: Runtime, address: number, row: number): (a: number, b: number) => number {
  const fn = runtime.functions.get(address);
  if (!fn) throw new CRuntimeError(address === 0 ? 'nullAccess' : 'badFunctionPointer');
  return (a, b) => Number(runtime.call(fn, [a, b], [VOID_POINTER, VOID_POINTER], row) as Scalar);
}

/** macOS's qsort: Bentley and McIlroy's, as FreeBSD's libc implements it, so that equal elements end up alike. */
function qsort(
  runtime: Runtime,
  base: number,
  count: number,
  size: number,
  compare: (a: number, b: number) => number
): void {
  new QuickSort(runtime, size, compare).sort(base, count);
}

class QuickSort {
  constructor(
    private readonly runtime: Runtime,
    private readonly size: number,
    private readonly compare: (a: number, b: number) => number
  ) {}

  sort(start: number, n: number): void {
    const { size } = this;
    let a = start;
    let length = n;
    for (;;) {
      this.runtime.spend();
      if (length < 7) {
        this.insertionSort(a, length);
        return;
      }
      this.swap(a, this.pivot(a, length));
      const { pa, pb, pc, pd, swapped } = this.partition(a, length);
      if (!swapped) {
        this.insertionSort(a, length);
        return;
      }
      const pn = a + length * size;
      let r = Math.min(pa - a, pb - pa);
      this.vectorSwap(a, pb - r, r);
      r = Math.min(pd - pc, pn - pd - size);
      this.vectorSwap(pb, pn - r, r);
      if ((r = pb - pa) > size) this.sort(a, r / size);
      if ((r = pd - pc) <= size) return;
      a = pn - r;
      length = r / size;
    }
  }

  private pivot(a: number, length: number): number {
    const { size } = this;
    let pm = a + Math.floor(length / 2) * size;
    if (length > 7) {
      let pl = a;
      let pn = a + (length - 1) * size;
      if (length > 40) {
        const d = Math.floor(length / 8) * size;
        pl = this.med3(pl, pl + d, pl + 2 * d);
        pm = this.med3(pm - d, pm, pm + d);
        pn = this.med3(pn - 2 * d, pn - d, pn);
      }
      pm = this.med3(pl, pm, pn);
    }
    return pm;
  }

  private partition(a: number, length: number): { pa: number; pb: number; pc: number; pd: number; swapped: boolean } {
    const { size } = this;
    let swapped = false;
    let pa = a + size;
    let pb = pa;
    let pc = a + (length - 1) * size;
    let pd = pc;
    for (;;) {
      let result: number;
      while (pb <= pc && (result = this.compare(pb, a)) <= 0) {
        if (result === 0) {
          swapped = true;
          this.swap(pa, pb);
          pa += size;
        }
        pb += size;
      }
      while (pb <= pc && (result = this.compare(pc, a)) >= 0) {
        if (result === 0) {
          swapped = true;
          this.swap(pc, pd);
          pd -= size;
        }
        pc -= size;
      }
      if (pb > pc) return { pa, pb, pc, pd, swapped };
      this.swap(pb, pc);
      swapped = true;
      pb += size;
      pc -= size;
    }
  }

  private med3(a: number, b: number, c: number): number {
    if (this.compare(a, b) < 0) {
      if (this.compare(b, c) < 0) return b;
      return this.compare(a, c) < 0 ? c : a;
    }
    if (this.compare(b, c) > 0) return b;
    return this.compare(a, c) < 0 ? a : c;
  }

  private insertionSort(start: number, n: number): void {
    const { size } = this;
    for (let pm = start + size; pm < start + n * size; pm += size) {
      for (let pl = pm; pl > start && this.compare(pl - size, pl) > 0; pl -= size) this.swap(pl, pl - size);
    }
  }

  private vectorSwap(a: number, b: number, length: number): void {
    for (let offset = 0; offset < length; offset += this.size) this.swap(a + offset, b + offset);
  }

  private swap(a: number, b: number): void {
    if (a === b) return;
    const first = readRaw(this.runtime, a, this.size);
    const second = readRaw(this.runtime, b, this.size);
    writeBytes(this.runtime, a, second.bytes, second.initialized);
    writeBytes(this.runtime, b, first.bytes, first.initialized);
  }
}

function bsearch(
  key: number,
  base: number,
  count: number,
  size: number,
  compare: (a: number, b: number) => number
): number {
  let start = base;
  for (let limit = count; limit !== 0; limit >>= 1) {
    const p = start + (limit >> 1) * size;
    const result = compare(key, p);
    if (result === 0) return p;
    if (result > 0) {
      start = p + size;
      limit--;
    }
  }
  return 0;
}

/** Ends the program as `exit` does, running the functions `atexit` registered, the last first. */
export function exitProgram(runtime: Runtime, status: number, row: number): never {
  while (runtime.exitHandlers.length > 0) {
    const address = runtime.exitHandlers.pop() as number;
    const fn = runtime.functions.get(address);
    if (fn) runtime.call(fn, [], [], row);
  }
  throw new ProgramExit(status);
}

export const STDLIB_FUNCTIONS: Record<string, NativeFunction> = {
  malloc: (runtime, [size]) => malloc(runtime, asSize(size)),
  aligned_alloc: (runtime, [, size]) => malloc(runtime, asSize(size)),
  calloc: (runtime, [count, size]) => {
    const total = asSize(count) * asSize(size);
    const address = malloc(runtime, total);
    if (address !== 0) {
      const block = runtime.memory.findBase(address);
      block?.initialized.fill(255);
    }
    return address;
  },
  realloc: (runtime, [pointer, size]) => {
    const address = asAddress(pointer);
    const newSize = asSize(size);
    if (address === 0) return malloc(runtime, newSize);
    const block = runtime.memory.findBase(address);
    if (!block?.isHeap) throw new CRuntimeError(runtime.memory.wasFreed(address) ? 'doubleFree' : 'invalidFree');
    const result = malloc(runtime, newSize);
    if (result === 0) return 0;
    const copied = Math.min(block.size, newSize);
    const target = runtime.memory.findBase(result);
    if (target && copied > 0) {
      target.bytes.set(block.bytes.subarray(0, copied));
      target.initialized.set(block.initialized.subarray(0, copied));
    }
    free(runtime, address);
    return result;
  },
  free: (runtime, [pointer]) => {
    free(runtime, asAddress(pointer));
    return;
  },
  abs: absolute(32),
  labs: absolute(64),
  llabs: absolute(64),
  imaxabs: absolute(64),
  div: (_runtime, [x, y]) => {
    const { quotient, remainder } = divide(BigInt(x as number), BigInt(y as number), 32);
    return quotientRemainder(quotient, remainder, 4);
  },
  ldiv: (_runtime, [x, y]) => {
    const { quotient, remainder } = divide(x as bigint, y as bigint, 64);
    return quotientRemainder(quotient, remainder, 8);
  },
  atoi: (runtime, [text]) =>
    Number(BigInt.asIntN(32, parseIntegerPrefix(readCString(runtime, asAddress(text)), 10).value)),
  atol: (runtime, [text]) => BigInt.asIntN(64, parseIntegerPrefix(readCString(runtime, asAddress(text)), 10).value),
  atof: (runtime, [text]) => parseFloatPrefix(readCString(runtime, asAddress(text))).value,
  strtol: strtoInteger(64, true, true),
  strtoul: strtoInteger(64, false, true),
  strtoll: strtoInteger(64, true, true),
  strtoull: strtoInteger(64, false, true),
  strtoimax: strtoInteger(64, true, true),
  strtoumax: strtoInteger(64, false, true),
  strtod: strtoFloat(false),
  strtold: strtoFloat(false),
  strtof: strtoFloat(true),
  rand: (runtime) => {
    // macOS's rand: the "minimal standard" generator of Park and Miller, computed with Schrage's method.
    let state = runtime.randomState;
    if (state === 0) state = 123_459_876;
    const hi = Math.floor(state / 127_773);
    const lo = state % 127_773;
    let x = 16_807 * lo - 2836 * hi;
    if (x < 0) x += 0x7f_ff_ff_ff;
    runtime.randomState = x;
    return x % 0x80_00_00_00;
  },
  srand: (runtime, [seed]) => {
    runtime.randomState = asNumber(seed);
    return;
  },
  qsort: (runtime, [base, count, size, compare], _types, row) => {
    const n = asSize(count);
    const width = asSize(size);
    if (n <= 1 || width === 0) return;
    qsort(runtime, asAddress(base), n, width, comparator(runtime, asAddress(compare), row));
    return;
  },
  bsearch: (runtime, [key, base, count, size, compare], _types, row) =>
    bsearch(asAddress(key), asAddress(base), asSize(count), asSize(size), comparator(runtime, asAddress(compare), row)),
  exit: (runtime, [status], _types, row) => exitProgram(runtime, asNumber(status), row),
  _Exit: (_runtime, [status]) => {
    throw new ProgramExit(asNumber(status));
  },
  quick_exit: (_runtime, [status]) => {
    throw new ProgramExit(asNumber(status));
  },
  abort: () => {
    throw new ProgramAbort('abort() が呼ばれて、プログラムが止まりました。');
  },
  atexit: (runtime, [fn]) => {
    runtime.exitHandlers.push(asAddress(fn));
    return 0;
  },
};

export type { CType };
