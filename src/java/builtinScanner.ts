import type { TextReader } from '../interpreter/programIo';
import {
  classOf,
  classType,
  filePathOf,
  type IOContext,
  openFileReader,
  pathTextOf,
  ReadAheadSource,
  type ReadSource,
  readSourceOf,
  TextSource,
  withNioErrors,
} from './builtinIoSupport';
import { addConstructor, addMethod, newString } from './builtinSupport';
import { decimalDigitValue, JAVA_WHITESPACE } from './builtinWrappers';
import { type Frame, JavaThrow, throwBuiltin } from './runtime';
import { BOOLEAN, type ClassInfo, DOUBLE, INT, type JavaType, LONG, VOID } from './types';
import { type JavaObject, JavaString, type Value } from './values';

const WHITESPACE = new RegExp(JAVA_WHITESPACE, 'u');
/** The line terminators of `Scanner.nextLine`. */
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029\u0085]/g;
/**
 * An integer as `Scanner` reads one in an English locale, with an optional sign and optional thousands groups, whose
 * digits may be any Unicode decimal digits, such as the full-width digits of Japanese text.
 */
const INTEGER = /^[+-]?(?:\p{Nd}+|\p{Nd}{1,3}(?:,\p{Nd}{3})+)$/u;
const DECIMAL =
  /^[+-]?(?:(?:(?:\p{Nd}+|\p{Nd}{1,3}(?:,\p{Nd}{3})+)(?:\.\p{Nd}*)?|\.\p{Nd}+)(?:[eE][+-]?\p{Nd}+)?|NaN|Infinity)$/u;
const BOOLEAN_TOKEN = /^(?:true|false)$/i;

/** The size of a scanner's buffer, which it fills from its source as it needs input. */
const SCANNER_BUFFER_SIZE = 1024;

/** A scanner's buffer, whose text and position are those of the reader of its read-ahead source. */
class ScannerState {
  isClosed = false;
  private readonly text: TextReader;

  constructor(
    frame: Frame,
    readonly source: ReadAheadSource
  ) {
    this.text = source.reader(frame);
  }

  get buffer(): string {
    return this.text.text;
  }

  get position(): number {
    return this.text.position;
  }

  set position(position: number) {
    this.text.position = position;
  }
}

const scannerStates = new WeakMap<JavaObject, ScannerState>();

/**
 * `java.util.Scanner`, which splits its input into tokens at whitespace. It reads numbers as an English locale does,
 * with any one-char Unicode decimal digits.
 */
export function defineScanner(context: IOContext, closeable: ClassInfo): void {
  const scanner = context.registry.define('Scanner', context.objectClass, 'java.util');
  scanner.isFinal = true;
  scanner.interfaces.push(closeable);
  scanner.supertypes.push(classType(closeable));
  defineScannerConstructors(context, scanner);
  defineTokenMethods(context, scanner);
  addMethod(scanner, 'nextLine', [], context.stringType, false, (frame, receiver) => {
    const line = readLine(frame, stateOf(frame, receiver));
    if (line === undefined) return throwBuiltin(frame, 'NoSuchElementException', 'No line found');
    return newString(frame, line);
  });
  addMethod(scanner, 'hasNextLine', [], BOOLEAN, false, (frame, receiver) => {
    const state = stateOf(frame, receiver);
    return state.position < state.buffer.length || readAhead(frame, state);
  });
  addMethod(scanner, 'close', [], VOID, false, (frame, receiver) => {
    const state = scannerStates.get(receiver as JavaObject) as ScannerState;
    if (state.isClosed) return;
    state.isClosed = true;
    state.source.close(frame);
  });
}

