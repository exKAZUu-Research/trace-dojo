import { isSpaceByte, parseFloatPrefix, parseIntegerPrefix } from '../../c/library/numberParsing';
import { INT_PROPERTIES } from '../../c/types';
import { byteArray } from '../bytes';
import { CppRuntimeError } from '../errors';
import type { Frame } from '../runtime';
import { type IntName, type Type, typeName } from '../types';
import type { Ptr, Value } from '../values';

/** A variadic argument as a library function receives it: its value and its type after promotion. */
interface VariadicArgument {
  value: Value;
  type: Type;
}

/** The count `scanf` returns when it stops early, or undefined when it goes on to the next directive. */
type Stop = number | undefined;

/**
 * Reads the values a `scanf` format describes from input bytes, storing them through the pointer arguments, and
 * gives the number of values it stored (or -1 when the input ended first) and how many bytes it consumed.
 */
export function scanFormat(
  frame: Frame,
  input: string,
  format: string,
  args: readonly unknown[]
): { count: number; consumed: number } {
  const scanner = new Scanner(frame, byteArray(input), byteArray(format), args as VariadicArgument[]);
  const count = scanner.scan();
  return { count, consumed: scanner.position };
}

/** The integer type a `scanf` conversion stores through its pointer, by its length modifier. */
function integerTarget(conversion: string, length: string): IntName {
  const signed = 'din'.includes(conversion);
  if (length === 'hh') return signed ? 'schar' : 'uchar';
  if (length === 'h') return signed ? 'short' : 'ushort';
  if (length === 'll' || length === 'q') return signed ? 'llong' : 'ullong';
  if (['l', 'j', 'z', 't'].includes(length)) return signed ? 'long' : 'ulong';
  return signed ? 'int' : 'uint';
}

class Scanner {
  position = 0;
  private assigned = 0;
  private argument = 0;
  private index = 0;

  constructor(
    private readonly frame: Frame,
    private readonly input: Uint8Array,
    private readonly format: Uint8Array,
    private readonly args: VariadicArgument[]
  ) {}

  scan(): number {
    while (this.index < this.format.length) {
      this.frame.runtime.spend();
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
    const { format } = this;
    const suppress = format[this.index] === 0x2a;
    if (suppress) this.index++;
    let widthText = '';
    while (format[this.index] >= 0x30 && format[this.index] <= 0x39)
      widthText += String.fromCodePoint(format[this.index++]);
    const width = widthText ? Number(widthText) : undefined;
    const length =
      ['hh', 'h', 'll', 'l', 'j', 'z', 't', 'L', 'q'].find((modifier) =>
        [...modifier].every((char, offset) => format[this.index + offset] === char.codePointAt(0))
      ) ?? '';
    this.index += length.length;
    const conversion = String.fromCodePoint(format[this.index++] ?? 0);
    if (conversion === 'n') {
      if (!suppress) this.storeInteger(integerTarget('n', length), BigInt(this.position));
      return undefined;
    }
    if (conversion !== 'c' && conversion !== '[') this.skipInputSpace();
    if (this.position >= this.input.length) return this.inputFailure();
    const limit = width ?? Number.POSITIVE_INFINITY;
    if ('diouxX'.includes(conversion)) return this.integer(conversion, length, limit, suppress);
    if ('feEgGaAF'.includes(conversion)) return this.float(length, limit, suppress);
    if (conversion === 's' || conversion === 'c' || conversion === '[')
      return this.bytes(conversion, conversion === 'c' ? (width ?? 1) : limit, suppress);
    throw new CppRuntimeError('custom', `書式「%${conversion}」は、この採点環境の scanf では使えません。`);
  }

  private integer(conversion: string, length: string, limit: number, suppress: boolean): Stop {
    const base = conversion === 'i' ? 0 : conversion === 'o' ? 8 : 'xX'.includes(conversion) ? 16 : 10;
    const parsed = parseIntegerPrefix(this.input.subarray(this.position), base, limit, () =>
      this.frame.runtime.spend()
    );
    if (parsed.length === 0) return this.assigned;
    this.position += parsed.length;
    if (suppress) return undefined;
    this.storeInteger(integerTarget(conversion, length), parsed.value);
    this.assigned++;
    return undefined;
  }

  private storeInteger(name: IntName, value: bigint): void {
    const { size, signed } = INT_PROPERTIES[name];
    const bits = size * 8;
    const stored = signed ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
    this.nextPointer({ kind: 'int', name }).write(size === 8 ? stored : Number(stored));
  }

  private float(length: string, limit: number, suppress: boolean): Stop {
    const parsed = parseFloatPrefix(this.input.subarray(this.position), limit);
    if (parsed.length === 0) return this.assigned;
    this.position += parsed.length;
    if (suppress) return undefined;
    const isDouble = length === 'l' || length === 'L';
    const target: Type = { kind: 'float', name: length === 'L' ? 'ldouble' : isDouble ? 'double' : 'float' };
    this.nextPointer(target).write(isDouble || length === 'L' ? parsed.value : Math.fround(parsed.value));
    this.assigned++;
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
    while (this.position < input.length && this.position - start < max && accept(input[this.position])) this.position++;
    if (this.position === start) return this.assigned;
    if (suppress) return undefined;
    const target = this.nextPointer({ kind: 'int', name: 'char' });
    const bytes = [...input.subarray(start, this.position)];
    if (conversion !== 'c') bytes.push(0);
    for (const [offset, value] of bytes.entries()) target.offset(offset).write(value >= 128 ? value - 256 : value);
    this.assigned++;
    return undefined;
  }

  /** Reads the scan set of `%[` after its bracket, giving whether it accepts a byte. */
  private scanSet(): (byte: number) => boolean {
    const { format } = this;
    const negate = format[this.index] === 0x5e;
    if (negate) this.index++;
    const members = new Set<number>();
    let first = true;
    while (this.index < format.length && (format[this.index] !== 0x5d || first)) {
      const index = this.index;
      if (format[index] === 0x2d && !first && format[index + 1] !== 0x5d && index + 1 < format.length) {
        for (let value = format[index - 1]; value <= format[index + 1]; value++) members.add(value);
        this.index += 2;
      } else members.add(format[this.index++]);
      first = false;
    }
    this.index++;
    return (value) => members.has(value) !== negate;
  }

  private nextPointer(target: Type): Ptr {
    const argument = this.args[this.argument++];
    if (!argument) throw new CppRuntimeError('custom', 'scanf の書式（%など）に対して、引数が足りません。');
    const { type, value } = argument;
    const pointee = type.kind === 'pointer' ? type.to : undefined;
    const matches =
      pointee !== undefined &&
      pointee.kind === target.kind &&
      (pointee.kind !== 'int' ||
        (target.kind === 'int' && INT_PROPERTIES[pointee.name].size === INT_PROPERTIES[target.name].size)) &&
      (pointee.kind !== 'float' ||
        (target.kind === 'float' && (pointee.name === 'float') === (target.name === 'float')));
    if (!matches)
      throw new CppRuntimeError('custom', `scanf の書式（%など）と引数の型（${typeName(type)}）が合いません。`);
    const pointer = value as Ptr;
    if (pointer.isNull) throw new CppRuntimeError('nullAccess');
    return pointer;
  }

  private skipInputSpace(): void {
    while (this.position < this.input.length && isSpaceByte(this.input[this.position])) this.position++;
  }

  private inputFailure(): number {
    return this.assigned > 0 ? this.assigned : -1;
  }
}
