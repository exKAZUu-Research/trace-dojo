import { formatComplex } from './formatComplex';
import { formatValue } from './formatSpec';
import { floatRepr, intToString } from './numbers';
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
      index = end + 1;
    }
  }
  return result;
}

/** Returns the index of the `}` closing the replacement field that starts at `start`. */
function fieldEnd(chars: readonly string[], start: number): number {
  let level = 1;
  let inBracket = false;
  for (let end = start; end < chars.length; end++) {
    const c = chars[end];
    if (c === '[') inBracket = true;
    if (c === ']') inBracket = false;
    if (inBracket) continue;
    if (c === '{') level++;
    if (c === '}' && --level === 0) return end;
  }
  throw valueError(level > 1 ? "expected '}' before end of string" : "Single '{' encountered in format string");
}

function renderField(
  field: string,
  args: readonly PyValue[],
  kwargs: (name: string) => PyValue,
  state: FieldState,
  depth: number
): string {
  const match = /^([^!:[.]*)((?:\.[^![.:]+|\[[^\]]*\])*)(?:!(.))?(?::(.*))?$/s.exec(field);
  if (!match) {
    if (/![^:]{2,}/.test(field)) throw valueError("expected ':' after conversion specifier");
    throw valueError(`unmatched '{' in format spec`);
  }
  const [, name, accessors, conversion, spec = ''] = match;
  let value = fieldValue(name, args, kwargs, state);
  for (const accessor of accessors.match(/\.[^![.:]+|\[[^\]]*\]/g) ?? []) {
    if (accessor.startsWith('.')) {
      value = getAttribute(value, accessor.slice(1));
    } else {
      const key = accessor.slice(1, -1);
      value = getItem(value, /^\d+$/.test(key) ? BigInt(key) : key);
    }
  }
  if (conversion !== undefined) value = convertField(value, conversion);
  const renderedSpec = spec.includes('{') ? renderTemplate(spec, args, kwargs, state, depth - 1) : spec;
  return pyFormat(value, renderedSpec);
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
  if (/^\d+$/.test(name)) {
    if (state.mode === 'auto') {
      throw valueError('cannot switch from automatic field numbering to manual field specification');
    }
    state.mode = 'manual';
    return positional(args, Number(name));
  }
  return kwargs(name);
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