function defineScannerConstructors(context: IOContext, scanner: ClassInfo): void {
  for (const name of ['InputStream', 'Readable']) {
    addConstructor(scanner, [classOf(context, name).type], (frame, receiver, [input]) => {
      // A scanner reads a stream through a reader, as Java's wraps it in an InputStreamReader.
      create(
        frame,
        receiver,
        name === 'InputStream' ? new ReadAheadSource(frame, readSourceOf(frame, input)) : readSourceOf(frame, input)
      );
    });
  }
  addConstructor(scanner, [context.stringType], (frame, receiver, [text]) => {
    if (!(text instanceof JavaString)) throwBuiltin(frame, 'NullPointerException');
    create(frame, receiver, new TextSource(frame.runtime.io.textReader(text.value)));
  });
  const fromFile = addConstructor(scanner, [classOf(context, 'File').type], (frame, receiver, [file]) => {
    create(frame, receiver, new ReadAheadSource(frame, new TextSource(openFileReader(frame, filePathOf(frame, file)))));
  });
  fromFile.thrownTypes = [classOf(context, 'FileNotFoundException')];
  const fromPath = addConstructor(scanner, [classOf(context, 'Path').type], (frame, receiver, [path]) => {
    const text = pathTextOf(frame, path);
    const reader = withNioErrors(frame, text, () => frame.runtime.io.openReader(text));
    create(frame, receiver, new ReadAheadSource(frame, new TextSource(reader)));
  });
  fromPath.thrownTypes = [context.ioException];
}

function create(frame: Frame, receiver: Value, source: ReadSource): void {
  scannerStates.set(
    receiver as JavaObject,
    new ScannerState(frame, new ReadAheadSource(frame, source, SCANNER_BUFFER_SIZE))
  );
}

function defineTokenMethods(context: IOContext, scanner: ClassInfo): void {
  addMethod(scanner, 'next', [], context.stringType, false, (frame, receiver) =>
    takeToken(frame, receiver, (token) => newString(frame, token))
  );
  addMethod(scanner, 'hasNext', [], BOOLEAN, false, (frame, receiver) => peekToken(frame, receiver) !== undefined);
  defineIntegerTokens(scanner, 'Int', INT, 32);
  defineIntegerTokens(scanner, 'Long', LONG, 64);
  definePatternTokens(scanner, 'Double', DOUBLE, DECIMAL, (token) => Number(asciiDigitsOf(token)));
  definePatternTokens(scanner, 'Boolean', BOOLEAN, BOOLEAN_TOKEN, (token) => token.toLowerCase() === 'true');
}

/** Defines `next<suffix>` and `hasNext<suffix>` for integers of `bits` bits. */
function defineIntegerTokens(scanner: ClassInfo, suffix: string, type: JavaType, bits: number): void {
  addMethod(scanner, `next${suffix}`, [], type, false, (frame, receiver) =>
    takeToken(frame, receiver, (token) => {
      const integer = integerOf(token, bits);
      if (integer === undefined) return throwBuiltin(frame, 'InputMismatchException');
      if (integer.value === undefined) {
        return throwBuiltin(frame, 'InputMismatchException', `For input string: "${integer.digits}"`);
      }
      return bits === 32 ? Number(integer.value) : integer.value;
    })
  );
  addMethod(
    scanner,
    `hasNext${suffix}`,
    [],
    BOOLEAN,
    false,
    (frame, receiver) => integerOf(peekToken(frame, receiver) ?? '', bits)?.value !== undefined
  );
}

/** Defines `next<suffix>` and `hasNext<suffix>` for the tokens that match `pattern`. */
function definePatternTokens(
  scanner: ClassInfo,
  suffix: string,
  type: JavaType,
  pattern: RegExp,
  parse: (token: string) => Value
): void {
  addMethod(scanner, `next${suffix}`, [], type, false, (frame, receiver) =>
    takeToken(frame, receiver, (token) =>
      matches(pattern, token) ? parse(token) : throwBuiltin(frame, 'InputMismatchException')
    )
  );
  addMethod(scanner, `hasNext${suffix}`, [], BOOLEAN, false, (frame, receiver) =>
    matches(pattern, peekToken(frame, receiver) ?? '')
  );
}

/**
 * The integer a token stands for, without its thousands separators, whose value is `undefined` when it overflows
 * `bits` bits, or `undefined` for a token that is no integer.
 */
function integerOf(token: string, bits: number): { digits: string; value: bigint | undefined } | undefined {
  if (!matches(INTEGER, token)) return undefined;
  const digits = asciiDigitsOf(token);
  const value = BigInt(digits);
  const bound = 1n << BigInt(bits - 1);
  return { digits, value: value < -bound || value >= bound ? undefined : value };
}

