import { formatComplex } from './formatComplex';
import { formatValue } from './formatSpec';
import { decimalValue, floatRepr, intToString } from './numbers';
import { bindValue, callValue, getAttribute, getItem, lookupSpecial } from './objects';
import { currentRuntime } from './runtimeContext';
import { asciiEscape, iterStr, strRepr } from './strings';
import { classOf, None, typeError, typeName, valueError } from './types';
import { PyBuiltinFunction, PyComplex, PyInstance, type PyObject, type PyValue } from './values';

/** `repr()` of a value. */
export function pyRepr(value: PyValue): string {
  switch (typeof value) {
    case 'bigint': {
      return intToString(value);
    }
    case 'number': {
      return floatRepr(value);
    }
    case 'string': {
      currentRuntime().scan(value.length);
      return strRepr(value);
    }
    case 'boolean': {
      return value ? 'True' : 'False';
    }
  }
  if (value === None) return 'None';
  return callStringMethod(value, '__repr__');
}

/** `str()` of a value. */
export function pyStr(value: PyValue): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return pyRepr(value);
  if (value === None) return 'None';
  return callStringMethod(value, '__str__');
}

export function pyAscii(value: PyValue): string {
  return asciiEscape(pyRepr(value));
}

function callStringMethod(value: PyObject, name: '__repr__' | '__str__'): string {
  const runtime = currentRuntime();
  const method = lookupSpecial(value, name);
  if (method === undefined) return defaultRepr(value);
  runtime.spend();
  const result =
    method instanceof PyBuiltinFunction && method.self === undefined
      ? runtime.guardRecursion(() => method.run([value], undefined))
      : runtime.guardRecursion(() => callValue(bindValue(method, value), []));
  if (typeof result !== 'string') throw typeError(`${name} returned non-string (type ${typeName(result)})`);
  return result;
}

/** The address-like text that default reprs show, which differs from CPython's real addresses. */
export function addressOf(value: PyObject): string {
  return `0x${(0x1_04_00_00_00 + value.identity * 0x30).toString(16)}`;
}

export function defaultRepr(value: PyObject): string {
  const cls = classOf(value);
  const module = cls.module === 'builtins' ? '' : `${cls.module}.`;
  return `<${module}${cls.qualifiedName} object at ${addressOf(value)}>`;
}

/** `format(value, spec)`, which calls the value's `__format__`. */
export function pyFormat(value: PyValue, spec: string): string {
  if (typeof value === 'object' && value !== None) {
    const method = lookupSpecial(value, '__format__');
    if (method !== undefined && (!(method instanceof PyBuiltinFunction) || isEnumMember(value))) {
      const result = callValue(bindValue(method, value), [spec]);
      if (typeof result !== 'string') throw typeError(`__format__ must return a str, not ${typeName(result)}`);
      return result;
    }
  }
  if (value === None && spec !== '') throw typeError('unsupported format string passed to NoneType.__format__');
  if (value instanceof PyComplex) return formatComplex(value, spec);
  if (typeof value === 'object' && spec !== '') {
    throw typeError(`unsupported format string passed to ${typeName(value)}.__format__`);
  }
  return formatValue(value, spec, pyStr);
}

/** An Enum member, whose builtin `__format__` formats its `str()` or, for an IntEnum, its value. */
function isEnumMember(value: PyObject): boolean {
  return value instanceof PyInstance && value.enumValue !== undefined;
}

// str.format ---------------------------------------------------------------------------------------------------------

interface FieldState {
  auto: number;
  mode?: 'auto' | 'manual';
}

/** `str.format()` and `str.format_map()`. */
export function formatString(template: string, args: readonly PyValue[], kwargs: (name: string) => PyValue): string {
  const state: FieldState = { auto: 0 };
  const result = renderTemplate(template, args, kwargs, state, 2);
  currentRuntime().buildString(result.length);
  return result;
}

function renderTemplate(
  template: string,
  args: readonly PyValue[],
  kwargs: (name: string) => PyValue,
  state: FieldState,
  depth: number
): string {
  if (depth < 0) throw valueError('Max string recursion exceeded');
  const chars = iterStr(template);
  let result = '';
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (char === '}') {
      if (chars[index + 1] !== '}') throw valueError("Single '}' encountered in format string");
      result += '}';
      index += 2;
    } else if (char !== '{') {
      result += char;
      index++;
    } else if (chars[index + 1] === '{') {
      result += '{';
      index += 2;
    } else {
      const end = fieldEnd(chars, index + 1);
      result += renderField(chars.slice(index + 1, end).join(''), args, kwargs, state, depth);
      currentRuntime().ensureStringFits(result.length);
      index = end + 1;
    }
  }
  return result;
}

/**
 * Returns the index of the `}` closing the replacement field that starts at `start`, failing as CPython's
 * MarkupIterator_next and parse_field do: a field name ends at `}`, `:` or `!` outside brackets, and a format spec
 * counts its own braces.
 */
function fieldEnd(chars: readonly string[], start: number): number {
  if (start >= chars.length) throw valueError("Single '{' encountered in format string");
  const { index, terminator } = fieldNameEnd(chars, start);
  if (terminator === '}') return index - 1;
  if (terminator === ':') return formatSpecEnd(chars, index);
  return conversionEnd(chars, index);
}

/** Reads a field name up to the `}`, `:` or `!` after it, which brackets hide. */
function fieldNameEnd(chars: readonly string[], start: number): { index: number; terminator: string } {
  let index = start;
  while (index < chars.length) {
    const c = chars[index++];
    if (c === '{') throw valueError("unexpected '{' in field name");
    if (c === '}' || c === ':' || c === '!') return { index, terminator: c };
    if (c === '[') while (index < chars.length && chars[index] !== ']') index++;
  }
  throw valueError("expected '}' before end of string");
}

