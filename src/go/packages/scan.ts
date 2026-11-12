import type { FuncEntity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, encodeRune } from '../literals';
import { type Type, typeString, underlying } from '../types';
import { Complex, type Iface, Pointer, type Value } from '../values';
import { EOF } from './io';
import { STRCONV_PACKAGE } from './strconv';
import { byteSlice } from './support';

/** `io.ErrUnexpectedEOF`, which a format that wants more input than there is reports. */
export const ERR_UNEXPECTED_EOF = newError('unexpected EOF');

const END = -1;
const HUGE_WIDTH = 1 << 30;
const SIGN = '+-';
const DECIMAL = '0123456789';
const BINARY = '01';
const OCTAL = '01234567';
const HEX = '0123456789aAbBcCdDeEfF';
const BOOL_ERROR = newError('syntax error scanning boolean');
const COMPLEX_ERROR = newError('syntax error scanning complex number');

/** A failure while scanning, which ends the scan with its error, as Go's scan panics with scanError. */
class ScanError {
  constructor(readonly error: Value) {}
}

/** Go's isSpace for scanning: the ASCII spaces and the Unicode ones it lists. */
function isSpace(rune: number): boolean {
  if (rune === 0x20 || (rune >= 0x09 && rune <= 0x0d) || rune === 0x85 || rune === 0xa0 || rune === 0x16_80)
    return true;
  if (rune >= 0x20_00 && rune <= 0x20_0a) return true;
  return rune === 0x20_28 || rune === 0x20_29 || rune === 0x20_2f || rune === 0x20_5f || rune === 0x30_00;
}

const strconvFunction = (name: string): NonNullable<FuncEntity['direct']> =>
  (STRCONV_PACKAGE.members.get(name) as FuncEntity).direct as NonNullable<FuncEntity['direct']>;

/** The state of one scan of a string: Go's ss, reading runes of UTF-8 bytes. */
class ScanState {
  private position = 0;
  private lastSize = 0;
  /** The number of runes read, which widths limit. */
  count = 0;
  argLimit = HUGE_WIDTH;
  buffer = '';

  constructor(
    private readonly input: string,
    private readonly nlIsSpace: boolean,
    readonly nlIsEnd: boolean
  ) {}

  getRune(): number {
    if (this.count >= this.argLimit || this.position >= this.input.length) {
      this.lastSize = 0;
      return END;
    }
    const { rune, size } = decodeRune(this.input, this.position);
    this.position += size;
    this.lastSize = size;
    this.count++;
    return rune;
  }

  unreadRune(): void {
    if (this.lastSize === 0) return;
    this.position -= this.lastSize;
    this.lastSize = 0;
    this.count--;
  }

  mustReadRune(): number {
    const rune = this.getRune();
    if (rune === END) throw new ScanError(ERR_UNEXPECTED_EOF);
    return rune;
  }

  fail(message: string): never {
    throw new ScanError(newError(message));
  }

  notEOF(): void {
    const rune = this.getRune();
    if (rune === END) throw new ScanError(EOF);
    this.unreadRune();
  }

  peek(characters: string): boolean {
    const rune = this.getRune();
    if (rune !== END) this.unreadRune();
    return rune !== END && characters.includes(String.fromCodePoint(rune));
  }

  /** Reads the next rune into the buffer when it is one of the characters. */
  accept(characters: string): boolean {
    const rune = this.getRune();
    if (rune === END) return false;
    if (characters.includes(String.fromCodePoint(rune))) {
      this.buffer += encodeRune(rune);
      return true;
    }
    this.unreadRune();
    return false;
  }

  skipSpace(): void {
    for (;;) {
      const rune = this.getRune();
      if (rune === END) return;
      if (rune === 0x0d && this.peek('\n')) continue;
      if (rune === 0x0a) {
        if (this.nlIsSpace) continue;
        this.fail('unexpected newline');
      }
      if (!isSpace(rune)) {
        this.unreadRune();
        return;
      }
    }
  }

  token(): string {
    this.skipSpace();
    let text = '';
    for (;;) {
      const rune = this.getRune();
      if (rune === END) break;
      if (isSpace(rune)) {
        this.unreadRune();
        break;
      }
      text += encodeRune(rune);
    }
    return text;
  }

  okVerb(verb: string, verbs: string, type: string): boolean {
    if (verbs.includes(verb)) return true;
    this.fail(`bad verb '%${verb}' for ${type}`);
  }

