import type { Value } from '../arith';
import { CRuntimeError } from '../errors';
import { loaderOf, loadRecord, type NativeFunction, type Runtime, storerOf } from '../runtime';
import {
  CHAR,
  CHAR_POINTER,
  type CType,
  DOUBLE,
  FLOAT,
  INT,
  INT_PROPERTIES,
  LONG,
  SHORT,
  SIZE_T,
  sizeOf,
  typeName,
  ULONG,
} from '../types';
import { unsupportedMessage } from '../unsupported';
import { isSpaceByte, parseFloatPrefix, parseIntegerPrefix } from './numberParsing';
import { formatPrintf } from './printf';
import { errorMessage } from './stringFunctions';
import { asAddress, asNumber, asSize, readBytes, readCString, startsWithAt, writeBytes } from './support';

/** The stream a `FILE *` argument names: standard output or standard error, the only ones a program may use. */
function streamOf(runtime: Runtime, value: Value | undefined): 'stdout' | 'stderr' {
  const address = asAddress(value);
  if (address === runtime.streams.stdout) return 'stdout';
  if (address === runtime.streams.stderr) return 'stderr';
  if (address === runtime.streams.stdin) throw new CRuntimeError('custom', unsupportedMessage('標準入力'));
  if (address === 0) throw new CRuntimeError('nullArgument');
  throw new CRuntimeError('custom', unsupportedMessage('ファイルの読み書き'));
}