/** The index of the `}` closing a field after its `!` and conversion character, through any format spec. */
function conversionEnd(chars: readonly string[], start: number): number {
  if (start >= chars.length) throw valueError('end of string while looking for conversion specifier');
  const index = start + 1;
  if (index >= chars.length) return formatSpecEnd(chars, index);
  if (chars[index] === '}') return index;
  if (chars[index] !== ':') throw valueError("expected ':' after conversion specifier");
  return formatSpecEnd(chars, index + 1);
}

/** The index of the `}` closing a format spec that starts at `start`, whose own nested fields count their braces. */
function formatSpecEnd(chars: readonly string[], start: number): number {
  let level = 1;
  for (let index = start; index < chars.length; index++) {
    if (chars[index] === '{') level++;
    else if (chars[index] === '}' && --level === 0) return index;
  }
  throw valueError("unmatched '{' in format spec");
}

function renderField(
  field: string,
  args: readonly PyValue[],
  kwargs: (name: string) => PyValue,
  state: FieldState,
  depth: number
): string {
  const { name, conversion, spec } = splitField(field);
  const value = fieldObject(name, args, kwargs, state);
  const converted = conversion === undefined ? value : convertField(value, conversion);
  const renderedSpec = spec.includes('{') ? renderTemplate(spec, args, kwargs, state, depth - 1) : spec;
  return pyFormat(converted, renderedSpec);
}

/** A closed field's name, conversion, and format spec, split as parse_field splits them. */
function splitField(field: string): { name: string; conversion: string | undefined; spec: string } {
  const chars = [...field];
  let index = 0;
  while (index < chars.length && chars[index] !== ':' && chars[index] !== '!') {
    if (chars[index++] === '[') while (index < chars.length && chars[index] !== ']') index++;
  }
  const name = chars.slice(0, index).join('');
  if (chars[index] !== '!') return { name, conversion: undefined, spec: chars.slice(index + 1).join('') };
  return { name, conversion: chars[index + 1], spec: chars.slice(index + 3).join('') };
}

/**
 * The object a field name refers to, as get_field_object finds it: the argument the part before the first `.` or `[`
 * names, then each accessor applied as soon as FieldNameIterator_next reads it.
 */
function fieldObject(
  name: string,
  args: readonly PyValue[],
  kwargs: (name: string) => PyValue,
  state: FieldState
): PyValue {
  const chars = [...name];
  let index = 0;
  while (index < chars.length && chars[index] !== '.' && chars[index] !== '[') index++;
  let value = fieldValue(chars.slice(0, index).join(''), args, kwargs, state);
  while (index < chars.length) {
    const accessor = nextAccessor(chars, index);
    index = accessor.end;
    value = accessor.isAttribute
      ? getAttribute(value, accessor.key)
      : getItem(value, fieldIndex(accessor.key) ?? accessor.key);
  }
  return value;
}

/** FieldNameIterator_next: the `.attribute` or `[key]` at `start`, and where the next one starts. */
function nextAccessor(chars: readonly string[], start: number): { isAttribute: boolean; key: string; end: number } {
  const isAttribute = chars[start] === '.';
  if (!isAttribute && chars[start] !== '[') {
    throw valueError("Only '.' or '[' may follow ']' in format field specifier");
  }
  let end = start + 1;
  if (isAttribute) {
    while (end < chars.length && chars[end] !== '.' && chars[end] !== '[') end++;
  } else {
    while (end < chars.length && chars[end] !== ']') end++;
    if (end >= chars.length) throw valueError("Missing ']' in format string");
  }
  const key = chars.slice(start + 1, end).join('');
  if (key === '') throw valueError('Empty attribute in format string');
  return { isAttribute, key, end: isAttribute ? end : end + 1 };
}

function fieldValue(
  name: string,
  args: readonly PyValue[],
  kwargs: (name: string) => PyValue,
  state: FieldState
): PyValue {
  if (name === '') {
    if (state.mode === 'manual') {
      throw valueError('cannot switch from manual field specification to automatic field numbering');
    }
    state.mode = 'auto';
    return positional(args, state.auto++);
  }
  const index = fieldIndex(name);
  if (index !== undefined) {
    if (state.mode === 'auto') {
      throw valueError('cannot switch from automatic field numbering to manual field specification');
    }
    state.mode = 'manual';
    return positional(args, Number(index));
  }
  return kwargs(name);
}

const MAX_SSIZE = (1n << 63n) - 1n;

/** get_integer: the value of a text of decimal digits, refusing one beyond sys.maxsize, or undefined for another. */
function fieldIndex(text: string): bigint | undefined {
  const index = decimalValue(text);
  if (index !== undefined && index > MAX_SSIZE) throw valueError('Too many decimal digits in format string');
  return index;
}

function convertField(value: PyValue, conversion: string): PyValue {
  if (conversion === 'r') return pyRepr(value);
  if (conversion === 's') return pyStr(value);
  if (conversion === 'a') return pyAscii(value);
  throw valueError(`Unknown conversion specifier ${conversion}`);
}

function positional(args: readonly PyValue[], index: number): PyValue {
  if (index >= args.length) {
    throw currentRuntime().indexError(`Replacement index ${index} out of range for positional args tuple`);
  }
  return args[index];
}

export function isStringLike(value: PyValue): value is string {
  return typeof value === 'string';
}

export { iterStr };
