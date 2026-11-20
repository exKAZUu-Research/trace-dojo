import { byteAt } from '../bytes';
import { CppRuntimeError, overflowError } from '../errors';
import type { Frame } from '../runtime';
import {
  CHAR_POINTER,
  type FunctionInfo,
  INT,
  intMax,
  intMin,
  type IntType,
  LONG,
  pointerTo,
  SIZE_T,
  type Type,
  typeName,
  UINT,
  VOID,
} from '../types';
import type { Ptr } from '../values';
import { NULL_PTR } from '../values';
import { formatPrintf, type PrintfArgument } from './formatting';
import type { Library } from './registry';
import {
  asNumber,
  checkByteWrite,
  CONST_CHAR_PTR,
  type CStringReadObserver,
  native,
  readCString,
  rejectOverlappingBytes,
  signedChar,
} from './support';

const CHARACTER_CLASSES: Record<string, (c: number) => boolean> = {
  isalnum: (c) => /[\dA-Za-z]/.test(String.fromCodePoint(c)),
  isalpha: (c) => /[A-Za-z]/.test(String.fromCodePoint(c)),
  isblank: (c) => c === 0x20 || c === 0x09,
  iscntrl: (c) => c < 0x20 || c === 0x7f,
  isdigit: (c) => c >= 0x30 && c <= 0x39,
  isgraph: (c) => c > 0x20 && c < 0x7f,
  islower: (c) => c >= 0x61 && c <= 0x7a,
  isprint: (c) => c >= 0x20 && c < 0x7f,
  ispunct: (c) => c > 0x20 && c < 0x7f && !/[\dA-Za-z]/.test(String.fromCodePoint(c)),
  isspace: (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d),
  isupper: (c) => c >= 0x41 && c <= 0x5a,
  isxdigit: (c) => /[\dA-Fa-f]/.test(String.fromCodePoint(c)),
};

/** Writes bytes into a `char` array, which must have room for them. */
function writeBytes(target: Ptr, bytes: string): void {
  for (let index = 0; index < bytes.length; index++) target.offset(index).write(signedChar(byteAt(bytes, index)));
}

