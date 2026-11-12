import type { TextReader } from '../interpreter/programIo';
import {
  classOf,
  classType,
  filePathOf,
  type IOContext,
  openFileReader,
  pathTextOf,
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

interface ScannerState {
  source: ReadSource;
  isClosed: boolean;
}

const scannerStates = new WeakMap<JavaObject, ScannerState>();

/**
 * `java.util.Scanner`, which splits its input into tokens at whitespace. It reads numbers as an English locale does,
 * from ASCII digits only.
 */
export function defineScanner(context: IOContext, closeable: ClassInfo): void {
  const scanner = context.registry.define('Scanner', context.objectClass, 'java.util');
  scanner.isFinal = true;
  scanner.interfaces.push(closeable);
  scanner.supertypes.push(classType(closeable));
  defineScannerConstructors(context, scanner);
  defineTokenMethods(context, scanner);
  addMethod(scanner, 'nextLine', [], context.stringType, false, (frame, receiver) => {
    const text = textOf(frame, receiver);
    const line = text ? readLine(frame, text) : undefined;
    if (line === undefined) return throwBuiltin(frame, 'NoSuchElementException', 'No line found');
    return newString(frame, line);
  });
  addMethod(scanner, 'hasNextLine', [], BOOLEAN, false, (frame, receiver) => {
    const text = textOf(frame, receiver);
    return text !== undefined && !text.isAtEnd;
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
      create(receiver, readSourceOf(frame, input));
    });
  }
  addConstructor(scanner, [context.stringType], (frame, receiver, [text]) => {
    if (!(text instanceof JavaString)) throwBuiltin(frame, 'NullPointerException');
    create(receiver, new TextSource(frame.runtime.io.textReader(text.value)));
  });
  const fromFile = addConstructor(scanner, [classOf(context, 'File').type], (frame, receiver, [file]) => {
    create(receiver, new TextSource(openFileReader(frame, filePathOf(frame, file))));
  });
  fromFile.thrownTypes = [classOf(context, 'FileNotFoundException')];
  const fromPath = addConstructor(scanner, [classOf(context, 'Path').type], (frame, receiver, [path]) => {
    const text = pathTextOf(frame, path);
    create(receiver, new TextSource(withNioErrors(frame, text, () => frame.runtime.io.openReader(text))));
  });
  fromPath.thrownTypes = [context.ioException];
}

function create(receiver: Value, source: ReadSource): void {
  scannerStates.set(receiver as JavaObject, { source, isClosed: false });
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

/**
 * The text a scanner reads, or `undefined` once its source is closed, which a scanner treats as the end of input.
 */
function textOf(frame: Frame, receiver: Value): TextReader | undefined {
  const state = scannerStates.get(receiver as JavaObject) as ScannerState;
  if (state.isClosed) return throwBuiltin(frame, 'IllegalStateException', 'Scanner closed');
  try {
    return state.source.reader(frame);
  } catch (error) {
    if (error instanceof JavaThrow) return undefined;
    throw error;
  }
}

/** Where the next token starts and ends, which is an empty token when only whitespace remains. */
function tokenBounds(frame: Frame, text: TextReader): { start: number; end: number } {
  const { text: source, position } = text;
  let start = position;
  while (start < source.length && WHITESPACE.test(source[start])) start++;
  let end = start;
  while (end < source.length && !WHITESPACE.test(source[end])) end++;
  frame.runtime.scanString(end - position);
  return { start, end };
}

function peekToken(frame: Frame, receiver: Value): string | undefined {
  const text = textOf(frame, receiver);
  const bounds = text && tokenBounds(frame, text);
  return bounds && bounds.start < bounds.end ? text.text.slice(bounds.start, bounds.end) : undefined;
}

/**
 * Reads the next token as `parse` reads it, skipping the whitespace before it in any case, as Java's scanner does,
 * though a token `parse` throws for stays unread for the next call.
 */
function takeToken(frame: Frame, receiver: Value, parse: (token: string) => Value): Value {
  const text = textOf(frame, receiver);
  if (!text) return throwBuiltin(frame, 'NoSuchElementException');
  const bounds = tokenBounds(frame, text);
  text.position = bounds.start;
  if (bounds.start === bounds.end) return throwBuiltin(frame, 'NoSuchElementException');
  const value = parse(text.text.slice(bounds.start, bounds.end));
  text.position = bounds.end;
  return value;
}

/** Reads the rest of the line, consuming its terminator, or `undefined` at the end of input. */
function readLine(frame: Frame, text: TextReader): string | undefined {
  if (text.isAtEnd) return undefined;
  LINE_TERMINATOR.lastIndex = text.position;
  const terminator = LINE_TERMINATOR.exec(text.text);
  const end = terminator ? terminator.index : text.text.length;
  const line = text.text.slice(text.position, end);
  frame.runtime.scanString(end - text.position + 1);
  text.position = terminator ? end + terminator[0].length : end;
  return line;
}
