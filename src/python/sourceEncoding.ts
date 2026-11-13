import { decodeBytes } from './codecs';
import { pyStr } from './conversions';
import { callValue } from './objects';
import { currentRuntime } from './runtimeContext';
import { exceptionClassNamed, newTuple, None } from './types';
import { PyError, type PyInstance, type PyValue } from './values';

const COOKIE_PATTERN = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/;
const BLANK_OR_COMMENT = /^[ \t\f]*(?:#.*)?$/;

/**
 * Decodes a byte-like source passed to `compile()`, `eval()`, or `exec()` following PEP 263: strips a UTF-8 BOM,
 * honors a `# coding:` cookie on line 1 or 2, and raises `SyntaxError` on null bytes, BOM conflicts, undeclared
 * non-UTF-8 bytes, unknown codecs, or decode errors.
 */
export function decodeSourceBytes(raw: Uint8Array, filename: string): string {
  if (raw.includes(0)) throw shownSyntaxError('source code string cannot contain null bytes');
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const body = hasBom ? raw.subarray(3) : raw;
  const cookie = findCodingCookie(body);
  if (cookie) {
    const normalized = normalizeCookieName(cookie.name);
    if (hasBom && normalized !== 'utf8') {
      throw shownSyntaxError(`encoding problem: ${normalized} with BOM`, [
        filename,
        BigInt(cookie.lineNo),
        0n,
        cookie.lineText,
      ]);
    }
    return decodeWithCookie(body, normalized, cookie.name, filename);
  }
  const invalid = findInvalidUtf8(body);
  if (invalid) {
    const hex = invalid.byte.toString(16).padStart(2, '0');
    throw shownSyntaxError(
      `Non-UTF-8 code starting with '\\x${hex}' on line ${invalid.lineNo}, but no encoding declared; see https://peps.python.org/pep-0263/ for details`,
      [filename, BigInt(invalid.lineNo), 1n, '\uFFFD']
    );
  }
  return decodeWithCookie(body, 'utf8', 'utf8', filename);
}

export function checkNoNullCharacters(text: string): string {
  if (text.includes('\0')) throw shownSyntaxError('source code string cannot contain null bytes');
  return text;
}

function shownSyntaxError(message: string, details?: [string, bigint, bigint, PyValue]): PyError {
  const args: PyValue[] = details ? [message, newTuple(details)] : [message];
  return new PyError(callValue(exceptionClassNamed('SyntaxError'), args) as PyInstance);
}

function findCodingCookie(body: Uint8Array): { name: string; lineNo: number; lineText: string } | undefined {
  const [line1, line2] = firstTwoLines(body);
  const match1 = COOKIE_PATTERN.exec(line1);
  if (match1) return { name: match1[1], lineNo: 1, lineText: line1 };
  if (line2 !== undefined && BLANK_OR_COMMENT.test(line1)) {
    const match2 = COOKIE_PATTERN.exec(line2);
    if (match2) return { name: match2[1], lineNo: 2, lineText: line2 };
  }
  return undefined;
}

function firstTwoLines(body: Uint8Array): [string, string | undefined] {
  const firstNl = body.indexOf(0x0a);
  if (firstNl === -1) return [latin1Line(body), undefined];
  const secondNl = body.indexOf(0x0a, firstNl + 1);
  const secondSlice = secondNl === -1 ? body.subarray(firstNl + 1) : body.subarray(firstNl + 1, secondNl);
  return [latin1Line(body.subarray(0, firstNl)), latin1Line(secondSlice)];
}

function latin1Line(bytes: Uint8Array): string {
  const end = bytes.at(-1) === 0x0d ? bytes.length - 1 : bytes.length;
  let line = '';
  for (let index = 0; index < end; index++) line += String.fromCodePoint(bytes[index]);
  return line;
}

function normalizeCookieName(name: string): string {
  const lower = name.toLowerCase().replaceAll('_', '-');
  if (lower === 'utf8' || lower.startsWith('utf-8-')) return 'utf8';
  if (/^(?:latin-1|iso-latin-1|iso-8859-1)(?:-|$)/.test(lower)) return 'iso-8859-1';
  return name;
}

function decodeWithCookie(body: Uint8Array, encoding: string, rawName: string, filename: string): string {
  try {
    return decodeBytes(body, encoding, 'strict');
  } catch (error) {
    if (currentRuntime().isLookupError(error)) {
      throw shownSyntaxError(`unknown encoding: ${rawName}`, [filename, 0n, -1n, None]);
    }
    if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('UnicodeDecodeError'))) {
      throw shownSyntaxError(pyStr(error.exception), [filename, 0n, -1n, None]);
    }
    throw error;
  }
}

function findInvalidUtf8(body: Uint8Array): { byte: number; lineNo: number } | undefined {
  let lineNo = 1;
  for (let index = 0; index < body.length;) {
    const first = body[index];
    if (first === 0x0a) {
      lineNo++;
      index++;
      continue;
    }
    if (first < 0x80) {
      index++;
      continue;
    }
    const width = utf8SequenceWidth(body, index);
    if (width === 0) return { byte: first, lineNo };
    index += width;
  }
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Follows the well-formed UTF-8 byte sequences of the Unicode standard.
function utf8SequenceWidth(body: Uint8Array, index: number): number {
  const b0 = body[index];
  const isCont = (offset: number): boolean => index + offset < body.length && (body[index + offset] & 0xc0) === 0x80;
  if (b0 >= 0xc2 && b0 <= 0xdf) return isCont(1) ? 2 : 0;
  if (b0 >= 0xe0 && b0 <= 0xef) {
    if (!isCont(1) || !isCont(2)) return 0;
    const b1 = body[index + 1];
    if ((b0 === 0xe0 && b1 < 0xa0) || (b0 === 0xed && b1 >= 0xa0)) return 0;
    return 3;
  }
  if (b0 >= 0xf0 && b0 <= 0xf4) {
    if (!isCont(1) || !isCont(2) || !isCont(3)) return 0;
    const b1 = body[index + 1];
    if ((b0 === 0xf0 && b1 < 0x90) || (b0 === 0xf4 && b1 >= 0x90)) return 0;
    return 4;
  }
  return 0;
}