function write(runtime: Runtime, stream: 'stdout' | 'stderr', bytes: Uint8Array | number[]): void {
  runtime.output(stream, bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
}

function printTo(stream: 'stdout' | 'stderr' | 'argument'): NativeFunction {
  return (runtime, args, types) => {
    const offset = stream === 'argument' ? 1 : 0;
    const target = stream === 'argument' ? streamOf(runtime, args[0]) : stream;
    const format = readCString(runtime, asAddress(args[offset]));
    const bytes = formatPrintf(runtime, format, args.slice(offset + 1), types.slice(offset + 1));
    write(runtime, target, bytes);
    return bytes.length;
  };
}

export const STDIO_FUNCTIONS: Record<string, NativeFunction> = {
  printf: printTo('stdout'),
  fprintf: printTo('argument'),
  sprintf: (runtime, args, types) => {
    const bytes = formatPrintf(runtime, readCString(runtime, asAddress(args[1])), args.slice(2), types.slice(2));
    writeBytes(runtime, asAddress(args[0]), Uint8Array.from([...bytes, 0]));
    return bytes.length;
  },
  snprintf: (runtime, args, types) => {
    const bytes = formatPrintf(runtime, readCString(runtime, asAddress(args[2])), args.slice(3), types.slice(3));
    const size = asSize(args[1]);
    if (size > 0) writeBytes(runtime, asAddress(args[0]), Uint8Array.from([...bytes.slice(0, size - 1), 0]));
    return bytes.length;
  },
  puts: (runtime, [s]) => {
    write(runtime, 'stdout', [...readCString(runtime, asAddress(s)), 0x0a]);
    return 0;
  },
  putchar: (runtime, [c]) => {
    const byte = asNumber(c) & 0xff;
    write(runtime, 'stdout', [byte]);
    return byte;
  },
  fputs: (runtime, [s, stream]) => {
    write(runtime, streamOf(runtime, stream), readCString(runtime, asAddress(s)));
    return 0;
  },
  fputc: (runtime, [c, stream]) => {
    const byte = asNumber(c) & 0xff;
    write(runtime, streamOf(runtime, stream), [byte]);
    return byte;
  },
  putc: (runtime, [c, stream]) => {
    const byte = asNumber(c) & 0xff;
    write(runtime, streamOf(runtime, stream), [byte]);
    return byte;
  },
  fwrite: (runtime, [pointer, size, count, stream]) => {
    const target = streamOf(runtime, stream);
    const total = asSize(size) * asSize(count);
    write(runtime, target, readBytes(runtime, asAddress(pointer), total));
    return BigInt(asSize(size) === 0 ? 0 : asSize(count));
  },
  fflush: (runtime, [stream]) => {
    if (asAddress(stream) !== 0) streamOf(runtime, stream);
    return 0;
  },
  setbuf: (runtime, [stream]) => {
    streamOf(runtime, stream);
    return;
  },
  setvbuf: (runtime, [stream]) => {
    streamOf(runtime, stream);
    return 0;
  },
  perror: (runtime, [s]) => {
    const address = asAddress(s);
    const prefix = address === 0 ? [] : [...readCString(runtime, address)];
    const message = new TextEncoder().encode(errorMessage(runtime.errno));
    const head = prefix.length > 0 ? [...prefix, 0x3a, 0x20] : [];
    write(runtime, 'stderr', [...head, ...message, 0x0a]);
    return;
  },
  sscanf: (runtime, args, types) =>
    scan(
      runtime,
      readCString(runtime, asAddress(args[0])),
      readCString(runtime, asAddress(args[1])),
      args.slice(2),
      types.slice(2)
    ),
};

/** The type a `scanf` conversion stores through its pointer argument. */
function scanTarget(conversion: string, length: string): CType {
  if ('diouxXn'.includes(conversion)) {
    const signed = 'din'.includes(conversion);
    switch (length) {
      case 'hh': {
        return signed ? { kind: 'int', name: 'schar' } : { kind: 'int', name: 'uchar' };
      }
      case 'h': {
        return signed ? SHORT : { kind: 'int', name: 'ushort' };
      }
      case 'l':
      case 'll':
      case 'j':
      case 'z':
      case 't':
      case 'q': {
        return signed ? LONG : ULONG;
      }
      default: {
        return signed ? INT : { kind: 'int', name: 'uint' };
      }
    }
  }
  if ('feEgGaAF'.includes(conversion)) return length === 'l' || length === 'L' ? DOUBLE : FLOAT;
  return CHAR;
}

/** `sscanf`: reads the values a format describes from a string, storing them through the pointer arguments. */
function scan(runtime: Runtime, input: Uint8Array, format: Uint8Array, args: Value[], types: CType[]): number {
  return new Scanner(runtime, input, format, args, types).scan();
}

/** The count `sscanf` returns when it stops early, or undefined when it goes on to the next directive. */
type Stop = number | undefined;

class Scanner {
  private position = 0;
  private assigned = 0;
  private argument = 0;
  private index = 0;
  private converted = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly input: Uint8Array,
    private readonly format: Uint8Array,
    private readonly args: Value[],
    private readonly types: CType[]
  ) {}

  scan(): number {
    while (this.index < this.format.length) {
      const stop = this.directive();
      if (stop !== undefined) return stop;
    }
    return this.assigned;
  }

  private directive(): Stop {
    const { input, format } = this;
    const byte = format[this.index];
    if (isSpaceByte(byte)) {
      while (this.index < format.length && isSpaceByte(format[this.index])) this.index++;
      this.skipInputSpace();
      return undefined;
    }
    if (byte !== 0x25) {
      if (this.position >= input.length) return this.inputFailure();
      if (input[this.position] !== byte) return this.assigned;
      this.position++;
      this.index++;
      return undefined;
    }
    this.index++;
    if (format[this.index] === 0x25) {
      this.skipInputSpace();
      if (this.position >= input.length) return this.inputFailure();
      if (input[this.position] !== 0x25) return this.assigned;
      this.position++;
      this.index++;
      return undefined;
    }
    return this.conversion();
  }

  private conversion(): Stop {
    const { input, format } = this;
    let suppress = false;
    if (format[this.index] === 0x2a) {
      suppress = true;
      this.index++;
    }
    let widthText = '';
    while (format[this.index] >= 0x30 && format[this.index] <= 0x39) {
      widthText += String.fromCodePoint(format[this.index++]);
    }
    const width = widthText ? Number(widthText) : undefined;
    const length =
      ['hh', 'h', 'll', 'l', 'j', 'z', 't', 'L', 'q'].find((modifier) => startsWithAt(format, this.index, modifier)) ??
      '';
    this.index += length.length;
    const conversion = String.fromCodePoint(format[this.index++] ?? 0);
    if (conversion === 'n') {
      if (!suppress) this.storeCount(length);
      return undefined;
    }
    if (conversion !== 'c' && conversion !== '[') this.skipInputSpace();
    if (this.position >= input.length) return this.inputFailure();
    const limit = width ?? Number.POSITIVE_INFINITY;
    if ('diouxX'.includes(conversion)) return this.integer(conversion, length, limit, suppress);
    if ('feEgGaAF'.includes(conversion)) return this.float(conversion, length, limit, suppress);
    if (conversion === 's' || conversion === 'c' || conversion === '[') {
      return this.bytes(conversion, conversion === 'c' ? (width ?? 1) : limit, suppress);
    }
    throw new CRuntimeError('custom', `書式「%${conversion}」は、この採点環境の sscanf では使えません。`);
  }

  private storeCount(length: string): void {
    const target = scanTarget('n', length) as Extract<CType, { kind: 'int' }>;
    storerOf(target)(
      this.runtime,
      this.nextPointer(target),
      INT_PROPERTIES[target.name].size === 8 ? BigInt(this.position) : this.position
    );
  }

  private integer(conversion: string, length: string, limit: number, suppress: boolean): Stop {
    const base =
      conversion === 'd' ? 10 : conversion === 'i' ? 0 : conversion === 'o' ? 8 : conversion === 'u' ? 10 : 16;
    const parsed = parseIntegerPrefix(this.input.subarray(this.position), base, limit);
    if (parsed.length === 0) return this.assigned;
    this.position += parsed.length;
    this.converted = true;
    if (!suppress) {
      const target = scanTarget(conversion, length);
      const pointer = this.nextPointer(target);
      const size = INT_PROPERTIES[(target as Extract<CType, { kind: 'int' }>).name].size;
      const bits = BigInt(size * 8);
      const value = BigInt.asUintN(Number(bits), parsed.value);
      storerOf(target)(this.runtime, pointer, size === 8 ? value : Number(BigInt.asIntN(32, value)));
      this.assigned++;
    }
    return undefined;
  }

  private float(conversion: string, length: string, limit: number, suppress: boolean): Stop {
    const parsed = parseFloatPrefix(this.input.subarray(this.position), limit);
    if (parsed.length === 0) return this.assigned;
    this.position += parsed.length;
    this.converted = true;
    if (!suppress) {
      const target = scanTarget(conversion, length);
      storerOf(target)(
        this.runtime,
        this.nextPointer(target),
        target === FLOAT ? Math.fround(parsed.value) : parsed.value
      );
      this.assigned++;
    }
    return undefined;
  }

  /** Reads the bytes of `%s`, `%c`, or `%[`, at most `max` of them. */
  private bytes(conversion: 's' | 'c' | '[', max: number, suppress: boolean): Stop {
    const { input } = this;
    const accept =
      conversion === 's'
        ? (value: number): boolean => !isSpaceByte(value)
        : conversion === 'c'
          ? (): boolean => true
          : this.scanSet();
    const start = this.position;
    while (this.position < input.length && this.position - start < max && accept(input[this.position])) {
      this.position++;
    }
    if (this.position === start) return this.assigned;
    if (conversion === 'c' && this.position - start < max) return this.inputFailure();
    this.converted = true;
    if (!suppress) {
      const bytes = input.subarray(start, this.position);
      writeBytes(this.runtime, this.nextPointer(CHAR), conversion === 'c' ? bytes : Uint8Array.from([...bytes, 0]));
      this.assigned++;
    }
    return undefined;
  }

  /** Reads the scan set of `%[` after its bracket, returning whether it accepts a byte. */
  private scanSet(): (byte: number) => boolean {
    const { format } = this;
    let negate = false;
    if (format[this.index] === 0x5e) {
      negate = true;
      this.index++;
    }
    const members = new Set<number>();
    let first = true;
    while (this.index < format.length && (format[this.index] !== 0x5d || first)) {
      const index = this.index;
      if (format[index] === 0x2d && !first && format[index + 1] !== 0x5d && index + 1 < format.length) {
        for (let value = format[index - 1]; value <= format[index + 1]; value++) members.add(value);
        this.index += 2;
      } else {
        members.add(format[this.index++]);
      }
      first = false;
    }
    this.index++;
    return (value) => members.has(value) !== negate;
  }

  private nextPointer(target: CType): number {
    if (this.argument >= this.args.length) throw new CRuntimeError('formatArgumentMissing');
    const type = this.types[this.argument];
    const value = this.args[this.argument++];
    if (type.kind !== 'pointer') throw new CRuntimeError('formatArgumentType');
    const pointee = type.to;
    const sameSize =
      pointee.kind === target.kind &&
      (pointee.kind !== 'int' ||
        (target.kind === 'int' && INT_PROPERTIES[pointee.name].size === INT_PROPERTIES[target.name].size)) &&
      (pointee.kind !== 'float' ||
        (target.kind === 'float' && (pointee.name === 'float') === (target.name === 'float')));
    if (!sameSize && !(pointee.kind === 'void')) {
      throw new CRuntimeError('custom', `書式（%など）と引数の型（${typeName(type)}）が合いません。`);
    }
    return value as number;
  }

  private skipInputSpace(): void {
    while (this.position < this.input.length && isSpaceByte(this.input[this.position])) this.position++;
  }

  private inputFailure(): number {
    return this.converted || this.assigned > 0 ? this.assigned : -1;
  }
}