  // Values ------------------------------------------------------------------------------------------------------

  scanBool(verb: string): boolean {
    this.skipSpace();
    this.notEOF();
    if (!this.okVerb(verb, 'tv', 'boolean')) return false;
    switch (String.fromCodePoint(Math.max(this.getRune(), 0))) {
      case '0': {
        return false;
      }
      case '1': {
        return true;
      }
      case 't':
      case 'T': {
        if (this.accept('rR') && (!this.accept('uU') || !this.accept('eE'))) throw new ScanError(BOOL_ERROR);
        return true;
      }
      case 'f':
      case 'F': {
        if (this.accept('aA') && (!this.accept('lL') || !this.accept('sS') || !this.accept('eE')))
          throw new ScanError(BOOL_ERROR);
        return false;
      }
      default: {
        return false;
      }
    }
  }

  private digitsOf(verb: string, type: string): [number, string] {
    if (!this.okVerb(verb, 'bdoUxXv', type)) return [10, DECIMAL];
    if (verb === 'b') return [2, BINARY];
    if (verb === 'o') return [8, OCTAL];
    if (verb === 'x' || verb === 'X' || verb === 'U') return [16, HEX];
    return [10, DECIMAL];
  }

  private basePrefix(): [number, string, boolean] {
    if (!this.peek('0')) return [0, `${DECIMAL}_`, false];
    this.accept('0');
    if (this.peek('bB')) {
      this.accept('bB');
      return [0, `${BINARY}_`, true];
    }
    if (this.peek('oO')) {
      this.accept('oO');
      return [0, `${OCTAL}_`, true];
    }
    if (this.peek('xX')) {
      this.accept('xX');
      return [0, `${HEX}_`, true];
    }
    return [0, `${OCTAL}_`, true];
  }

  private number(digits: string, haveDigits: boolean): string {
    if (!haveDigits) {
      this.notEOF();
      if (!this.accept(digits)) this.fail('expected integer');
    }
    while (this.accept(digits));
    return this.buffer;
  }

  scanInteger(verb: string, bits: number, unsigned: boolean): bigint {
    if (verb === 'c') return this.scanRune(bits);
    this.skipSpace();
    this.notEOF();
    let [base, digits] = this.digitsOf(verb, unsigned ? 'unsigned integer' : 'integer');
    let haveDigits = false;
    this.buffer = '';
    if (verb === 'U') {
      if (!this.accept('U') || !this.accept('+')) this.fail('bad unicode format ');
      this.buffer = '';
    } else {
      if (!unsigned) this.accept(SIGN);
      if (verb === 'v') [base, digits, haveDigits] = this.basePrefix();
    }
    const token = this.number(digits, haveDigits);
    const [value, error] = strconvFunction(unsigned ? 'ParseUint' : 'ParseInt')(
      [token, BigInt(base), 64n],
      undefined
    ) as [bigint, Value];
    if (error !== undefined) throw new ScanError(error);
    const fits = unsigned ? BigInt.asUintN(bits, value) === value : BigInt.asIntN(bits, value) === value;
    if (!fits) this.fail(`${unsigned ? 'unsigned integer' : 'integer'} overflow on token ${token}`);
    return value;
  }

  private scanRune(bits: number): bigint {
    this.notEOF();
    const rune = BigInt(this.getRune());
    if (BigInt.asIntN(bits, rune) !== rune) this.fail(`overflow on character value ${rune}`);
    return rune;
  }

  private floatToken(): string {
    this.buffer = '';
    if (this.accept('nN') && this.accept('aA') && this.accept('nN')) return this.buffer;
    this.accept(SIGN);
    if (this.accept('iI') && this.accept('nN') && this.accept('fF')) return this.buffer;
    let digits = `${DECIMAL}_`;
    let exponent = 'eEpP';
    if (this.accept('0') && this.accept('xX')) {
      digits = `${HEX}_`;
      exponent = 'pP';
    }
    while (this.accept(digits));
    if (this.accept('.')) while (this.accept(digits));
    if (this.accept(exponent)) {
      this.accept(SIGN);
      while (this.accept(`${DECIMAL}_`));
    }
    return this.buffer;
  }

