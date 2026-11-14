import type { Scalar, Value } from '../arith';
import { CRuntimeError, ProgramAbort, ProgramExit } from '../errors';
import type { NativeFunction, Runtime } from '../runtime';
import { type CType, pointerTo, VOID } from '../types';
import { ERROR_NUMBERS } from './appleErrno';
import { isExactFloatPrefix, parseFloatPrefix, parseIntegerPrefix } from './numberParsing';
import { qsort } from './sorting';
import { asAddress, asNumber, asSize, readCString, readRaw, writeBytes } from './support';

export const ERANGE = ERROR_NUMBERS.ERANGE;

const VOID_POINTER = pointerTo(VOID);

function malloc(runtime: Runtime, size: number, alignment = 16): number {
  // macOS returns NULL for a size it cannot allocate, and a unique pointer for size 0.
  if (
    !Number.isSafeInteger(size) ||
    size > 0x7f_ff_ff_ff ||
    !runtime.memory.canAllocateHeap(size, alignment) ||
    !runtime.reserve(size)
  ) {
    runtime.errno = ERROR_NUMBERS.ENOMEM;
    return 0;
  }
  const block = runtime.memory.allocate(size, 'heap', alignment);
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
// code-gauge-allow functionCognitiveComplexity 18 -- Base errors, destination bounds, errno, and end pointers form one conversion result.
function strtoInteger(bits: 32 | 64, signed: boolean, wide: boolean): NativeFunction {
  return (runtime, [text, end, base]) => {
    const bytes = readCString(runtime, asAddress(text));
    const parsed = parseIntegerPrefix(bytes, asNumber(base), undefined, () => runtime.spend());
    if (parsed.length === 0) setErrno(runtime, ERROR_NUMBERS.EINVAL);
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
    if (
      parsed.length > 0 &&
      parsed.isNonzeroText &&
      Math.abs(value) < (isFloat ? 2 ** -126 : 2 ** -1022) &&
      !isExactFloatPrefix(bytes, parsed.length, value)
    )
      setErrno(runtime, ERANGE);
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

function legacyConversion(convert: NativeFunction, narrow = false): NativeFunction {
  return (runtime, [text], types, row) => {
    const value = convert(runtime, [text, 0, 10], types, row);
    return narrow ? Number(BigInt.asIntN(32, value as bigint)) : value;
  };
}

export const STDLIB_FUNCTIONS: Record<string, NativeFunction> = {
  malloc: (runtime, [size]) => malloc(runtime, asSize(size)),
  aligned_alloc: (runtime, [align, size]) => {
    const alignment = asSize(align);
    const length = asSize(size);
    if (alignment < 8 || !Number.isInteger(Math.log2(alignment)) || length % alignment !== 0) {
      runtime.errno = ERROR_NUMBERS.EINVAL;
      return 0;
    }
    return malloc(runtime, length, alignment);
  },
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
      const snapshot = readRaw(runtime, block.base, copied);
      writeBytes(runtime, result, snapshot.bytes, snapshot.initialized, snapshot.pointerBytes);
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
  atoi: legacyConversion(strtoInteger(64, true, true), true),
  atol: legacyConversion(strtoInteger(64, true, true)),
  atof: legacyConversion(strtoFloat(false)),
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
