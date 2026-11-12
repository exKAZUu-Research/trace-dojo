import { currentRuntime } from '../runtimeContext';
import { iterStr } from '../strings';
import { iteratorClass, newList, newTuple, None, typeError, typeName, valueError } from '../types';
import { DONE, PyIterator, type PyValue } from '../values';

const IDENTIFIER_START = /^[_a-zA-Z]$/;
const IDENTIFIER_PART = /^[_a-zA-Z0-9]$/;

/**
 * The matches of `string.Template`'s default pattern in a template, each as `(start, end, kind, name)` with `kind`
 * one of 'escaped', 'named' (plain or braced) and 'invalid'.
 */
export function templateScan([template, delimiterValue]: PyValue[]): PyValue {
  if (typeof template !== 'string') {
    throw typeError(`expected string or bytes-like object, got '${typeName(template)}'`);
  }
  const chars = iterStr(template);
  const delimiter = iterStr(delimiterValue as string);
  const matches: PyValue[] = [];
  let index = 0;
  while (index + delimiter.length <= chars.length) {
    if (!startsWith(chars, index, delimiter)) {
      index++;
      continue;
    }
    const after = index + delimiter.length;
    const { end, kind, name } = placeholderAt(chars, after, delimiter);
    matches.push(newTuple([BigInt(index), BigInt(end), kind, name ?? None]));
    // As a regular expression search does after an empty match, an empty delimiter moves on by one character.
    index = end > index ? end : index + 1;
  }
  return newList(matches);
}

/** The pattern compares without regard to case, as its IGNORECASE flag has it. */
function startsWith(chars: readonly string[], index: number, expected: readonly string[]): boolean {
  return expected.every((char, offset) => {
    const actual = chars[index + offset];
    return actual === char || actual.toLowerCase() === char.toLowerCase();
  });
}

function placeholderAt(
  chars: readonly string[],
  after: number,
  delimiter: readonly string[]
): { end: number; kind: string; name?: string } {
  if (delimiter.length > 0 && after + delimiter.length <= chars.length && startsWith(chars, after, delimiter)) {
    return { end: after + delimiter.length, kind: 'escaped' };
  }
  const plainEnd = identifierEnd(chars, after);
  if (plainEnd > after) return { end: plainEnd, kind: 'named', name: chars.slice(after, plainEnd).join('') };
  if (chars[after] === '{') {
    const bracedEnd = identifierEnd(chars, after + 1);
    if (bracedEnd > after + 1 && chars[bracedEnd] === '}') {
      return { end: bracedEnd + 1, kind: 'named', name: chars.slice(after + 1, bracedEnd).join('') };
    }
  }
  return { end: after, kind: 'invalid' };
}

function identifierEnd(chars: readonly string[], start: number): number {
  if (start >= chars.length || !IDENTIFIER_START.test(chars[start])) return start;
  let end = start + 1;
  while (end < chars.length && IDENTIFIER_PART.test(chars[end])) end++;
  return end;
}

/** `_string.formatter_parser`: the `(literal_text, field_name, format_spec, conversion)` parts of a format string. */
export function formatterParser([format]: PyValue[]): PyValue {
  if (typeof format !== 'string') throw typeError(`expected str, got ${typeName(format)}`);
  const chars = retainedChars(format);
  let index = 0;
  return new PyIterator(iteratorClass('formatteriterator'), () => {
    if (index >= chars.length) return DONE;
    const literal = parseLiteral(chars, index);
    index = literal.end;
    if (!literal.isFieldNext) return newTuple([literal.text, None, None, None]);
    const field = parseField(chars, index);
    index = field.end;
    return newTuple([literal.text, field.name, field.spec, field.conversion ?? None]);
  });
}

/** Transcribes MarkupIterator_next of CPython's string_format.h up to the start of a replacement field. */
function parseLiteral(chars: readonly string[], start: number): { text: string; end: number; isFieldNext: boolean } {
  let index = start;
  let brace: string | undefined;
  while (index < chars.length && brace === undefined) {
    const char = chars[index++];
    if (char === '{' || char === '}') brace = char;
  }
  const isAtEnd = index >= chars.length;
  if (brace === '}' && (isAtEnd || chars[index] !== '}')) {
    throw valueError("Single '}' encountered in format string");
  }
  if (isAtEnd && brace === '{') throw valueError("Single '{' encountered in format string");
  if (brace === undefined) return { text: chars.slice(start, index).join(''), end: index, isFieldNext: false };
  if (chars[index] === brace) return { text: chars.slice(start, index).join(''), end: index + 1, isFieldNext: false };
  return { text: chars.slice(start, index - 1).join(''), end: index, isFieldNext: true };
}