  scanFloat(verb: string, bits: number): number {
    if (!this.okVerb(verb, 'beEfFgGxXv', `float${bits}`)) return 0;
    this.skipSpace();
    this.notEOF();
    const token = this.floatToken();
    const [value, error] = strconvFunction('ParseFloat')([token, BigInt(bits)], undefined) as [number, Value];
    if (error !== undefined) throw new ScanError(error);
    return value;
  }

  scanString(verb: string): string {
    if (!this.okVerb(verb, 'svqxX', 'string')) return '';
    this.skipSpace();
    this.notEOF();
    if (verb === 'q') return this.quotedString();
    if (verb === 'x' || verb === 'X') return this.hexString();
    return this.token();
  }

  private quotedString(): string {
    this.notEOF();
    const quote = this.getRune();
    let text = encodeRune(quote);
    if (quote === 0x60) {
      for (;;) {
        const rune = this.mustReadRune();
        text += encodeRune(rune);
        if (rune === quote) break;
      }
    } else if (quote === 0x22) {
      for (;;) {
        const rune = this.mustReadRune();
        text += encodeRune(rune);
        if (rune === 0x5c) text += encodeRune(this.mustReadRune());
        else if (rune === quote) break;
      }
    } else {
      this.fail('expected quoted string');
    }
    const [value, error] = strconvFunction('Unquote')([text], undefined) as [string, Value];
    if (error !== undefined) throw new ScanError(error);
    return value;
  }

  private hexString(): string {
    let text = '';
    for (;;) {
      const high = this.getRune();
      if (high === END || !HEX.includes(String.fromCodePoint(high))) {
        if (high !== END) this.unreadRune();
        break;
      }
      const low = this.mustReadRune();
      if (!HEX.includes(String.fromCodePoint(low))) this.fail('illegal hex digit');
      text += String.fromCodePoint(Number.parseInt(String.fromCodePoint(high, low), 16));
    }
    if (text === '') this.fail('no hex data for %x string');
    return text;
  }