/** The functions of the C library that C++ programs use, in `std` and in the global namespace alike. */
export function cFunctions(library: Library): Map<string, FunctionInfo[]> {
  const functions = new Map<string, FunctionInfo[]>();
  const add = (fn: FunctionInfo): void => {
    functions.set(fn.name, [...(functions.get(fn.name) ?? []), fn]);
  };
  add(
    native(
      'printf',
      [CONST_CHAR_PTR],
      INT,
      ([format, ...args], { frame }) => {
        const text = printf(frame, format as Ptr, args);
        frame.runtime.write('stdout', text);
        return text.length;
      },
      { isVariadic: true }
    )
  );
  const streamType: Type = pointerTo({ kind: 'class', cls: library.fileClass });
  add(
    native(
      'fprintf',
      [streamType, CONST_CHAR_PTR],
      INT,
      ([stream, format, ...args], { frame }) => {
        const text = printf(frame, format as Ptr, args);
        frame.runtime.write(library.fileTarget(stream as Ptr), text);
        return text.length;
      },
      { isVariadic: true }
    )
  );
  add(
    native(
      'sprintf',
      [CHAR_POINTER, CONST_CHAR_PTR],
      INT,
      ([target, format, ...args], { frame }) => printfToBuffer(frame, target as Ptr, format as Ptr, args),
      { isVariadic: true }
    )
  );
  add(
    native(
      'snprintf',
      [CHAR_POINTER, SIZE_T, CONST_CHAR_PTR],
      INT,
      ([target, size, format, ...args], { frame }) =>
        printfToBuffer(frame, target as Ptr, format as Ptr, args, asNumber(size)),
      { isVariadic: true }
    )
  );
  add(
    native('puts', [CONST_CHAR_PTR], INT, ([text], { frame }) => {
      frame.runtime.write('stdout', `${readCString(text as Ptr, frame.runtime)}\n`);
      // macOS returns the newline it wrote.
      return 10;
    })
  );
  add(
    native('putchar', [INT], INT, ([char], { frame }) => {
      frame.runtime.write('stdout', String.fromCodePoint(asNumber(char) & 0xff));
      return asNumber(char) & 0xff;
    })
  );
  add(
    native('fputs', [CONST_CHAR_PTR, streamType], INT, ([text, stream], { frame }) => {
      const bytes = readCString(text as Ptr, frame.runtime);
      frame.runtime.write(library.fileTarget(stream as Ptr), bytes);
      // macOS returns the number of bytes written.
      return bytes.length;
    })
  );
  for (const name of ['fputc', 'putc']) {
    add(
      native(name, [INT, streamType], INT, ([char, stream], { frame }) => {
        frame.runtime.write(library.fileTarget(stream as Ptr), String.fromCodePoint(asNumber(char) & 0xff));
        return asNumber(char) & 0xff;
      })
    );
  }
  add(native('fflush', [streamType], INT, () => 0));
  add(
    native('rand', [], INT, (_args, { frame }) => {
      // macOS's rand: the "minimal standard" generator of Park and Miller, computed with Schrage's method.
      const { runtime } = frame;
      let state = runtime.randomState;
      if (state === 0) state = 123_459_876;
      const hi = Math.floor(state / 127_773);
      const lo = state % 127_773;
      let x = 16_807 * lo - 2836 * hi;
      if (x < 0) x += 0x7f_ff_ff_ff;
      runtime.randomState = x;
      return x % 0x80_00_00_00;
    })
  );
  add(
    native('srand', [UINT], VOID, ([seed], { frame }) => {
      frame.runtime.randomState = asNumber(seed);
      return;
    })
  );
  for (const [name, test] of Object.entries(CHARACTER_CLASSES)) {
    add(
      native(name, [INT], INT, ([c]) => {
        const value = characterArgument(c);
        return value >= 0 && value < 0x80 && test(value) ? 1 : 0;
      })
    );
  }
  add(
    native('tolower', [INT], INT, ([c]) => {
      const value = characterArgument(c);
      return value >= 0x41 && value <= 0x5a ? value + 32 : value;
    })
  );
  add(
    native('toupper', [INT], INT, ([c]) => {
      const value = characterArgument(c);
      return value >= 0x61 && value <= 0x7a ? value - 32 : value;
    })
  );
  add(
    native('strlen', [CONST_CHAR_PTR], SIZE_T, ([text], { frame }) =>
      BigInt(readCString(text as Ptr, frame.runtime).length)
    )
  );
  add(
    native('strcmp', [CONST_CHAR_PTR, CONST_CHAR_PTR], INT, ([a, b], { frame }) =>
      compareBytes(frame, readCString(a as Ptr, frame.runtime), readCString(b as Ptr, frame.runtime))
    )
  );
  add(
    native('strncmp', [CONST_CHAR_PTR, CONST_CHAR_PTR, SIZE_T], INT, ([a, b, n], { frame }) => {
      const count = asNumber(n);
      for (let index = 0; index < count; index++) {
        frame.runtime.spend();
        const left = asNumber((a as Ptr).offset(index).read()) & 0xff;
        const right = asNumber((b as Ptr).offset(index).read()) & 0xff;
        if (left !== right || left === 0) return left - right;
      }
      return 0;
    })
  );
  add(
    native('strcpy', [CHAR_POINTER, CONST_CHAR_PTR], CHAR_POINTER, ([target, source], { frame }) =>
      copyCString(frame, target as Ptr, source as Ptr)
    )
  );
  add(
    native('strncpy', [CHAR_POINTER, CONST_CHAR_PTR, SIZE_T], CHAR_POINTER, ([target, source, n], { frame }) =>
      copyCString(frame, target as Ptr, source as Ptr, { count: asNumber(n) })
    )
  );
  add(
    native('strcat', [CHAR_POINTER, CONST_CHAR_PTR], CHAR_POINTER, ([target, source], { frame }) =>
      copyCString(frame, target as Ptr, source as Ptr, { append: true })
    )
  );
  for (const pointer of [CHAR_POINTER, CONST_CHAR_PTR]) {
    add(
      native('strchr', [pointer, INT], pointer, ([text, char], { frame }) => {
        const bytes = readCString(text as Ptr, frame.runtime);
        const code = asNumber(char) & 0xff;
        if (code !== 0) frame.runtime.spend(Math.ceil(bytes.length / 64));
        const index = code === 0 ? bytes.length : bytes.indexOf(String.fromCodePoint(code));
        return index < 0 ? NULL_PTR : (text as Ptr).offset(index);
      })
    );
    add(
      native('strstr', [pointer, CONST_CHAR_PTR], pointer, ([text, needle], { frame }) => {
        const haystack = readCString(text as Ptr, frame.runtime);
        const substring = readCString(needle as Ptr, frame.runtime);
        frame.runtime.spend(Math.ceil(haystack.length / 64));
        const index = haystack.indexOf(substring);
        return index === -1 ? NULL_PTR : (text as Ptr).offset(index);
      })
    );
  }
  add(native('atoi', [CONST_CHAR_PTR], INT, ([text], { frame }) => Number(parseDecimal(frame, text as Ptr, INT))));
  add(native('atol', [CONST_CHAR_PTR], LONG, ([text], { frame }) => parseDecimal(frame, text as Ptr, LONG)));
  return functions;
}

