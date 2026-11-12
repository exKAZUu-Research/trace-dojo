// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { formatFloat } from './floatFormat';
import { decodeRune, encodeRune, RUNE_ERROR, runesOf } from './literals';
import { compareMapKeys } from './mapOrder';
import { dynamicMethod } from './methods';
import { canBackquote, isPrint, quote, quoteRune } from './quote';
import { GoPanic } from './runtime';
import { ERROR_TYPE, isExported, missingMethod, type Type, typeString, underlying } from './types';
import { type Complex, type GoArray, GoFunc, GoMap, type GoStruct, Iface, Pointer, Slice, type Value } from './values';

const STRINGER = {
  kind: 'interface',
  methods: [
    {
      name: 'String',
      type: {
        kind: 'func',
        params: [],
        results: [{ kind: 'basic', basic: 'string', name: 'string' }],
        variadic: false,
      },
    },
  ],
} as const;

const LOWER_DIGITS = '0123456789abcdefx';
const UPPER_DIGITS = '0123456789ABCDEFX';

/** The address `%p` and `%v` print for a pointer-like value, stable for each object while the program runs. */
const addresses = new WeakMap<object, number>();
let nextAddress = 0xc0_00_01_00_00;

export function addressOf(object: object): string {
  let address = addresses.get(object);
  if (address === undefined) {
    address = nextAddress;
    nextAddress += 0x10;
    addresses.set(object, address);
  }
  return `0x${address.toString(16)}`;
}

/** The position of doPrintf in its format and arguments. */
interface Cursor {
  readonly format: string;
  readonly args: Value[];
  i: number;
  argNum: number;
  afterIndex: boolean;
  reordered: boolean;
  goodArgNum: boolean;
}

interface Flags {
  plus: boolean;
  minus: boolean;
  sharp: boolean;
  space: boolean;
  zero: boolean;
  plusV: boolean;
  sharpV: boolean;
  width: number | undefined;
  precision: number | undefined;
}

function noFlags(): Flags {
  return {
    plus: false,
    minus: false,
    sharp: false,
    space: false,
    zero: false,
    plusV: false,
    sharpV: false,
    width: undefined,
    precision: undefined,
  };
}

/** Formats values as Go's fmt package does; the output holds UTF-8 bytes. */
export class Printer {
  /** The errors that %w verbs referred to, which only Errorf, constructed with `wrapErrors`, accepts. */
  readonly wrapped: Value[] = [];
  private buffer = '';
  private flags = noFlags();
  /** The value being printed by its methods, to detect a String method that prints its own receiver forever. */
  private readonly depthLimit = 1000;
  private depth = 0;

  constructor(private readonly wrapErrors = false) {}

  // Entry points --------------------------------------------------------------------------------------------------

  print(args: Value[]): string {
    let previousIsString = false;
    for (const [index, arg] of args.entries()) {
      const isString =
        arg instanceof Iface &&
        underlying(arg.type).kind === 'basic' &&
        (underlying(arg.type) as { basic: string }).basic === 'string';
      // Print adds spaces between operands when neither is a string.
      if (index > 0 && !isString && !previousIsString) this.buffer += ' ';
      this.printArg(arg, 'v');
      previousIsString = isString;
    }
    return this.buffer;
  }

  println(args: Value[]): string {
    for (const [index, arg] of args.entries()) {
      if (index > 0) this.buffer += ' ';
      this.printArg(arg, 'v');
    }
    this.buffer += '\n';
    return this.buffer;
  }

  /** Go's doPrintf: literal text, then for each verb its flags, argument index, width, precision, and argument. */
  printf(format: string, args: Value[]): string {
    const cursor: Cursor = { format, args, i: 0, argNum: 0, afterIndex: false, reordered: false, goodArgNum: true };
    const end = format.length;
    while (cursor.i < end) {
      cursor.goodArgNum = true;
      const start = cursor.i;
      while (cursor.i < end && format[cursor.i] !== '%') cursor.i++;
      if (cursor.i > start) this.buffer += format.slice(start, cursor.i);
      if (cursor.i >= end) break;
      cursor.i++;
      this.readFlags(cursor);
      this.readArgNumber(cursor);
      this.readWidth(cursor);
      this.readPrecision(cursor);
      if (!cursor.afterIndex) this.readArgNumber(cursor);
      if (cursor.i >= end) {
        this.buffer += '%!(NOVERB)';
        break;
      }
      this.printVerb(cursor);
    }
    if (!cursor.reordered && cursor.argNum < args.length) this.printExtra(args.slice(cursor.argNum));
    return this.buffer;
  }