  /** Scans one operand, a pointer, by the kind of what it points to. */
  scanOne(verb: string, operand: Value): void {
    const iface = operand as Iface | undefined;
    const pointerType = iface && underlying(iface.type);
    if (!iface || pointerType?.kind !== 'pointer' || !(iface.value instanceof Pointer)) {
      this.fail(iface ? `type not a pointer: ${typeString(iface.type)}` : "can't scan type: <nil>");
    }
    const pointer = iface.value;
    const target = underlying(pointerType.element);
    pointer.store(this.valueOf(verb, target, pointerType.element));
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of operand, as Go's scanOne.
  private valueOf(verb: string, target: Type, type: Type): Value {
    if (target.kind === 'slice' && underlying(target.element).kind === 'basic') {
      const element = underlying(target.element) as { basic: string };
      if (element.basic === 'uint8') return this.byteSlice(verb);
    }
    if (target.kind !== 'basic') this.fail(`can't scan type: *${typeString(type)}`);
    const kind = target.basic;
    if (kind === 'bool') return this.scanBool(verb);
    if (kind === 'string') return this.scanString(verb);
    if (kind === 'float32' || kind === 'float64') {
      const value = this.scanFloat(verb, kind === 'float32' ? 32 : 64);
      return kind === 'float32' ? Math.fround(value) : value;
    }
    if (kind === 'complex64' || kind === 'complex128') return this.scanComplex(verb, kind === 'complex64' ? 32 : 64);
    const unsigned = kind.startsWith('uint');
    const bits = kind === 'int' || kind === 'uint' || kind === 'uintptr' ? 64 : Number(kind.replace(/^u?int/, ''));
    return this.scanInteger(verb, bits, unsigned);
  }

  private byteSlice(verb: string): Value {
    return byteSlice(this.scanString(verb));
  }

  private scanComplex(verb: string, bits: number): Complex {
    if (!this.okVerb(verb, 'beEfFgGxXv', 'complex')) return new Complex(0, 0);
    this.skipSpace();
    this.notEOF();
    const parenthesized = this.accept('(');
    const real = this.floatToken();
    this.buffer = '';
    if (!this.accept(SIGN)) throw new ScanError(COMPLEX_ERROR);
    const imaginarySign = this.buffer;
    const imaginary = this.floatToken();
    if (!this.accept('i')) throw new ScanError(COMPLEX_ERROR);
    if (parenthesized && !this.accept(')')) throw new ScanError(COMPLEX_ERROR);
    const parse = (text: string): number => {
      const [value, error] = strconvFunction('ParseFloat')([text, BigInt(bits)], undefined) as [number, Value];
      if (error !== undefined) throw new ScanError(error);
      return value;
    };
    return new Complex(parse(real), parse(imaginarySign + imaginary));
  }

  // Formats -----------------------------------------------------------------------------------------------------

  /** Go's advance: matches the format's spaces and literal characters with the input, up to the next verb. */
  // code-gauge-allow functionCognitiveComplexity 40 -- Transcribes Go's advance.
  advance(format: string): number {
    let index = 0;
    while (index < format.length) {
      let { rune: formatRune, size } = decodeRune(format, index);
      let sawSpace = false;
      let wasNewline = false;
      while (isSpace(formatRune) && index < format.length) {
        if (formatRune === 0x0a) {
          if (wasNewline) break;
          wasNewline = true;
        }
        sawSpace = true;
        index += size;
        ({ rune: formatRune, size } = index < format.length ? decodeRune(format, index) : { rune: END, size: 0 });
      }
      if (sawSpace) {
        let inputRune = this.getRune();
        if (inputRune === END) return index;
        if (!isSpace(inputRune)) this.fail('expected space in input to match format');
        while (inputRune !== 0x0a && isSpace(inputRune)) inputRune = this.getRune();
        if (inputRune === 0x0a) {
          if (!wasNewline) this.fail('newline in input does not match format');
          return index;
        }
        if (inputRune !== END) this.unreadRune();
        if (wasNewline) this.fail('newline in format does not match input');
        continue;
      }
      if (formatRune === 0x25) {
        if (index + size === format.length) this.fail('missing verb: % at end of format string');
        if (format[index + size] !== '%') return index;
        index += size;
      }
      const inputRune = this.mustReadRune();
      if (formatRune !== inputRune) {
        this.unreadRune();
        return -1;
      }
      index += size;
    }
    return index;
  }
}

function runScan(state: ScanState, scan: () => number): [bigint, Value] {
  let count = 0;
  try {
    count = scan();
    return [BigInt(count), undefined];
  } catch (error) {
    if (!(error instanceof ScanError)) throw error;
    return [BigInt(state.count === 0 && count === 0 ? 0 : count), error.error];
  }
}

/** `fmt.Sscan` and `fmt.Sscanln`: values separated by spaces, which for Sscanln end at a newline. */
export function sscan(input: string, operands: Value[], line: boolean): [bigint, Value] {
  const state = new ScanState(input, !line, line);
  let processed = 0;
  const [, error] = runScan(state, () => {
    for (const operand of operands) {
      state.scanOne('v', operand);
      processed++;
    }
    if (state.nlIsEnd) {
      for (;;) {
        const rune = state.getRune();
        if (rune === 0x0a || rune === END) break;
        if (!isSpace(rune)) state.fail('expected newline');
      }
    }
    return processed;
  });
  return [BigInt(processed), error];
}

/** `fmt.Sscanf`: values that the format's verbs describe, between the format's literal text. */
// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes Go's doScanf.
export function sscanf(input: string, format: string, operands: Value[]): [bigint, Value] {
  const state = new ScanState(input, false, false);
  let processed = 0;
  const [, error] = runScan(state, () => {
    const end = format.length - 1;
    for (let index = 0; index <= end;) {
      const advanced = state.advance(format.slice(index));
      if (advanced > 0) {
        index += advanced;
        continue;
      }
      if (format[index] !== '%') {
        if (advanced < 0) state.fail('input does not match format');
        break;
      }
      index++;
      const width = /^\d+/.exec(format.slice(index))?.[0];
      if (width) index += width.length;
      const { rune, size } = decodeRune(format, index);
      const verb = String.fromCodePoint(rune);
      index += size;
      if (verb !== 'c') state.skipSpace();
      if (verb === '%') {
        state.skipSpace();
        state.notEOF();
        if (!state.accept('%')) state.fail('missing literal %');
        continue;
      }
      state.argLimit = width ? state.count + Number(width) : HUGE_WIDTH;
      if (processed >= operands.length) {
        state.fail(`too few operands for format '%${format.slice(index - size)}'`);
      }
      state.scanOne(verb, operands[processed]);
      processed++;
      state.argLimit = HUGE_WIDTH;
    }
    if (processed < operands.length) state.fail('too many operands');
    return processed;
  });
  return [BigInt(processed), error];
}