/**
 * Whether a token matches a pattern of numbers or booleans, whose digits must each be one char: Java converts a
 * number by its chars, so a digit outside the BMP, two chars that are no digits, makes the token no number.
 */
function matches(pattern: RegExp, token: string): boolean {
  return pattern.test(token) && !/[\u{10000}-\u{10FFFF}]/u.test(token);
}

/** A numeric token without thousands separators, with its digits in ASCII, as `Character.digit` reads them. */
function asciiDigitsOf(token: string): string {
  return token
    .replaceAll(',', '')
    .replaceAll(/\p{Nd}/gu, (digit) => String(decimalDigitValue(digit.codePointAt(0) as number)));
}

function stateOf(frame: Frame, receiver: Value): ScannerState {
  const state = scannerStates.get(receiver as JavaObject) as ScannerState;
  if (state.isClosed) return throwBuiltin(frame, 'IllegalStateException', 'Scanner closed');
  return state;
}

/**
 * Reads the next part of the source into the scanner's buffer, telling whether any input remained; a closed source
 * has none, as Java's scanner takes it for the end of input.
 */
function readAhead(frame: Frame, state: ScannerState): boolean {
  try {
    return state.source.readMore(frame);
  } catch (error) {
    if (error instanceof JavaThrow) return false;
    throw error;
  }
}

/**
 * Where the next token starts and ends in the buffer, reading ahead until the token ends before the buffer does or
 * the input ends; an empty token means that only whitespace remains.
 */
function tokenBounds(frame: Frame, state: ScannerState): { start: number; end: number } {
  // The bounds are relative to the position, which reading ahead keeps at the same text, so that each char is
  // examined once however many lines the search reads.
  let [start, end, isInToken] = [0, 0, false];
  for (;;) {
    const { buffer, position } = state;
    const from = position + end;
    let index = from;
    if (!isInToken) {
      while (index < buffer.length && WHITESPACE.test(buffer[index])) index++;
      [start, isInToken] = [index - position, index < buffer.length];
    }
    while (isInToken && index < buffer.length && !WHITESPACE.test(buffer[index])) index++;
    end = index - position;
    frame.runtime.scanString(index - from);
    if (index < buffer.length || !readAhead(frame, state)) return { start, end };
  }
}

function peekToken(frame: Frame, receiver: Value): string | undefined {
  const state = stateOf(frame, receiver);
  const { start, end } = tokenBounds(frame, state);
  return start < end ? state.buffer.slice(state.position + start, state.position + end) : undefined;
}

/**
 * Reads the next token as `parse` reads it, skipping the whitespace before it in any case, as Java's scanner does,
 * though a token `parse` throws for stays unread for the next call.
 */
function takeToken(frame: Frame, receiver: Value, parse: (token: string) => Value): Value {
  const state = stateOf(frame, receiver);
  const { start, end } = tokenBounds(frame, state);
  const base = state.position;
  state.position = base + start;
  if (start === end) return throwBuiltin(frame, 'NoSuchElementException');
  const value = parse(state.buffer.slice(base + start, base + end));
  state.position = base + end;
  return value;
}

/** Reads the rest of the line, consuming its terminator, or `undefined` at the end of input. */
function readLine(frame: Frame, state: ScannerState): string | undefined {
  for (;;) {
    LINE_TERMINATOR.lastIndex = state.position;
    const terminator = LINE_TERMINATOR.exec(state.buffer);
    // A terminator at the buffer's end may be a `\r` whose `\n` the next line brings.
    const isComplete =
      terminator && (terminator.index + terminator[0].length < state.buffer.length || terminator[0] !== '\r');
    if (isComplete || !readAhead(frame, state)) {
      if (state.position >= state.buffer.length) return undefined;
      const end = terminator ? terminator.index : state.buffer.length;
      const line = state.buffer.slice(state.position, end);
      frame.runtime.scanString(end - state.position + 1);
      state.position = terminator ? end + terminator[0].length : end;
      return line;
    }
  }
}