  private readFlags(cursor: Cursor): void {
    this.flags = noFlags();
    const flagNames: Record<string, 'sharp' | 'zero' | 'plus' | 'minus' | 'space'> = {
      '#': 'sharp',
      '0': 'zero',
      '+': 'plus',
      '-': 'minus',
      ' ': 'space',
    };
    for (; cursor.i < cursor.format.length; cursor.i++) {
      const flag = flagNames[cursor.format[cursor.i]];
      if (!flag) return;
      this.flags[flag] = true;
    }
  }

  private readArgNumber(cursor: Cursor): void {
    const [argNum, i, afterIndex, good] = this.argNumber(
      cursor.argNum,
      cursor.format,
      cursor.i,
      cursor.args.length,
      cursor.goodArgNum
    );
    Object.assign(cursor, { argNum, i, afterIndex, goodArgNum: good });
    if (afterIndex) cursor.reordered = true;
  }

  private readWidth(cursor: Cursor): void {
    if (cursor.format[cursor.i] === '*') {
      cursor.i++;
      const [width, isInt, nextArg] = intFromArg(cursor.args, cursor.argNum);
      cursor.argNum = nextArg;
      this.flags.width = width;
      if (!isInt) this.buffer += '%!(BADWIDTH)';
      if (width !== undefined && width < 0) {
        this.flags.width = -width;
        this.flags.minus = true;
        this.flags.zero = false;
      }
      cursor.afterIndex = false;
      return;
    }
    const [width, next] = parseNumber(cursor.format, cursor.i);
    if (width !== undefined) {
      this.flags.width = width;
      if (cursor.afterIndex) cursor.goodArgNum = false;
    }
    cursor.i = next;
  }

  private readPrecision(cursor: Cursor): void {
    if (cursor.format[cursor.i] !== '.') return;
    cursor.i++;
    if (cursor.afterIndex) cursor.goodArgNum = false;
    this.readArgNumber(cursor);
    if (cursor.format[cursor.i] === '*') {
      cursor.i++;
      const [precision, isInt, nextArg] = intFromArg(cursor.args, cursor.argNum);
      cursor.argNum = nextArg;
      // A negative precision is as bad as a missing one.
      const negative = precision !== undefined && precision < 0;
      this.flags.precision = negative ? undefined : precision;
      if (!isInt || negative) this.buffer += '%!(BADPREC)';
      cursor.afterIndex = false;
      return;
    }
    const [precision, next] = parseNumber(cursor.format, cursor.i);
    this.flags.precision = precision ?? 0;
    cursor.i = next;
  }

  private printVerb(cursor: Cursor): void {
    const { size } = decodeRune(cursor.format, cursor.i);
    const verb = cursor.format.slice(cursor.i, cursor.i + size);
    cursor.i += size;
    if (this.flags.minus) this.flags.zero = false;
    if (verb === '%') {
      this.buffer += '%';
      return;
    }
    if (!cursor.goodArgNum) {
      this.buffer += `%!${verb}(BADINDEX)`;
      return;
    }
    if (cursor.argNum >= cursor.args.length) {
      this.buffer += `%!${verb}(MISSING)`;
      return;
    }
    const arg = cursor.args[cursor.argNum++];
    if (verb === 'w') {
      this.printWrapped(arg);
      return;
    }
    if (verb === 'v') this.useVerbFlags();
    this.printArg(arg, verb);
  }

