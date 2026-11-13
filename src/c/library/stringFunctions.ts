import { CRuntimeError } from '../errors';
import type { SpecialCall } from '../expressionCompiler';
import type { NativeFunction, Runtime } from '../runtime';
import { INT } from '../types';
import { asAddress, asNumber, asSize, cString, readBytes, readCString, readRaw, writeBytes } from './support';

function checkOverlap(destination: number, source: number, size: number, sourceSize = size): void {
  if (size > 0 && sourceSize > 0 && destination < source + sourceSize && source < destination + size)
    throw new CRuntimeError('overlappingCopy');
}

function compareBytes(a: Uint8Array, b: Uint8Array, length: number): number {
  for (let index = 0; index < length; index++) {
    const x = index < a.length ? a[index] : 0;
    const y = index < b.length ? b[index] : 0;
    if (x !== y) return x - y;
    if (x === 0) return 0;
  }
  return 0;
}

/** macOS's messages for the error numbers that programs commonly see. */
const ERROR_MESSAGES: Record<number, string> = {
  0: 'Undefined error: 0',
  1: 'Operation not permitted',
  2: 'No such file or directory',
  4: 'Interrupted system call',
  5: 'Input/output error',
  12: 'Cannot allocate memory',
  13: 'Permission denied',
  17: 'File exists',
  22: 'Invalid argument',
  28: 'No space left on device',
  33: 'Numerical argument out of domain',
  34: 'Result too large',
  92: 'Illegal byte sequence',
};

export function errorMessage(error: number): string {
  return ERROR_MESSAGES[error] ?? `Unknown error: ${error}`;
}

function duplicate(runtime: Runtime, bytes: Uint8Array): number {
  const size = bytes.length + 1;
  if (!runtime.reserve(size)) return 0;
  const block = runtime.memory.allocate(size, 'heap');
  block.bytes.set(bytes);
  block.initialized.fill(255);
  return block.base;
}

/** Finds the first byte of `bytes` in a set, or the length when there is none. */
function span(bytes: Uint8Array, set: Uint8Array, inSet: boolean): number {
  const members = new Set(set);
  let index = 0;
  while (index < bytes.length && members.has(bytes[index]) === inSet) index++;
  return index;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Constant-folding eligibility and safe comparison bounds must agree before bypassing the runtime call.
export const comparisonCall: SpecialCall = (compiler, call, fn) => {
  const count = fn.name === 'strcmp' ? 2 : 3;
  if (call.args.length !== count) return;
  const operands = call.args.map((argument) => compiler.rvalue(argument));
  const [a, b] = operands.map((operand) => operand.constantBytes);
  if (!a || !b) return;
  const n = count === 2 ? Math.max(a.length, b.length) : operands[2].constant;
  if (n === undefined || Number(n) < 0) return;
  const length = Number(n);
  if (fn.name === 'memcmp' && (length > a.length || length > b.length)) return;
  if (fn.name !== 'memcmp' && (!a.includes(0) || !b.includes(0))) return;
  let result = 0;
  for (let index = 0; index < length; index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) {
      result = Math.sign(x - y);
      break;
    }
    if (fn.name !== 'memcmp' && x === 0) break;
  }
  return { type: INT, value: () => result, constant: result, isCall: true };
};