interface Field {
  name: string;
  spec: string;
  conversion?: string;
  end: number;
}

/** Transcribes parse_field of CPython's string_format.h. */
// code-gauge-allow functionNcss 32 -- Transcribes parse_field of CPython's string_format.h.
// code-gauge-allow functionCognitiveComplexity 29 -- Transcribes parse_field of CPython's string_format.h.
function parseField(chars: readonly string[], start: number): Field {
  let index = start;
  let terminator: string | undefined;
  while (index < chars.length && terminator === undefined) {
    const char = chars[index++];
    if (char === '{') throw valueError("unexpected '{' in field name");
    if (char === '[') {
      while (index < chars.length && chars[index] !== ']') index++;
      terminator = index < chars.length ? undefined : '[';
    } else if (char === '}' || char === ':' || char === '!') {
      terminator = char;
    }
  }
  const name = chars.slice(start, index - 1).join('');
  if (terminator === '}') return { name, spec: '', end: index };
  if (terminator !== '!' && terminator !== ':') throw valueError("expected '}' before end of string");
  let conversion: string | undefined;
  if (terminator === '!') {
    if (index >= chars.length) throw valueError('end of string while looking for conversion specifier');
    conversion = chars[index++];
    if (index < chars.length) {
      const next = chars[index++];
      if (next === '}') return { name, spec: '', conversion, end: index };
      if (next !== ':') throw valueError("expected ':' after conversion specifier");
    }
  }
  const end = formatSpecEnd(chars, index);
  return { name, spec: chars.slice(index, end - 1).join(''), conversion, end };
}

/** The index after the `}` that closes a replacement field whose format spec starts at `start`. */
function formatSpecEnd(chars: readonly string[], start: number): number {
  let depth = 1;
  for (let index = start; index < chars.length; index++) {
    if (chars[index] === '{') depth++;
    else if (chars[index] === '}' && --depth === 0) return index + 1;
  }
  throw valueError("unmatched '{' in format spec");
}

/** `_string.formatter_field_name_split`: the first part of a field name and an iterator of its accessors. */
export function formatterFieldNameSplit([fieldName]: PyValue[]): PyValue {
  if (typeof fieldName !== 'string') throw typeError(`expected str, got ${typeName(fieldName)}`);
  const chars = retainedChars(fieldName);
  let index = 0;
  while (index < chars.length && chars[index] !== '[' && chars[index] !== '.') index++;
  const first = chars.slice(0, index).join('');
  const accessors = new PyIterator(iteratorClass('fieldnameiterator'), () => {
    if (index >= chars.length) return DONE;
    const accessor = parseAccessor(chars, index);
    index = accessor.end;
    return newTuple([accessor.isAttribute, accessor.key]);
  });
  return newTuple([integerOr(first), accessors]);
}

/** The code points of a string that an iterator keeps, charged as the storage they take. */
function retainedChars(text: string): string[] {
  const chars = iterStr(text);
  currentRuntime().allocate(chars.length);
  return chars;
}

/** Transcribes FieldNameIterator_next of CPython's string_format.h. */
function parseAccessor(chars: readonly string[], start: number): { isAttribute: boolean; key: PyValue; end: number } {
  const opener = chars[start];
  let end = start + 1;
  if (opener === '.') {
    while (end < chars.length && chars[end] !== '.' && chars[end] !== '[') end++;
    if (end === start + 1) throw valueError('Empty attribute in format string');
    return { isAttribute: true, key: chars.slice(start + 1, end).join(''), end };
  }
  if (opener !== '[') throw valueError("Only '.' or '[' may follow ']' in format field specifier");
  while (end < chars.length && chars[end] !== ']') end++;
  if (end >= chars.length) throw valueError("Missing ']' in format string");
  if (end === start + 1) throw valueError('Empty attribute in format string');
  return { isAttribute: false, key: integerOr(chars.slice(start + 1, end).join('')), end: end + 1 };
}

function integerOr(text: string): PyValue {
  if (!/^\d+$/.test(text)) return text;
  if (BigInt(text) >= 2n ** 63n) throw valueError('Too many decimal digits in format string');
  return BigInt(text);
}