  /** %w, which only Errorf accepts, for an error it then wraps; it prints as %v. */
  private printWrapped(arg: Value): void {
    const isError = arg instanceof Iface && !missingMethod(arg.type, ERROR_TYPE.underlying as never);
    if (!this.wrapErrors || !isError) {
      this.badVerb('w', (arg as Iface | undefined)?.value, (arg as Iface | undefined)?.type);
      return;
    }
    if (!this.wrapped.includes(arg)) this.wrapped.push(arg);
    this.useVerbFlags();
    this.printArg(arg, 'v');
  }

  /** For %v, # and + mean Go syntax and field names rather than their usual meanings. */
  private useVerbFlags(): void {
    if (this.flags.sharp) {
      this.flags.sharp = false;
      this.flags.sharpV = true;
    }
    if (this.flags.plus) {
      this.flags.plus = false;
      this.flags.plusV = true;
    }
  }

  private printExtra(extra: Value[]): void {
    this.flags = noFlags();
    this.buffer += '%!(EXTRA ';
    for (const [index, arg] of extra.entries()) {
      if (index > 0) this.buffer += ', ';
      if (arg === undefined) {
        this.buffer += '<nil>';
        continue;
      }
      this.buffer += `${typeString((arg as Iface).type)}=`;
      this.printArg(arg, 'v');
    }
    this.buffer += ')';
  }

  /** Reads an explicit argument index `[n]`, which turns the verb into a BADINDEX when it is out of range. */
  private argNumber(
    argNum: number,
    format: string,
    i: number,
    count: number,
    good: boolean
  ): [number, number, boolean, boolean] {
    if (i >= format.length || format[i] !== '[') return [argNum, i, false, good];
    const close = format.indexOf(']', i);
    if (close === -1) return [argNum, format.length, false, false];
    const text = format.slice(i + 1, close);
    const [index, next] = parseNumber(text, 0);
    if (index === undefined || next !== text.length || index < 1 || index > count) {
      return [argNum, close + 1, true, false];
    }
    return [index - 1, close + 1, true, good];
  }

  // Arguments -----------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 20 -- Go's printArg.
  private printArg(arg: Value, verb: string): void {
    if (arg === undefined) {
      if (verb === 'T' || verb === 'v') this.pad('<nil>');
      else this.badVerb(verb, undefined, undefined);
      return;
    }
    const iface = arg as Iface;
    if (verb === 'T') {
      this.fmtString(typeString(iface.type), 's');
      return;
    }
    if (verb === 'p') {
      if (['pointer', 'slice', 'map', 'func'].includes(underlying(iface.type).kind))
        this.fmtPointer(iface.value, iface.type, 'p');
      else this.badVerb('p', iface.value, iface.type);
      return;
    }
    if (this.handleMethods(iface, verb)) return;
    this.printValue(iface.value, iface.type, verb, 0);
  }

  /** Prints with the value's Error or String method, for the verbs that use them. */
  private handleMethods(iface: Iface, verb: string): boolean {
    if (this.flags.sharpV) return false;
    if (!['v', 's', 'x', 'X', 'q'].includes(verb)) return false;
    const errorMethod = !missingMethod(iface.type, ERROR_TYPE.underlying as never) ? 'Error' : undefined;
    const method = errorMethod ?? (!missingMethod(iface.type, STRINGER as never) ? 'String' : undefined);
    if (!method) return false;
    const call = dynamicMethod(iface.type, method);
    if (!call) return false;
    let text: string;
    this.depth++;
    try {
      if (this.depth > this.depthLimit) throw new RangeError('Maximum call stack size exceeded');
      const saved = this.flags;
      text = call(iface.value, []) as string;
      this.flags = saved;
    } catch (error) {
      if (!(error instanceof GoPanic)) throw error;
      this.catchPanic(iface, verb, method, error);
      return true;
    } finally {
      this.depth--;
    }
    this.fmtString(text, verb);
    return true;
  }

  private catchPanic(iface: Iface, verb: string, method: string, panic: GoPanic): void {
    // A nil pointer receiver that panics prints as <nil>.
    if (underlying(iface.type).kind === 'pointer' && iface.value === undefined) {
      this.buffer += '<nil>';
      return;
    }
    const saved = this.flags;
    this.flags = noFlags();
    this.buffer += `%!${verb}(PANIC=${method} method: `;
    this.printArg(panic.value, 'v');
    this.buffer += ')';
    this.flags = saved;
  }