function copyCString(
  frame: Frame,
  target: Ptr,
  source: Ptr,
  { count, append }: { count?: number; append?: boolean } = {}
): Ptr {
  if (count === 0) return target;
  const prefix = append ? readCString(target, frame.runtime).length : 0;
  const bytes = readCString(source, frame.runtime, count);
  const readLength = Math.min(bytes.length + 1, count ?? Number.POSITIVE_INFINITY);
  const writeLength = count ?? readLength;
  const targetLength = prefix + writeLength;
  rejectOverlappingBytes(target, targetLength, source, readLength);
  checkByteWrite(target, targetLength);
  frame.runtime.spend(Math.ceil(writeLength / 64));
  writeBytes(target.offset(prefix), bytes.padEnd(writeLength, '\0'));
  return target;
}

function printfToBuffer(
  frame: Frame,
  target: Ptr,
  format: Ptr,
  args: unknown[],
  limit = Number.POSITIVE_INFINITY
): number {
  if (limit === 0) return printf(frame, format, args).length;
  const reads: { pointer: Ptr; length: number }[] = [];
  const text = printf(frame, format, args, (pointer, length) => reads.push({ pointer, length }));
  const written = `${text.slice(0, limit - 1)}\0`;
  for (const { pointer, length } of reads) rejectOverlappingBytes(target, written.length, pointer, length);
  checkByteWrite(target, written.length);
  frame.runtime.spend(Math.ceil(written.length / 64));
  writeBytes(target, written);
  return text.length;
}

function printf(frame: Frame, format: Ptr, args: unknown[], observeRead?: CStringReadObserver): string {
  const bytes = readCString(format, frame.runtime, undefined, observeRead);
  return formatPrintf(bytes, args as PrintfArgument[], frame.runtime, observeRead);
}

function parseDecimal(frame: Frame, text: Ptr, type: IntType): bigint {
  const match = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(readCString(text, frame.runtime));
  const value = match ? BigInt(match[1]) : 0n;
  if (value < intMin(type.name) || value > intMax(type.name)) throw overflowError(typeName(type));
  return value;
}

function characterArgument(input: unknown): number {
  const value = asNumber(input);
  if (value < -1 || value > 255)
    throw new CppRuntimeError('custom', '文字を調べる関数の引数は、unsigned char の範囲か EOF にしてください。');
  return value;
}

function compareBytes(frame: Frame, a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (index % 64 === 0) frame.runtime.spend();
    const difference = byteAt(a, index) - byteAt(b, index);
    if (difference !== 0) return difference;
  }
  return byteAt(a, length) - byteAt(b, length);
}
