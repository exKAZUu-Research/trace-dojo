import { FileSystemError } from '../../interpreter/programIo';
import { byteArray, byteAt } from '../bytes';
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
import { Box, NULL_PTR, Ptr } from '../values';
import { remainingArguments } from '../variadic';
import { formatPrintf, type PrintfArgument } from './formatting';
import { IO_STATE, OPEN_MODE, StreamValue } from './iostream';
import type { Library } from './registry';
import { scanFormat } from './scanf';
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
        library.writeFile(stream as Ptr, frame, text);
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
  // The `v` forms take the variadic arguments a `va_list` has left.
  add(
    native('vprintf', [CONST_CHAR_PTR, CHAR_POINTER], INT, ([format, list], { frame }) => {
      const text = printf(frame, format as Ptr, remainingArguments(list as Ptr));
      frame.runtime.write('stdout', text);
      return text.length;
    })
  );
  add(
    native('vfprintf', [streamType, CONST_CHAR_PTR, CHAR_POINTER], INT, ([stream, format, list], { frame }) => {
      const text = printf(frame, format as Ptr, remainingArguments(list as Ptr));
      library.writeFile(stream as Ptr, frame, text);
      return text.length;
    })
  );
  add(
    native('vsprintf', [CHAR_POINTER, CONST_CHAR_PTR, CHAR_POINTER], INT, ([target, format, list], { frame }) =>
      printfToBuffer(frame, target as Ptr, format as Ptr, remainingArguments(list as Ptr))
    )
  );
  add(
    native(
      'vsnprintf',
      [CHAR_POINTER, SIZE_T, CONST_CHAR_PTR, CHAR_POINTER],
      INT,
      ([target, size, format, list], { frame }) =>
        printfToBuffer(frame, target as Ptr, format as Ptr, remainingArguments(list as Ptr), asNumber(size))
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
      library.writeFile(stream as Ptr, frame, bytes);
      // macOS returns the number of bytes written.
      return bytes.length;
    })
  );
  for (const name of ['fputc', 'putc']) {
    add(
      native(name, [INT, streamType], INT, ([char, stream], { frame }) => {
        library.writeFile(stream as Ptr, frame, String.fromCodePoint(asNumber(char) & 0xff));
        return asNumber(char) & 0xff;
      })
    );
  }
  add(native('fflush', [streamType], INT, () => 0));
  addInputFunctions(library, add, streamType);
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
      compareCStrings(frame, a as Ptr, b as Ptr, Infinity)
    )
  );
  add(
    native('strncmp', [CONST_CHAR_PTR, CONST_CHAR_PTR, SIZE_T], INT, ([a, b, n], { frame }) =>
      compareCStrings(frame, a as Ptr, b as Ptr, asNumber(n))
    )
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
      native('strchr', [pointer, INT], pointer, ([text, char], { frame }) =>
        findCharacter(frame, text as Ptr, asNumber(char) & 0xff)
      )
    );
    add(
      native('strstr', [pointer, CONST_CHAR_PTR], pointer, ([text, needle], { frame }) =>
        findSubstring(frame, text as Ptr, needle as Ptr)
      )
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
  target.target();
  source.target();
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

function compareCStrings(frame: Frame, a: Ptr, b: Ptr, count: number): number {
  a.target();
  b.target();
  if (count === 0) return 0;
  const left = characterReader(frame, a);
  const right = characterReader(frame, b);
  for (let index = 0; index < count; index++) {
    const x = left(index);
    const y = right(index);
    if (x !== y || x === 0) return x - y;
  }
  return 0;
}

function findCharacter(frame: Frame, text: Ptr, character: number): Ptr {
  const read = characterReader(frame, text);
  for (let index = 0; ; index++) {
    const byte = read(index);
    if (byte === character) return text.offset(index);
    if (byte === 0) return NULL_PTR;
  }
}

function findSubstring(frame: Frame, text: Ptr, needle: Ptr): Ptr {
  const read = characterReader(frame, text);
  const start = read(0);
  const readNeedle = characterReader(frame, needle);
  const first = readNeedle(0);
  if (first === 0) return text;
  const pattern = [first];
  const fallback = [0];
  for (let index = 0, matched = 0; ; index++) {
    const byte = index === 0 ? start : read(index);
    if (byte === 0) return NULL_PTR;
    matched = advanceMatch(pattern, fallback, matched, byte);
    if (matched === pattern.length) {
      const next = readNeedle(matched);
      if (next === 0) return text.offset(index + 1 - matched);
      fallback.push(advanceMatch(pattern, fallback, fallback[matched - 1], next));
      pattern.push(next);
    }
  }
}

function advanceMatch(pattern: number[], fallback: number[], matched: number, byte: number): number {
  while (matched > 0 && byte !== pattern[matched]) matched = fallback[matched - 1];
  return byte === pattern[matched] ? matched + 1 : matched;
}

function characterReader(frame: Frame, pointer: Ptr): (offset: number) => number {
  const store = pointer.target();
  const start = pointer.index;
  return (offset) => {
    if (offset % 64 === 0) frame.runtime.spend();
    if (start < 0 || start + offset >= store.length) throw new CppRuntimeError('unterminatedString');
    return asNumber(store.get(start + offset)) & 0xff;
  };
}

/**
 * The functions of `<cstdio>` that read: from standard input (`scanf`, `getchar`), from a `FILE*` (`fscanf`, `fgets`,
 * `getc`), and from a string (`sscanf`). Standard input is the stream `std::cin` reads, as when the two are
 * synchronized.
 */
function addInputFunctions(library: Library, add: (fn: FunctionInfo) => void, streamType: Type): void {
  add(
    native(
      'scanf',
      [CONST_CHAR_PTR],
      INT,
      ([format, ...args], { frame }) => scanFrom(frame.runtime.standardInput(), frame, format as Ptr, args),
      { isVariadic: true }
    )
  );
  add(
    native(
      'fscanf',
      [streamType, CONST_CHAR_PTR],
      INT,
      ([file, format, ...args], { frame }) =>
        scanFrom(library.inputStream(file as Ptr, frame), frame, format as Ptr, args),
      { isVariadic: true }
    )
  );
  add(
    native(
      'sscanf',
      [CONST_CHAR_PTR, CONST_CHAR_PTR],
      INT,
      ([text, format, ...args], { frame }) =>
        scanFormat(frame, readCString(text as Ptr, frame.runtime), readCString(format as Ptr, frame.runtime), args)
          .count,
      { isVariadic: true }
    )
  );
  // The `v` forms take the pointers a `va_list` has left.
  add(
    native('vscanf', [CONST_CHAR_PTR, CHAR_POINTER], INT, ([format, list], { frame }) =>
      scanFrom(frame.runtime.standardInput(), frame, format as Ptr, remainingArguments(list as Ptr))
    )
  );
  add(
    native('vfscanf', [streamType, CONST_CHAR_PTR, CHAR_POINTER], INT, ([file, format, list], { frame }) =>
      scanFrom(library.inputStream(file as Ptr, frame), frame, format as Ptr, remainingArguments(list as Ptr))
    )
  );
  add(
    native(
      'vsscanf',
      [CONST_CHAR_PTR, CONST_CHAR_PTR, CHAR_POINTER],
      INT,
      ([text, format, list], { frame }) =>
        scanFormat(
          frame,
          readCString(text as Ptr, frame.runtime),
          readCString(format as Ptr, frame.runtime),
          remainingArguments(list as Ptr)
        ).count
    )
  );
  add(native('getchar', [], INT, (_args, { frame }) => readByte(frame.runtime.standardInput())));
  addFileFunctions(library, add, streamType);
  for (const name of ['getc', 'fgetc'])
    add(native(name, [streamType], INT, ([file], { frame }) => readByte(library.inputStream(file as Ptr, frame))));
  add(
    native('ungetc', [INT, streamType], INT, ([char, file], { frame }) => {
      const stream = library.inputStream(file as Ptr, frame);
      const value = asNumber(char);
      if (value === -1 || stream.position === 0) return -1;
      stream.position--;
      stream.state &= ~IO_STATE.eofbit;
      return value & 0xff;
    })
  );
  add(
    native('fgets', [CHAR_POINTER, INT, streamType], CHAR_POINTER, ([target, size, file], { frame }) => {
      const stream = library.inputStream(file as Ptr, frame);
      const limit = asNumber(size) - 1;
      const buffer = target as Ptr;
      if (limit < 0 || stream.position >= stream.buffer.length) {
        stream.state |= IO_STATE.eofbit;
        return limit < 0 ? buffer : NULL_PTR;
      }
      let count = 0;
      while (count < limit && stream.position < stream.buffer.length) {
        frame.runtime.spend();
        const byte = byteAt(stream.buffer, stream.position++);
        buffer.offset(count++).write(byte >= 128 ? byte - 256 : byte);
        if (byte === 0x0a) break;
      }
      buffer.offset(count).write(0);
      return buffer;
    })
  );
}

/** Reads what a `scanf` format describes from where a stream's reading continues. */
function scanFrom(stream: StreamValue, frame: Frame, format: Ptr, args: unknown[]): number {
  const input = stream.buffer.slice(stream.position);
  const { count, consumed } = scanFormat(frame, input, readCString(format, frame.runtime), args);
  stream.position += consumed;
  if (stream.position >= stream.buffer.length) stream.state |= IO_STATE.eofbit;
  return count;
}

/** Reads one byte of a stream as `getc` does, or `EOF` (-1) at its end. */
function readByte(stream: StreamValue): number {
  if (stream.position >= stream.buffer.length) {
    stream.state |= IO_STATE.eofbit;
    return -1;
  }
  return byteAt(stream.buffer, stream.position++);
}

/** The modes of `fopen`, as `basic_filebuf::open` takes them (C++20 [filebuf.members] Table 135). */
const FOPEN_MODES: Record<string, number> = {
  r: OPEN_MODE.in,
  w: OPEN_MODE.out | OPEN_MODE.trunc,
  a: OPEN_MODE.app,
  'r+': OPEN_MODE.in | OPEN_MODE.out,
  'w+': OPEN_MODE.in | OPEN_MODE.out | OPEN_MODE.trunc,
  'a+': OPEN_MODE.in | OPEN_MODE.app,
};

/** `fopen`, `fclose`, and the functions that ask where a file stands, over the run's file system. */
function addFileFunctions(library: Library, add: (fn: FunctionInfo) => void, streamType: Type): void {
  add(
    native('fopen', [CONST_CHAR_PTR, CONST_CHAR_PTR], streamType, ([path, mode], { frame }) => {
      const flags = FOPEN_MODES[textOf(mode, frame).replaceAll('b', '')];
      if (flags === undefined) return NULL_PTR;
      const stream = new StreamValue('fstream', 'file', flags);
      stream.openFile(frame, textOf(path, frame), flags);
      return stream.isOpen ? new Ptr(new Box(stream), 0) : NULL_PTR;
    })
  );
  add(native('fclose', [streamType], INT, ([file]) => (fileOf(file).closeFile() ? 0 : -1)));
  add(
    native('feof', [streamType], INT, ([file], { frame }) =>
      library.inputStream(file as Ptr, frame).state & IO_STATE.eofbit ? 1 : 0
    )
  );
  add(native('ferror', [streamType], INT, () => 0));
  add(
    native('rewind', [streamType], VOID, ([file], { frame }) => {
      const stream = library.inputStream(file as Ptr, frame);
      stream.position = 0;
      stream.state = IO_STATE.goodbit;
      return;
    })
  );
  add(
    native('ftell', [streamType], LONG, ([file], { frame }) => BigInt(library.inputStream(file as Ptr, frame).position))
  );
  add(
    native('fseek', [streamType, LONG, INT], INT, ([file, offset, whence], { frame }) => {
      const stream = library.inputStream(file as Ptr, frame);
      const base = asNumber(whence) === 0 ? 0 : asNumber(whence) === 1 ? stream.position : stream.buffer.length;
      const target = base + Number(offset);
      if (target < 0) return -1;
      stream.position = target;
      stream.state &= ~IO_STATE.eofbit;
      return 0;
    })
  );
  add(
    native('rename', [CONST_CHAR_PTR, CONST_CHAR_PTR], INT, ([from, to], { frame }) => {
      try {
        frame.runtime.io.files.rename(textOf(from, frame), textOf(to, frame));
        return 0;
      } catch (error) {
        if (error instanceof FileSystemError) return -1;
        throw error;
      }
    })
  );
}

/** A C string the program wrote in UTF-8 bytes, such as a file's path. */
function textOf(pointer: unknown, frame: Frame): string {
  return new TextDecoder().decode(byteArray(readCString(pointer as Ptr, frame.runtime)));
}

/** The stream of a file `fopen` opened. */
function fileOf(pointer: unknown): StreamValue {
  const file = pointer instanceof Ptr && pointer.store instanceof Box ? pointer.store.value : undefined;
  if (!(file instanceof StreamValue)) throw new CppRuntimeError('custom', 'fopen で開いたファイルではありません。');
  return file;
}