/** The extra arguments from where a `va_list` points to the last one, as the `v` functions read them. */
function varargsFrom(runtime: Runtime, value: Value | undefined): { values: Value[]; types: CType[] } {
  const address = asAddress(value);
  const block = runtime.memory.find(address) ?? runtime.memory.find(address - 1);
  const slots = block ? runtime.varargTypes.get(block.base) : undefined;
  if (!block || !slots) throw new CRuntimeError('custom', 'va_list が va_start で始めた可変長引数を指していません。');
  const values: Value[] = [];
  const types: CType[] = [];
  for (let slot = (address - block.base) / 8; slot < slots.length;) {
    const type = slots[slot];
    const at = block.base + slot * 8;
    values.push(type.kind === 'record' ? loadRecord(runtime, at, sizeOf(type)) : loaderOf(type)(runtime, at));
    types.push(type);
    slot += Math.ceil(sizeOf(type) / 8);
  }
  return { values, types };
}

/** The `v` functions of stdio.h, which take the extra arguments of a variadic function as a `va_list`. */
export const VARARG_FUNCTIONS: Record<string, NativeFunction> = {
  vprintf: (runtime, [format, list]) => {
    const { values, types } = varargsFrom(runtime, list);
    return STDIO_FUNCTIONS.printf(runtime, [format, ...values], [CHAR_POINTER, ...types], 0);
  },
  vfprintf: (runtime, [stream, format, list]) => {
    const { values, types } = varargsFrom(runtime, list);
    return STDIO_FUNCTIONS.fprintf(runtime, [stream, format, ...values], [CHAR_POINTER, CHAR_POINTER, ...types], 0);
  },
  vsprintf: (runtime, [buffer, format, list]) => {
    const { values, types } = varargsFrom(runtime, list);
    return STDIO_FUNCTIONS.sprintf(runtime, [buffer, format, ...values], [CHAR_POINTER, CHAR_POINTER, ...types], 0);
  },
  vsnprintf: (runtime, [buffer, size, format, list]) => {
    const { values, types } = varargsFrom(runtime, list);
    return STDIO_FUNCTIONS.snprintf(
      runtime,
      [buffer, size, format, ...values],
      [CHAR_POINTER, SIZE_T, CHAR_POINTER, ...types],
      0
    );
  },
  vsscanf: (runtime, [text, format, list]) => {
    const { values, types } = varargsFrom(runtime, list);
    return STDIO_FUNCTIONS.sscanf(runtime, [text, format, ...values], [CHAR_POINTER, CHAR_POINTER, ...types], 0);
  },
};