  /** Go's printValue: a value by its kind, after its methods when it is nested inside another value. */
  private printValue(value: Value, type: Type, verb: string, depth: number): void {
    if (depth > 0 && this.printNestedWithMethods(value, type, verb)) return;
    const under = underlying(type);
    switch (under.kind) {
      case 'basic': {
        this.printBasic(value, under.basic, verb, type);
        return;
      }
      case 'map': {
        this.printMap(value as GoMap | undefined, type, under, verb, depth);
        return;
      }
      case 'struct': {
        this.printStruct(value as GoStruct, type, under, verb, depth);
        return;
      }
      case 'interface': {
        const inner = value as Iface | undefined;
        if (inner) this.printValue(inner.value, inner.type, verb, depth + 1);
        else this.buffer += this.flags.sharpV ? `${typeString(type)}(nil)` : '<nil>';
        return;
      }
      case 'array':
      case 'slice': {
        this.printList(value, type, under, verb, depth);
        return;
      }
      case 'pointer': {
        this.printPointer(value, type, under.element, verb, depth);
        return;
      }
      default: {
        this.fmtPointer(value, type, verb);
      }
    }
  }

  /** A nested value with an Error or String method prints with it, when reflection could call it. */
  private printNestedWithMethods(value: Value, type: Type, verb: string): boolean {
    if (value instanceof Iface) return this.handleMethods(value, verb);
    if (!this.canInterface || isInterfaceType(type)) return false;
    return this.handleMethods(new Iface(type, value), verb);
  }

  private printStruct(
    struct: GoStruct,
    type: Type,
    under: Extract<Type, { kind: 'struct' }>,
    verb: string,
    depth: number
  ): void {
    if (this.flags.sharpV) this.buffer += typeString(type);
    this.buffer += '{';
    for (const [index, field] of under.fields.entries()) {
      if (index > 0) this.buffer += this.flags.sharpV ? ', ' : ' ';
      if (this.flags.plusV || this.flags.sharpV) this.buffer += `${field.name}:`;
      this.withInterface(isExported(field.name), () =>
        this.printValue(struct.fields[index], field.type, verb, depth + 1)
      );
    }
    this.buffer += '}';
  }

  /** A pointer to a composite value prints as & and the value at the top level, and as an address elsewhere. */
  private printPointer(value: Value, type: Type, element: Type, verb: string, depth: number): void {
    const kind = underlying(element).kind;
    if (depth === 0 && value instanceof Pointer && ['array', 'slice', 'struct', 'map'].includes(kind)) {
      this.buffer += '&';
      this.printValue(value.load(), element, verb, depth + 1);
      return;
    }
    this.fmtPointer(value, type, verb);
  }

  /** Whether the value being printed can call methods, which unexported fields cannot, as reflection decides. */
  private canInterface = true;

  private withInterface(allowed: boolean, run: () => void): void {
    const saved = this.canInterface;
    this.canInterface = saved && allowed;
    try {
      run();
    } finally {
      this.canInterface = saved;
    }
  }

  private printMap(
    map: GoMap | undefined,
    type: Type,
    under: Extract<Type, { kind: 'map' }>,
    verb: string,
    depth: number
  ): void {
    if (this.flags.sharpV) {
      this.buffer += typeString(type);
      if (!map) {
        this.buffer += '(nil)';
        return;
      }
      this.buffer += '{';
    } else {
      this.buffer += 'map[';
    }
    const entries = [...(map?.entries.values() ?? [])].toSorted((a, b) => compareMapKeys(a.key, b.key, under.key));
    for (const [index, entry] of entries.entries()) {
      if (index > 0) this.buffer += this.flags.sharpV ? ', ' : ' ';
      this.printValue(entry.key, under.key, verb, depth + 1);
      this.buffer += ':';
      this.printValue(entry.value, under.value, verb, depth + 1);
    }
    this.buffer += this.flags.sharpV ? '}' : ']';
  }