export const STRING_FUNCTIONS: Record<string, NativeFunction> = {
  strlen: (runtime, [s]) => BigInt(readCString(runtime, asAddress(s)).length),
  strcpy: (runtime, [destination, source]) => {
    const bytes = readCString(runtime, asAddress(source));
    checkOverlap(asAddress(destination), asAddress(source), bytes.length + 1);
    writeBytes(runtime, asAddress(destination), Uint8Array.from([...bytes, 0]));
    return destination;
  },
  strncpy: (runtime, [destination, source, count]) => {
    const n = asSize(count);
    const bytes = readCString(runtime, asAddress(source), n);
    checkOverlap(asAddress(destination), asAddress(source), n, Math.min(bytes.length + 1, n));
    const result = new Uint8Array(n);
    result.set(bytes);
    writeBytes(runtime, asAddress(destination), result);
    return destination;
  },
  strcat: (runtime, [destination, source]) => {
    const existing = readCString(runtime, asAddress(destination));
    const bytes = readCString(runtime, asAddress(source));
    checkOverlap(asAddress(destination), asAddress(source), existing.length + bytes.length + 1, bytes.length + 1);
    writeBytes(runtime, asAddress(destination) + existing.length, Uint8Array.from([...bytes, 0]));
    return destination;
  },
  strncat: (runtime, [destination, source, count]) => {
    const existing = readCString(runtime, asAddress(destination));
    const bytes = readCString(runtime, asAddress(source), asSize(count));
    checkOverlap(asAddress(destination), asAddress(source), existing.length + bytes.length + 1, bytes.length + 1);
    writeBytes(runtime, asAddress(destination) + existing.length, Uint8Array.from([...bytes, 0]));
    return destination;
  },
  strcmp: (runtime, [a, b]) => {
    const x = readCString(runtime, asAddress(a));
    const y = readCString(runtime, asAddress(b));
    return compareBytes(x, y, Math.max(x.length, y.length) + 1);
  },
  strcoll: (runtime, [a, b]) => {
    const x = readCString(runtime, asAddress(a));
    const y = readCString(runtime, asAddress(b));
    return compareBytes(x, y, Math.max(x.length, y.length) + 1);
  },
  strncmp: (runtime, [a, b, count]) => {
    const n = asSize(count);
    const x = readCString(runtime, asAddress(a), n);
    const y = readCString(runtime, asAddress(b), n);
    return compareBytes(x, y, Math.min(n, Math.max(x.length, y.length) + 1));
  },
  strchr: (runtime, [s, c]) => {
    const bytes = readCString(runtime, asAddress(s));
    const target = asNumber(c) & 0xff;
    if (target === 0) return asAddress(s) + bytes.length;
    const index = bytes.indexOf(target);
    return index === -1 ? 0 : asAddress(s) + index;
  },
  strrchr: (runtime, [s, c]) => {
    const bytes = readCString(runtime, asAddress(s));
    const target = asNumber(c) & 0xff;
    if (target === 0) return asAddress(s) + bytes.length;
    const index = bytes.lastIndexOf(target);
    return index === -1 ? 0 : asAddress(s) + index;
  },
  strstr: (runtime, [haystack, needle]) => {
    const text = readCString(runtime, asAddress(haystack));
    const pattern = readCString(runtime, asAddress(needle));
    for (let index = 0; index + pattern.length <= text.length; index++) {
      if (pattern.every((byte, offset) => text[index + offset] === byte)) return asAddress(haystack) + index;
    }
    return 0;
  },
  strtok: (runtime, [s, separators]) => {
    let address = asAddress(s);
    if (address === 0) address = runtime.tokenizerPosition;
    if (address === 0) return 0;
    const separatorBytes = readCString(runtime, asAddress(separators));
    const bytes = readCString(runtime, address);
    const start = span(bytes, separatorBytes, true);
    if (start === bytes.length) {
      runtime.tokenizerPosition = 0;
      return 0;
    }
    const length = span(bytes.subarray(start), separatorBytes, false);
    const end = start + length;
    if (end < bytes.length) {
      writeBytes(runtime, address + end, Uint8Array.of(0));
      runtime.tokenizerPosition = address + end + 1;
    } else {
      runtime.tokenizerPosition = 0;
    }
    return address + start;
  },
  strspn: (runtime, [s, accept]) =>
    BigInt(span(readCString(runtime, asAddress(s)), readCString(runtime, asAddress(accept)), true)),
  strcspn: (runtime, [s, reject]) =>
    BigInt(span(readCString(runtime, asAddress(s)), readCString(runtime, asAddress(reject)), false)),
  strpbrk: (runtime, [s, accept]) => {
    const bytes = readCString(runtime, asAddress(s));
    const index = span(bytes, readCString(runtime, asAddress(accept)), false);
    return index === bytes.length ? 0 : asAddress(s) + index;
  },
  strdup: (runtime, [s]) => duplicate(runtime, readCString(runtime, asAddress(s))),
  strndup: (runtime, [s, count]) => duplicate(runtime, readCString(runtime, asAddress(s), asSize(count))),
  strerror: (runtime, [error]) => runtime.stringLiteral(cString(errorMessage(asNumber(error)))).base,
  strxfrm: (runtime, [destination, source, count]) => {
    const bytes = readCString(runtime, asAddress(source));
    const n = asSize(count);
    if (bytes.length < n) writeBytes(runtime, asAddress(destination), Uint8Array.from([...bytes, 0]));
    return BigInt(bytes.length);
  },
  memcpy: (runtime, [destination, source, count]) => {
    const n = asSize(count);
    checkOverlap(asAddress(destination), asAddress(source), n);
    const { bytes, initialized } = readRaw(runtime, asAddress(source), n);
    writeBytes(runtime, asAddress(destination), bytes, initialized);
    return destination;
  },
  memmove: (runtime, [destination, source, count]) => {
    const { bytes, initialized } = readRaw(runtime, asAddress(source), asSize(count));
    writeBytes(runtime, asAddress(destination), bytes, initialized);
    return destination;
  },
  memset: (runtime, [s, c, count]) => {
    writeBytes(runtime, asAddress(s), new Uint8Array(asSize(count)).fill(asNumber(c) & 0xff));
    return s;
  },
  memcmp: (runtime, [a, b, count]) => {
    const n = asSize(count);
    const x = readBytes(runtime, asAddress(a), n);
    const y = readBytes(runtime, asAddress(b), n);
    for (let index = 0; index < n; index++) if (x[index] !== y[index]) return x[index] - y[index];
    return 0;
  },
  memchr: (runtime, [s, c, count]) => {
    const n = asSize(count);
    const target = asNumber(c) & 0xff;
    const { bytes, initialized } = readRaw(runtime, asAddress(s), n);
    for (let index = 0; index < n; index++) {
      if (initialized[index] !== 255) throw new CRuntimeError('uninitialized');
      if (bytes[index] === target) return asAddress(s) + index;
    }
    return 0;
  },
};
