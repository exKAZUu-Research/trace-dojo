// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { assignFailure } from '../assignability';
import { newError } from '../errorValues';
import { decodeRune, encodeRune } from '../literals';
import { addMethod, currentRuntime, fn, namedType, opaqueType } from '../native';
import { nilPointerPanic } from '../runtimeErrors';
import {
  BASIC,
  type BasicKind,
  ERROR_TYPE,
  funcType,
  integerBits,
  pointerTo,
  RUNE,
  sliceOf,
  typeString,
  underlying,
} from '../types';
import { Cell, Complex, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { EOF, ERR_UNEXPECTED_EOF, IO_RUNE_SCANNER, sameError } from './io';
import { parseFloat, parseInt, parseUint, renamed, unquoteLiteral } from './strconv';
import { byteSlice, callFunction, callMethod, receiverStruct } from './support';
import { fullRune } from './unicode';

const EOF_RUNE = -1;
const RUNE_PREDICATE = funcType([RUNE], [BASIC.bool]);

export const SCAN_STATE = namedType('fmt', 'ScanState', {
  kind: 'interface',
  methods: [
    { name: 'Read', type: fn([sliceOf(BASIC.uint8)], [BASIC.int, ERROR_TYPE]) },
    { name: 'ReadRune', type: fn([], [RUNE, BASIC.int, ERROR_TYPE]) },
    { name: 'SkipSpace', type: fn([], []) },
    { name: 'Token', type: fn([BASIC.bool, RUNE_PREDICATE], [sliceOf(BASIC.uint8), ERROR_TYPE]) },
    { name: 'UnreadRune', type: fn([], [ERROR_TYPE]) },
    { name: 'Width', type: fn([], [BASIC.int, BASIC.bool]) },
  ],
});
export const SCANNER = namedType('fmt', 'Scanner', {
  kind: 'interface',
  methods: [{ name: 'Scan', type: fn([SCAN_STATE, RUNE], [ERROR_TYPE]) }],
});

/** `*fmt.ss`, the scanner that a Scan method receives as its fmt.ScanState. */
const SS = opaqueType(namedType('fmt', 'ss', { kind: 'struct', fields: [] }));
const stateOf = (receiver: Value): ScanState => receiverStruct(receiver).native?.state as ScanState;
const ERR_READ = newError("ScanState's Read should not be called. Use ReadRune");
addMethod(SS, 'Read', fn([sliceOf(BASIC.uint8)], [BASIC.int, ERROR_TYPE]), () => [0n, ERR_READ], true);
addMethod(SS, 'ReadRune', fn([], [RUNE, BASIC.int, ERROR_TYPE]), (receiver) => stateOf(receiver).userReadRune(), true);
addMethod(
  SS,
  'UnreadRune',
  fn([], [ERROR_TYPE]),
  (receiver) => {
    stateOf(receiver).userUnreadRune();
    return;
  },
  true
);
addMethod(
  SS,
  'SkipSpace',
  fn([], []),
  (receiver) => {
    stateOf(receiver).userSkipSpace();
    return [];
  },
  true
);
addMethod(SS, 'Width', fn([], [BASIC.int, BASIC.bool]), (receiver) => stateOf(receiver).userWidth(), true);
addMethod(
  SS,
  'Token',
  fn([BASIC.bool, RUNE_PREDICATE], [sliceOf(BASIC.uint8), ERROR_TYPE]),
  (receiver, [skip, accept]) => stateOf(receiver).userToken(skip as boolean, accept),
  true
);
const HUGE_WID = 1 << 30;
const FLOAT_VERBS = 'beEfFgGv';
const DECIMAL_DIGITS = '0123456789';
const HEXADECIMAL_DIGITS = '0123456789aAbBcCdDeEfF';
const ERR_BOOL = newError('syntax error scanning boolean');
const ERR_COMPLEX = newError('syntax error scanning complex number');

export function sscan(text: string, args: Value[], mode: 'scan' | 'scanln'): Value[] {
  return result(new ScanState(stringScanner(text), mode === 'scan', mode === 'scanln').scan(args));
}

export function sscanf(text: string, format: string, args: Value[]): Value[] {
  return result(new ScanState(stringScanner(text), false, false).scanf(format, args));
}

export function fscan(reader: Value, args: Value[], mode: 'scan' | 'scanln'): Value[] {
  return result(new ScanState(readerScanner(reader), mode === 'scan', mode === 'scanln').scan(args));
}

export function fscanf(reader: Value, format: string, args: Value[]): Value[] {
  return result(new ScanState(readerScanner(reader), false, false).scanf(format, args));
}

function result([count, error]: [number, Value]): Value[] {
  return [BigInt(count), error];
}

/** What Go's scanner panics with to stop: a scanError carrying an error, or io.EOF itself. */
class ScanStop {
  constructor(readonly error: Value) {}
}

interface RuneScanner {
  readRune(): [number, Value];
  unreadRune(): void;
  /** The size in bytes of the rune that readRune returned last. */
  lastSize: number;
}

/** Go's `readRune`, which reads a rune a byte at a time from a source that cannot unread. */
class ByteRuneScanner implements RuneScanner {
  lastSize = 0;
  private readonly pending: number[] = [];
  private peekRune = -1;
  private peekSize = 0;

  constructor(private readonly readByte: () => [number, Value]) {}

  readRune(): [number, Value] {
    if (this.peekRune >= 0) {
      const rune = this.peekRune;
      this.peekRune = ~rune;
      this.lastSize = this.peekSize;
      return [rune, undefined];
    }
    const [first, error] = this.nextByte();
    if (error !== undefined) return [0, error];
    if (first < 0x80) {
      this.peekRune = ~first;
      this.lastSize = this.peekSize = 1;
      return [first, undefined];
    }
    let bytes = String.fromCharCode(first);
    while (!fullRune(bytes)) {
      const [byte, byteError] = this.nextByte();
      if (byteError !== undefined) {
        if (sameError(byteError, EOF)) break;
        return [0, byteError];
      }
      bytes += String.fromCharCode(byte);
    }
    const { rune, size } = decodeRune(bytes, 0);
    for (let at = size; at < bytes.length; at++) this.pending.push(bytes.charCodeAt(at));
    this.peekRune = ~rune;
    this.lastSize = this.peekSize = size;
    return [rune, undefined];
  }

  unreadRune(): void {
    if (this.peekRune < 0) this.peekRune = ~this.peekRune;
  }

  private nextByte(): [number, Value] {
    const pending = this.pending.shift();
    return pending === undefined ? this.readByte() : [pending, undefined];
  }
}

function stringScanner(text: string): RuneScanner {
  let at = 0;
  return new ByteRuneScanner(() => (at < text.length ? [text.charCodeAt(at++), undefined] : [0, EOF]));
}

/** The scanner of an io.Reader: its own ReadRune and UnreadRune when it has them, as io.RuneScanner does. */
function readerScanner(reader: Value): RuneScanner {
  if (reader instanceof Iface && assignFailure(reader.type, IO_RUNE_SCANNER) === undefined) {
    const scanner: RuneScanner = {
      lastSize: 0,
      readRune: () => {
        const [rune, size, error] = callMethod(reader, 'ReadRune') as [bigint, bigint, Value];
        scanner.lastSize = Number(size);
        return [Number(rune), error];
      },
      unreadRune: () => {
        callMethod(reader, 'UnreadRune');
      },
    };
    return scanner;
  }
  const buffer = new Slice([0n], 0, 1, 1);
  return new ByteRuneScanner(() => {
    // io.ReadFull(reader, buffer): Read until one byte or an error arrives.
    for (;;) {
      currentRuntime().spend();
      const [count, error] = callMethod(reader, 'Read', [buffer]) as [bigint, Value];
      if (count >= 1n) return [Number(buffer.get(0) as bigint), undefined];
      if (error !== undefined) return [0, error];
    }
  });
}

function isSpace(rune: number): boolean {
  if (rune >= 1 << 16) return false;
  return (
    (rune >= 0x09 && rune <= 0x0d) ||
    rune === 0x20 ||
    rune === 0x85 ||
    rune === 0xa0 ||
    rune === 0x16_80 ||
    (rune >= 0x20_00 && rune <= 0x20_0a) ||
    rune === 0x20_28 ||
    rune === 0x20_29 ||
    rune === 0x20_2f ||
    rune === 0x20_5f ||
    rune === 0x30_00
  );
}

function indexRune(text: string, rune: number): number {
  for (let at = 0; at < text.length;) {
    const decoded = decodeRune(text, at);
    if (decoded.rune === rune) return at;
    at += decoded.size;
  }
  return -1;
}

/** Go's `ss`: the state of one scanning call. */
class ScanState {
  private count = 0;
  private atEOF = false;
  private buf = '';
  private argLimit = HUGE_WID;
  private readonly limit = HUGE_WID;
  private maxWid = HUGE_WID;

  constructor(
    private readonly rs: RuneScanner,
    private readonly nlIsSpace: boolean,
    private readonly nlIsEnd: boolean
  ) {}

  /** `doScan`, for Fscan and Fscanln. */
  scan(args: Value[]): [number, Value] {
    let processed = 0;
    return this.recovering(
      () => processed,
      () => {
        for (const arg of args) {
          this.scanOne(0x76, arg);
          processed++;
        }
        if (this.nlIsEnd) {
          for (;;) {
            const rune = this.getRune();
            if (rune === 0x0a || rune === EOF_RUNE) break;
            if (!isSpace(rune)) {
              this.errorString('expected newline');
              break;
            }
          }
        }
      }
    );
  }

  /** `doScanf`. */
  scanf(format: string, args: Value[]): [number, Value] {
    let processed = 0;
    return this.recovering(
      () => processed,
      () => {
        const end = format.length - 1;
        for (let index = 0; index <= end;) {
          const advanced = this.advance(format.slice(index));
          if (advanced > 0) {
            index += advanced;
            continue;
          }
          if (format[index] !== '%') {
            if (advanced < 0) this.errorString('input does not match format');
            break;
          }
          index++;
          const [width, widthPresent, next] = parsenum(format, index, end);
          index = next;
          this.maxWid = widthPresent ? width : HUGE_WID;
          const { rune: verb, size } = decodeRune(format, index);
          index += size;
          if (verb !== 0x63) this.skipSpace();
          if (verb === 0x25) {
            this.scanPercent();
            continue;
          }
          this.argLimit = this.limit;
          if (this.count + this.maxWid < this.argLimit) this.argLimit = this.count + this.maxWid;
          if (processed >= args.length) {
            this.errorString(`too few operands for format '%${format.slice(index - size)}'`);
            break;
          }
          this.scanOne(verb, args[processed]);
          processed++;
          this.argLimit = this.limit;
        }
        if (processed < args.length) this.errorString('too many operands');
      }
    );
  }

  // fmt.ScanState, for the Scan methods of fmt.Scanner values ----------------------------------------------------

  userReadRune(): Value[] {
    const [rune, error] = this.readRune();
    return error === undefined ? [BigInt(rune), BigInt(this.rs.lastSize), undefined] : [0n, 0n, error];
  }

  userUnreadRune(): void {
    this.unreadRune();
  }

  userSkipSpace(): void {
    this.skipSpace();
  }

  userWidth(): Value[] {
    return this.maxWid === HUGE_WID ? [0n, false] : [BigInt(this.maxWid), true];
  }

  /** `ss.Token`, which returns a scanning error instead of stopping the scan. */
  userToken(skipSpace: boolean, accept: Value): Value[] {
    try {
      this.buf = '';
      const test =
        accept === undefined
          ? (rune: number) => !isSpace(rune)
          : (rune: number) => callFunction(accept, [BigInt(rune)]) === true;
      const token = this.token(skipSpace, test);
      return [token === '' ? undefined : byteSlice(token), undefined];
    } catch (error) {
      if (error instanceof ScanStop) return [undefined, error.error];
      throw error;
    }
  }

  private recovering(processed: () => number, run: () => void): [number, Value] {
    try {
      run();
      return [processed(), undefined];
    } catch (error) {
      if (error instanceof ScanStop) return [processed(), error.error];
      throw error;
    }
  }

  private readRune(): [number, Value] {
    if (this.atEOF || this.count >= this.argLimit) return [0, EOF];
    currentRuntime().spend();
    const [rune, error] = this.rs.readRune();
    if (error === undefined) {
      this.count++;
      if (this.nlIsEnd && rune === 0x0a) this.atEOF = true;
    } else if (sameError(error, EOF)) {
      this.atEOF = true;
    }
    return [rune, error];
  }

  private getRune(): number {
    const [rune, error] = this.readRune();
    if (error !== undefined) {
      if (sameError(error, EOF)) return EOF_RUNE;
      throw new ScanStop(error);
    }
    return rune;
  }

  private mustReadRune(): number {
    const rune = this.getRune();
    if (rune === EOF_RUNE) throw new ScanStop(ERR_UNEXPECTED_EOF);
    return rune;
  }

  private unreadRune(): void {
    this.rs.unreadRune();
    this.atEOF = false;
    this.count--;
  }

  private errorString(text: string): never {
    throw new ScanStop(newError(text));
  }

  private skipSpace(): void {
    for (;;) {
      const rune = this.getRune();
      if (rune === EOF_RUNE) return;
      if (rune === 0x0d && this.peek('\n')) continue;
      if (rune === 0x0a) {
        if (this.nlIsSpace) continue;
        this.errorString('unexpected newline');
      }
      if (!isSpace(rune)) {
        this.unreadRune();
        break;
      }
    }
  }

  private token(skipSpace: boolean, accept: (rune: number) => boolean): string {
    if (skipSpace) this.skipSpace();
    for (;;) {
      const rune = this.getRune();
      if (rune === EOF_RUNE) break;
      if (!accept(rune)) {
        this.unreadRune();
        break;
      }
      this.writeRune(rune);
    }
    return this.buf;
  }

  private writeRune(rune: number): void {
    const encoded = encodeRune(rune);
    currentRuntime().checkStringLength(this.buf.length + encoded.length);
    this.buf += encoded;
  }

  private consume(ok: string, accept: boolean): boolean {
    const rune = this.getRune();
    if (rune === EOF_RUNE) return false;
    if (indexRune(ok, rune) >= 0) {
      if (accept) this.writeRune(rune);
      return true;
    }
    if (accept) this.unreadRune();
    return false;
  }

  private peek(ok: string): boolean {
    const rune = this.getRune();
    if (rune !== EOF_RUNE) this.unreadRune();
    return indexRune(ok, rune) >= 0;
  }

  private notEOF(): void {
    if (this.getRune() === EOF_RUNE) throw new ScanStop(EOF);
    this.unreadRune();
  }

  private accept(ok: string): boolean {
    return this.consume(ok, true);
  }

  private okVerb(verb: number, okVerbs: string, type: string): boolean {
    if (indexRune(okVerbs, verb) >= 0) return true;
    this.errorString(`bad verb '%${encodeRune(verb)}' for ${type}`);
  }

  private scanBool(verb: number): boolean {
    this.skipSpace();
    this.notEOF();
    this.okVerb(verb, 'tv', 'boolean');
    switch (this.getRune()) {
      case 0x31: {
        return true;
      }
      case 0x74:
      case 0x54: {
        if (this.accept('rR') && (!this.accept('uU') || !this.accept('eE'))) throw new ScanStop(ERR_BOOL);
        return true;
      }
      case 0x66:
      case 0x46: {
        if (this.accept('aA') && (!this.accept('lL') || !this.accept('sS') || !this.accept('eE')))
          throw new ScanStop(ERR_BOOL);
        return false;
      }
      default: {
        return false;
      }
    }
  }

  private getBase(verb: number): [number, string] {
    this.okVerb(verb, 'bdoUxXv', 'integer');
    switch (verb) {
      case 0x62: {
        return [2, '01'];
      }
      case 0x6f: {
        return [8, '01234567'];
      }
      case 0x78:
      case 0x58:
      case 0x55: {
        return [16, HEXADECIMAL_DIGITS];
      }
      default: {
        return [10, DECIMAL_DIGITS];
      }
    }
  }

  private scanNumber(digits: string, haveDigits: boolean): string {
    if (!haveDigits) {
      this.notEOF();
      if (!this.accept(digits)) this.errorString('expected integer');
    }
    while (this.accept(digits));
    return this.buf;
  }

  private scanRune(bits: number): bigint {
    this.notEOF();
    const rune = this.getRune();
    if (BigInt.asIntN(bits, BigInt(rune)) !== BigInt(rune))
      this.errorString(`overflow on character value ${encodeRune(rune)}`);
    return BigInt(rune);
  }

  private scanBasePrefix(): [number, string, boolean] {
    if (!this.peek('0')) return [0, `${DECIMAL_DIGITS}_`, false];
    this.accept('0');
    if (this.peek('bB')) {
      this.consume('bB', true);
      return [0, '01_', true];
    }
    if (this.peek('oO')) {
      this.consume('oO', true);
      return [0, '01234567_', true];
    }
    if (this.peek('xX')) {
      this.consume('xX', true);
      return [0, `${HEXADECIMAL_DIGITS}_`, true];
    }
    return [0, '01234567_', true];
  }

  private scanInteger(verb: number, bits: number, signed: boolean): bigint {
    if (verb === 0x63) {
      const rune = this.scanRune(bits);
      return signed ? rune : BigInt.asUintN(64, rune);
    }
    this.skipSpace();
    this.notEOF();
    let [base, digits] = this.getBase(verb);
    let haveDigits = false;
    if (verb === 0x55) {
      if (!this.consume('U', false) || !this.consume('+', false)) this.errorString('bad unicode format ');
    } else {
      if (signed) this.accept('+-');
      if (verb === 0x76) [base, digits, haveDigits] = this.scanBasePrefix();
    }
    const token = this.scanNumber(digits, haveDigits);
    const [value, error] = signed ? parseInt(token, base, 64, 'ParseInt') : parseUint(token, base, 64, 'ParseUint');
    if (error !== undefined) throw new ScanStop(error);
    const fits = signed ? BigInt.asIntN(bits, value) === value : BigInt.asUintN(bits, value) === value;
    if (!fits) this.errorString(`${signed ? '' : 'unsigned '}integer overflow on token ${token}`);
    return value;
  }

  private floatToken(): string {
    this.buf = '';
    if (this.accept('nN') && this.accept('aA') && this.accept('nN')) return this.buf;
    this.accept('+-');
    if (this.accept('iI') && this.accept('nN') && this.accept('fF')) return this.buf;
    let digits = `${DECIMAL_DIGITS}_`;
    let exponent = 'eEpP';
    if (this.accept('0') && this.accept('xX')) {
      digits = `${HEXADECIMAL_DIGITS}_`;
      exponent = 'pP';
    }
    while (this.accept(digits));
    if (this.accept('.')) while (this.accept(digits));
    if (this.accept(exponent)) {
      this.accept('+-');
      while (this.accept(`${DECIMAL_DIGITS}_`));
    }
    return this.buf;
  }

  private complexTokens(): [string, string] {
    const parens = this.accept('(');
    const real = this.floatToken();
    this.buf = '';
    if (!this.accept('+-')) throw new ScanStop(ERR_COMPLEX);
    const imagSign = this.buf;
    const imag = this.floatToken();
    if (!this.accept('i')) throw new ScanStop(ERR_COMPLEX);
    if (parens && !this.accept(')')) throw new ScanStop(ERR_COMPLEX);
    return [real, imagSign + imag];
  }

  private convertFloat(text: string, bits: number): number {
    const p = indexRune(text, 0x70);
    if (p >= 0 && !/[xX]/.test(text)) {
      const [mantissa, error] = parseFloat(text.slice(0, p), bits);
      if (error !== undefined) throw new ScanStop(renamed(error, 'ParseFloat', text));
      const [exponent, exponentError] = parseInt(text.slice(p + 1), 10, 0, 'Atoi');
      if (exponentError !== undefined) throw new ScanStop(renamed(exponentError, 'Atoi', text));
      return ldexp(mantissa, Number(exponent));
    }
    const [value, error] = parseFloat(text, bits);
    if (error !== undefined) throw new ScanStop(error);
    return value;
  }

  private scanComplex(verb: number, bits: number): Complex {
    this.okVerb(verb, FLOAT_VERBS, 'complex');
    this.skipSpace();
    this.notEOF();
    const [real, imag] = this.complexTokens();
    return new Complex(this.convertFloat(real, bits / 2), this.convertFloat(imag, bits / 2));
  }

  private scanFloat(verb: number, kind: string, bits: number): number {
    if (kind) this.okVerb(verb, FLOAT_VERBS, kind);
    this.skipSpace();
    this.notEOF();
    const value = this.convertFloat(this.floatToken(), bits);
    return bits === 32 ? Math.fround(value) : value;
  }

  private convertString(verb: number): string {
    this.okVerb(verb, 'svqxX', 'string');
    this.skipSpace();
    this.notEOF();
    if (verb === 0x71) return this.quotedString();
    if (verb === 0x78 || verb === 0x58) return this.hexString();
    return this.token(true, (rune) => !isSpace(rune));
  }

  private quotedString(): string {
    this.notEOF();
    const quote = this.getRune();
    if (quote === 0x60) {
      for (;;) {
        const rune = this.mustReadRune();
        if (rune === quote) break;
        this.writeRune(rune);
      }
      return this.buf;
    }
    if (quote === 0x22) {
      this.buf += '"';
      for (;;) {
        const rune = this.mustReadRune();
        this.writeRune(rune);
        if (rune === 0x5c) this.writeRune(this.mustReadRune());
        else if (rune === 0x22) break;
      }
      const [result, error] = unquoteLiteral(this.buf);
      if (error !== undefined) throw new ScanStop(error);
      return result;
    }
    this.errorString('expected quoted string');
  }

  private hexByte(): number | undefined {
    const first = this.getRune();
    if (first === EOF_RUNE) return undefined;
    const high = hexDigit(first);
    if (high === undefined) {
      this.unreadRune();
      return undefined;
    }
    const low = hexDigit(this.mustReadRune());
    if (low === undefined) this.errorString('illegal hex digit');
    return (high << 4) | low;
  }

  private hexString(): string {
    this.notEOF();
    for (;;) {
      const byte = this.hexByte();
      if (byte === undefined) break;
      this.buf += String.fromCharCode(byte);
    }
    if (this.buf.length === 0) this.errorString('no hex data for %x string');
    return this.buf;
  }

  private scanPercent(): void {
    this.skipSpace();
    this.notEOF();
    if (!this.accept('%')) this.errorString('missing literal %');
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of destination, as Go's scanOne.
  private scanOne(verb: number, arg: Value): void {
    this.buf = '';
    if (arg instanceof Iface && assignFailure(arg.type, SCANNER) === undefined) {
      const state = new Iface(pointerTo(SS), new Pointer(new Cell(new GoStruct([], { state: this })), 'v'));
      const error = callMethod(arg, 'Scan', [state, BigInt(verb)]) as Value;
      if (error !== undefined) throw new ScanStop(sameError(error, EOF) ? ERR_UNEXPECTED_EOF : error);
      return;
    }
    const type = arg instanceof Iface ? arg.type : undefined;
    const pointerType = type && underlying(type);
    if (!type || pointerType?.kind !== 'pointer') {
      this.errorString(`type not a pointer: ${type ? typeString(type) : '<nil>'}`);
    }
    const element = underlying(pointerType.element);
    const store = (value: Value): void => {
      const pointer = (arg as Iface).value;
      if (!(pointer instanceof Pointer)) nilPointerPanic();
      pointer.store(value);
    };
    const cantScan = (): never => this.errorString(`can't scan type: ${typeString(type)}`);
    if (element.kind === 'slice') {
      const byteElement = underlying(element.element);
      if (byteElement.kind !== 'basic' || byteElement.basic !== 'uint8') cantScan();
      const text = this.convertString(verb);
      currentRuntime().allocate(text.length);
      const bytes = Array.from(text, (char): Value => BigInt(char.charCodeAt(0)));
      store(new Slice(bytes, 0, bytes.length, bytes.length));
      return;
    }
    if (element.kind !== 'basic') return cantScan();
    const kind: BasicKind = element.basic;
    switch (kind) {
      case 'bool': {
        store(this.scanBool(verb));
        return;
      }
      case 'string': {
        store(this.convertString(verb));
        return;
      }
      case 'float32':
      case 'float64': {
        // Go checks the verb only for the unnamed float types, reached without reflection.
        const named = pointerType.element.kind === 'named';
        store(this.scanFloat(verb, named ? '' : kind, kind === 'float32' ? 32 : 64));
        return;
      }
      case 'complex64':
      case 'complex128': {
        store(this.scanComplex(verb, kind === 'complex64' ? 64 : 128));
        return;
      }
      default: {
        if (!/^u?int/.test(kind)) cantScan();
        const { bits, signed } = integerBits(kind);
        store(this.scanInteger(verb, bits, signed));
      }
    }
  }

  private advance(format: string): number {
    let index = 0;
    while (index < format.length) {
      let { rune: fmtc, size } = decodeRune(format, index);
      if (isSpace(fmtc)) {
        let newlines = 0;
        let trailingSpace = false;
        while (isSpace(fmtc) && index < format.length) {
          if (fmtc === 0x0a) {
            newlines++;
            trailingSpace = false;
          } else {
            trailingSpace = true;
          }
          index += size;
          ({ rune: fmtc, size } = index < format.length ? decodeRune(format, index) : { rune: 0xff_fd, size: 0 });
        }
        for (let line = 0; line < newlines; line++) {
          let input = this.getRune();
          while (isSpace(input) && input !== 0x0a) input = this.getRune();
          if (input !== 0x0a && input !== EOF_RUNE) this.errorString('newline in format does not match input');
        }
        if (trailingSpace) {
          let input = this.getRune();
          if (newlines === 0) {
            if (!isSpace(input) && input !== EOF_RUNE) this.errorString('expected space in input to match format');
            if (input === 0x0a) this.errorString('newline in input does not match format');
          }
          while (isSpace(input) && input !== 0x0a) input = this.getRune();
          if (input !== EOF_RUNE) this.unreadRune();
        }
        continue;
      }
      if (fmtc === 0x25) {
        if (index + size === format.length) this.errorString('missing verb: % at end of format string');
        const next = decodeRune(format, index + size).rune;
        if (next !== 0x25) return index;
        index += size;
      }
      const input = this.mustReadRune();
      if (fmtc !== input) {
        this.unreadRune();
        return -1;
      }
      index += size;
    }
    return index;
  }
}

function hexDigit(rune: number): number | undefined {
  if (rune >= 0x30 && rune <= 0x39) return rune - 0x30;
  if (rune >= 0x61 && rune <= 0x66) return rune - 0x61 + 10;
  if (rune >= 0x41 && rune <= 0x46) return rune - 0x41 + 10;
  return undefined;
}

/** Go's `parsenum`, which reads digits before `end` and gives up on absurdly large numbers. */
function parsenum(text: string, start: number, end: number): [number, boolean, number] {
  if (start >= end) return [0, false, end];
  let value = 0;
  let present = false;
  let index = start;
  for (; index < end && text[index] >= '0' && text[index] <= '9'; index++) {
    if (value > 1e6) return [0, false, end];
    value = value * 10 + Number(text[index]);
    present = true;
  }
  return [value, present, index];
}

function ldexp(fraction: number, exponent: number): number {
  let value = fraction;
  let rest = exponent;
  while (rest > 1000) {
    value *= 2 ** 1000;
    rest -= 1000;
  }
  while (rest < -1000) {
    value *= 2 ** -1000;
    rest += 1000;
  }
  return value * 2 ** rest;
}