  private printList(
    value: Value,
    type: Type,
    under: Extract<Type, { kind: 'array' | 'slice' }>,
    verb: string,
    depth: number
  ): void {
    const items = under.kind === 'array' ? (value as GoArray).elements : ((value as Slice | undefined)?.values() ?? []);
    const element = underlying(under.element);
    if (['s', 'q', 'x', 'X'].includes(verb) && element.kind === 'basic' && element.basic === 'uint8') {
      const bytes = items.map((item) => String.fromCharCode(Number(item as bigint))).join('');
      this.fmtBytes(bytes, verb, typeString(type));
      return;
    }
    if (this.flags.sharpV) {
      this.buffer += typeString(type);
      if (under.kind === 'slice' && value === undefined) {
        this.buffer += '(nil)';
        return;
      }
      this.buffer += '{';
      for (const [index, item] of items.entries()) {
        if (index > 0) this.buffer += ', ';
        this.printValue(item, under.element, verb, depth + 1);
      }
      this.buffer += '}';
      return;
    }
    this.buffer += '[';
    for (const [index, item] of items.entries()) {
      if (index > 0) this.buffer += ' ';
      this.printValue(item, under.element, verb, depth + 1);
    }
    this.buffer += ']';
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per basic kind.
  private printBasic(value: Value, kind: string, verb: string, type: Type): void {
    switch (kind) {
      case 'bool': {
        if (verb === 't' || verb === 'v') this.pad(value ? 'true' : 'false');
        else this.badVerb(verb, value, type);
        return;
      }
      case 'string': {
        this.fmtString(value as string, verb, value, type);
        return;
      }
      case 'float32':
      case 'float64': {
        this.fmtFloat(value as number, kind === 'float32' ? 32 : 64, verb, value, type);
        return;
      }
      case 'complex64':
      case 'complex128': {
        this.fmtComplex(value as Complex, kind === 'complex64' ? 32 : 64, verb, type);
        return;
      }
      default: {
        const signed = kind.startsWith('int');
        this.fmtInteger(value as bigint, signed, verb, kind === 'uintptr' && this.flags.sharpV, value, type);
      }
    }
  }

  // Basic formatting ------------------------------------------------------------------------------------------------

  private badVerb(verb: string, value: Value, type: Type | undefined): void {
    this.buffer += `%!${verb}(`;
    if (type === undefined) {
      this.buffer += '<nil>';
    } else {
      this.buffer += `${typeString(type)}=`;
      const saved = this.flags;
      this.flags = noFlags();
      this.printValue(value, type, 'v', 0);
      this.flags = saved;
    }
    this.buffer += ')';
  }

  /** Pads to the width with spaces, or zeros when the 0 flag asks, counting runes. */
  private pad(text: string): void {
    const { width, minus, zero } = this.flags;
    if (width === undefined || width === 0) {
      this.buffer += text;
      return;
    }
    const count = width - runesOf(text).length;
    if (count <= 0) {
      this.buffer += text;
      return;
    }
    const padding = (zero && !minus ? '0' : ' ').repeat(count);
    this.buffer += minus ? text + padding : padding + text;
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- Go's fmtInteger with its verbs, precision, and prefixes.
  private fmtInteger(
    value: bigint,
    signed: boolean,
    verb: string,
    sharpUintptr: boolean,
    raw: Value,
    type: Type
  ): void {
    let base = 10;
    let digits = LOWER_DIGITS;
    switch (verb) {
      case 'v': {
        if (this.flags.sharpV && !signed) {
          this.fmt0x64(value, true);
          return;
        }
        break;
      }
      case 'd': {
        break;
      }
      case 'b': {
        base = 2;
        break;
      }
      case 'o':
      case 'O': {
        base = 8;
        break;
      }
      case 'x': {
        base = 16;
        break;
      }
      case 'X': {
        base = 16;
        digits = UPPER_DIGITS;
        break;
      }
      case 'c': {
        this.pad(encodeRune(runeOf(value)));
        return;
      }
      case 'q': {
        this.pad(quoteRune(runeOf(value), this.flags.plus));
        return;
      }
      case 'U': {
        this.fmtUnicode(value);
        return;
      }
      default: {
        this.badVerb(verb, raw, type);
        return;
      }
    }
    void sharpUintptr;
    const negative = signed && value < 0n;
    let magnitude = negative ? -value : value;
    let precision = 0;
    const { width } = this.flags;
    if (this.flags.precision !== undefined) {
      precision = this.flags.precision;
      if (precision === 0 && magnitude === 0n) {
        const zero = this.flags.zero;
        this.flags.zero = false;
        this.buffer += ' '.repeat(Math.max(width ?? 0, 0));
        this.flags.zero = zero;
        return;
      }
    } else if (this.flags.zero && !this.flags.minus && width !== undefined) {
      precision = width;
      if (negative || this.flags.plus || this.flags.space) precision--;
    }
    let text = magnitude === 0n ? '0' : '';
    while (magnitude > 0n) {
      text = digits[Number(magnitude % BigInt(base))] + text;
      magnitude /= BigInt(base);
    }
    if (text.length < precision) text = '0'.repeat(precision - text.length) + text;
    if (this.flags.sharp) {
      if (base === 2) text = `0b${text}`;
      else if (base === 8 && !text.startsWith('0')) text = `0${text}`;
      else if (base === 16) text = `0${digits[16]}${text}`;
    }
    if (verb === 'O') text = `0o${text}`;
    if (negative) text = `-${text}`;
    else if (this.flags.plus) text = `+${text}`;
    else if (this.flags.space) text = ` ${text}`;
    const zero = this.flags.zero;
    this.flags.zero = false;
    this.pad(text);
    this.flags.zero = zero;
  }

  private fmt0x64(value: bigint, leading0x: boolean): void {
    const sharp = this.flags.sharp;
    this.flags.sharp = leading0x;
    this.fmtInteger(value, false, 'x', false, value, { kind: 'basic', basic: 'uint64', name: 'uint64' });
    this.flags.sharp = sharp;
  }

  private fmtUnicode(value: bigint): void {
    let text = value.toString(16).toUpperCase();
    const precision = Math.max(this.flags.precision ?? 4, 4);
    if (text.length < precision) text = '0'.repeat(precision - text.length) + text;
    text = `U+${text}`;
    const rune = Number(value);
    if (this.flags.sharp && value <= 0x10_ff_ffn && isPrint(rune)) text += ` '${encodeRune(rune)}'`;
    const zero = this.flags.zero;
    this.flags.zero = false;
    this.pad(text);
    this.flags.zero = zero;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Go's fmtFloat, including the sharp flag and special values.
  private fmtFloat(value: number, size: 32 | 64, verb: string, raw: Value, type: Type | undefined): void {
    let format = verb;
    let precision = this.flags.precision ?? -1;
    switch (verb) {
      case 'v': {
        format = 'g';
        precision = this.flags.precision ?? -1;
        break;
      }
      case 'b':
      case 'g':
      case 'G':
      case 'x':
      case 'X': {
        break;
      }
      case 'f':
      case 'e':
      case 'E':
      case 'F': {
        if (this.flags.precision === undefined) precision = 6;
        if (verb === 'F') format = 'f';
        break;
      }
      default: {
        this.badVerb(verb, raw, type);
        return;
      }
    }
    if (this.flags.sharpV) {
      format = 'g';
      precision = -1;
    }
    let num = formatFloat(value, format, precision, size);
    if (num[0] !== '-' && num[0] !== '+') num = `+${num}`;
    if (this.flags.space && num[0] === '+' && !this.flags.plus) num = ` ${num.slice(1)}`;
    if (num[1] === 'I' || num[1] === 'N') {
      const zero = this.flags.zero;
      this.flags.zero = false;
      if (num[1] === 'N' && !this.flags.space && !this.flags.plus) num = num.slice(1);
      this.pad(num);
      this.flags.zero = zero;
      return;
    }
    if (this.flags.sharp && format !== 'b') num = sharpFloat(num, format, precision);
    if (this.flags.plus || num[0] !== '+') {
      if (this.flags.zero && !this.flags.minus && this.flags.width !== undefined && this.flags.width > num.length) {
        this.buffer += num[0];
        this.buffer += '0'.repeat(this.flags.width - num.length);
        this.buffer += num.slice(1);
        return;
      }
      this.pad(num);
      return;
    }
    this.pad(num.slice(1));
  }

  private fmtComplex(value: Complex, size: 32 | 64, verb: string, type: Type): void {
    if (!['v', 'b', 'g', 'G', 'x', 'X', 'f', 'F', 'e', 'E'].includes(verb)) {
      this.badVerb(verb, value, type);
      return;
    }
    const saved = { ...this.flags };
    this.buffer += '(';
    this.fmtFloat(value.re, size, verb, value.re, undefined);
    this.flags.plus = true;
    this.fmtFloat(value.im, size, verb, value.im, undefined);
    this.buffer += 'i)';
    this.flags = saved;
  }

  private fmtString(text: string, verb: string, raw: Value = text, type?: Type): void {
    switch (verb) {
      case 'v': {
        if (this.flags.sharpV) this.fmtQ(text);
        else this.fmtS(text);
        return;
      }
      case 's': {
        this.fmtS(text);
        return;
      }
      case 'x':
      case 'X': {
        this.fmtSbx(text, verb === 'X' ? UPPER_DIGITS : LOWER_DIGITS);
        return;
      }
      case 'q': {
        this.fmtQ(text);
        return;
      }
      default: {
        this.badVerb(verb, raw, type ?? { kind: 'basic', basic: 'string', name: 'string' });
      }
    }
  }

  private truncate(text: string): string {
    const { precision } = this.flags;
    if (precision === undefined) return text;
    let index = 0;
    for (let count = 0; count < precision && index < text.length; count++) index += decodeRune(text, index).size;
    return text.slice(0, index);
  }

  private fmtS(text: string): void {
    this.pad(this.truncate(text));
  }

  private fmtQ(text: string): void {
    const truncated = this.truncate(text);
    if (this.flags.sharp && canBackquote(truncated)) {
      this.pad(`\`${truncated}\``);
      return;
    }
    this.pad(quote(truncated, '"', this.flags.plus));
  }

  private fmtBytes(bytes: string, verb: string, typeName: string): void {
    void typeName;
    switch (verb) {
      case 's': {
        this.fmtS(bytes);
        return;
      }
      case 'x':
      case 'X': {
        this.fmtSbx(bytes, verb === 'X' ? UPPER_DIGITS : LOWER_DIGITS);
        return;
      }
      case 'q': {
        this.fmtQ(bytes);
        return;
      }
    }
  }

  /** Hexadecimal of a string's bytes, with spaces between bytes for the space flag and 0x prefixes for #. */
  private fmtSbx(text: string, digits: string): void {
    let length = text.length;
    if (this.flags.precision !== undefined && this.flags.precision < length) length = this.flags.precision;
    let width = 2 * length;
    if (width > 0) {
      if (this.flags.space) {
        if (this.flags.sharp) width *= 2;
        width += length - 1;
      } else if (this.flags.sharp) {
        width += 2;
      }
    } else {
      if (this.flags.width !== undefined) this.buffer += ' '.repeat(this.flags.width);
      return;
    }
    const { width: fieldWidth, minus } = this.flags;
    if (fieldWidth !== undefined && fieldWidth > width && !minus) this.buffer += ' '.repeat(fieldWidth - width);
    let result = '';
    if (this.flags.sharp) result += `0${digits[16]}`;
    for (let index = 0; index < length; index++) {
      if (this.flags.space && index > 0) {
        result += ' ';
        if (this.flags.sharp) result += `0${digits[16]}`;
      }
      const byte = text.charCodeAt(index);
      result += digits[byte >> 4] + digits[byte & 0xf];
    }
    this.buffer += result;
    if (fieldWidth !== undefined && fieldWidth > width && minus) this.buffer += ' '.repeat(fieldWidth - width);
  }

  private fmtPointer(value: Value, type: Type, verb: string): void {
    const object = pointerObject(value);
    switch (verb) {
      case 'v': {
        if (this.flags.sharpV) {
          this.buffer += `(${typeString(type)})(`;
          this.buffer += object === undefined ? 'nil' : addressOf(object);
          this.buffer += ')';
        } else if (object === undefined) {
          this.pad('<nil>');
        } else {
          this.fmt0x64(BigInt(addressOf(object)), !this.flags.sharp);
        }
        return;
      }
      case 'p': {
        this.fmt0x64(BigInt(object === undefined ? 0 : addressOf(object)), !this.flags.sharp);
        return;
      }
      case 'b':
      case 'o':
      case 'd':
      case 'x':
      case 'X': {
        const address = BigInt(object === undefined ? 0 : addressOf(object));
        if (verb === 'x' || verb === 'X') this.fmtInteger(address, false, verb, false, address, type);
        else this.fmtInteger(address, false, verb, false, address, type);
        return;
      }
      default: {
        this.badVerb(verb, value, type);
      }
    }
  }
}

/** Parses a decimal number at `start`, returning undefined when no digits are there. */
function parseNumber(text: string, start: number): [number | undefined, number] {
  let index = start;
  let value = 0;
  while (index < text.length && text[index] >= '0' && text[index] <= '9') {
    // Go stops at absurdly large widths, treating them as missing.
    if (value > 1e6) return [undefined, text.length];
    value = value * 10 + Number(text[index]);
    index++;
  }
  return [index === start ? undefined : value, index];
}

/** Takes a width or precision from the arguments for `*`, which must be an int. */
function intFromArg(args: Value[], argNum: number): [number | undefined, boolean, number] {
  if (argNum >= args.length) return [undefined, false, argNum];
  const arg = args[argNum];
  if (arg instanceof Iface && arg.type.kind === 'basic' && /^u?int/.test(arg.type.basic)) {
    const value = Number(arg.value as bigint);
    if (value > 1e6 || value < -1e6) return [undefined, false, argNum + 1];
    return [value, true, argNum + 1];
  }
  return [undefined, false, argNum + 1];
}

function pointerObject(value: Value): object | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Pointer) return value.key === 'v' ? value.base : value.base;
  if (value instanceof Slice) return value.array;
  if (value instanceof GoMap || value instanceof GoFunc) return value;
  return value as object;
}

function isInterfaceType(type: Type): boolean {
  return underlying(type).kind === 'interface';
}

function runeOf(value: bigint): number {
  return value < 0n || value > 0x10_ff_ffn ? RUNE_ERROR : Number(value);
}

/** Go's handling of the # flag for floats: keep the decimal point and, for %g, the trailing zeros. */
function sharpFloat(num: string, format: string, precision: number): string {
  let digits = 0;
  if (format === 'g' || format === 'G' || format === 'v') {
    digits = precision < 0 ? 6 : precision;
    if (digits === 0) digits = 1;
  }
  let tail = '';
  const exponentIndex = num.search(/[eEpP]/);
  let body = num;
  if (exponentIndex >= 0) {
    tail = num.slice(exponentIndex);
    body = num.slice(0, exponentIndex);
  }
  let sawDot = body.includes('.');
  let sawNonzero = false;
  for (const char of body.slice(1)) {
    if (char === '.') continue;
    if (char !== '0') sawNonzero = true;
    if (sawNonzero || char !== '0') digits--;
    else if (char === '0' && sawNonzero) digits--;
  }
  if (!sawDot) {
    body += '.';
    sawDot = true;
  }
  if (format === 'g' || format === 'G') {
    // Count the significant digits already present to know how many zeros to add.
    const significant = body.slice(1).replace('.', '').replace(/^0+/, '').length;
    const wanted = (precision < 0 ? 6 : precision === 0 ? 1 : precision) - (significant === 0 ? 1 : significant);
    if (wanted > 0) body += '0'.repeat(wanted);
  }
  return body + tail;
}
