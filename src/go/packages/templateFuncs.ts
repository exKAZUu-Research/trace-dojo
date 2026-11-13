// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt reads as raw bytes.
import { equalityOf } from '../equality';
import { newError } from '../errorValues';
import { Printer } from '../fmt';
import { decodeRune } from '../literals';
import { isPrint } from '../quote';
import { GoPanic } from '../runtime';
import {
  ANY,
  BASIC,
  ERROR_TYPE,
  type FuncType,
  funcType,
  identical,
  isBasic,
  isComparable,
  pointerTo,
  sliceOf,
  type SliceType,
  type Type,
  typeString,
  underlying,
} from '../types';
import { type Complex, GoFunc, Iface, Slice, type Value } from '../values';
import { sprintf } from './templateLex';
import {
  assignableTo,
  canBeNil,
  capOf,
  convertInteger,
  funcTypeOf,
  implementsError,
  implementsStringer,
  indexOf,
  indirect,
  indirectInterface,
  integerOf,
  interfaceOf,
  isNilValue,
  kindOf,
  lengthOf,
  mapIndex,
  REFLECT_VALUE,
  type RV,
  type RValue,
  toGoValue,
  typeKind,
  valueOf,
  zeroRV,
} from './templateReflect';
import { isDigit, isLetter } from './unicodeSupport';

/** The result of a function a template calls, and the error it returns. */
export type CallResult = [RValue, Value];

/** A builtin function, which receives its arguments as `reflect.Value`s and returns its results the same way. */
export class BuiltinFunc extends GoFunc {
  constructor(readonly impl: (args: RValue[]) => CallResult) {
    super(() => {
      throw new Error('A template builtin runs only from a template');
    });
  }
}

/** A failure of a builtin, which `safeCall` turns into the error the call returns. */
class BuiltinError {
  constructor(readonly message: string) {}
}

function fail(format: string, ...args: (string | number | Iface | undefined)[]): never {
  throw new BuiltinError(sprintf(format, ...args));
}

/** An argument for a message, as fmt prints a `reflect.Value` or a `reflect.Type`. */
export function shown(value: RValue): Iface {
  if (!value) return new Iface(BASIC.string, '<invalid reflect.Value>');
  const inner = interfaceOf(value);
  return inner instanceof Iface ? inner : new Iface(BASIC.string, '<nil>');
}

const RV_TYPE = REFLECT_VALUE;
const RV_SLICE = sliceOf(REFLECT_VALUE);
const ANY_SLICE = sliceOf(ANY);

function builtin(params: Type[], results: Type[], impl: (args: RValue[]) => CallResult): RV {
  return { type: funcType(params, results, true), value: new BuiltinFunc(impl) };
}

function fixed(params: Type[], results: Type[], impl: (args: RValue[]) => CallResult): RV {
  return { type: funcType(params, results, false), value: new BuiltinFunc(impl) };
}

const unreachable = (): CallResult => {
  throw new Error('unreachable');
};

/** `builtinFuncs`: the functions every template has. */
export const BUILTINS = new Map<string, RV>([
  ['and', builtin([RV_TYPE, RV_SLICE], [RV_TYPE], unreachable)],
  ['call', builtin([RV_TYPE, RV_SLICE], [RV_TYPE], unreachable)],
  ['html', builtin([ANY_SLICE], [BASIC.string], (args) => [stringRV(htmlEscapeString(evalArgs(args))), undefined])],
  ['index', builtin([RV_TYPE, RV_SLICE], [RV_TYPE, ERROR_TYPE], ([item, ...indexes]) => index(item, indexes))],
  ['slice', builtin([RV_TYPE, RV_SLICE], [RV_TYPE, ERROR_TYPE], ([item, ...indexes]) => slice(item, indexes))],
  ['js', builtin([ANY_SLICE], [BASIC.string], (args) => [stringRV(jsEscapeString(evalArgs(args))), undefined])],
  ['len', fixed([RV_TYPE], [BASIC.int, ERROR_TYPE], ([item]) => length(item))],
  ['not', fixed([RV_TYPE], [BASIC.bool], ([arg]) => [boolRV(!truth(arg)), undefined])],
  ['or', builtin([RV_TYPE, RV_SLICE], [RV_TYPE], unreachable)],
  ['print', builtin([ANY_SLICE], [BASIC.string], (args) => [stringRV(new Printer().print(anys(args))), undefined])],
  [
    'printf',
    builtin([BASIC.string, ANY_SLICE], [BASIC.string], ([format, ...args]) => [
      stringRV(new Printer().printf((format as RV).value as string, anys(args))),
      undefined,
    ]),
  ],
  ['println', builtin([ANY_SLICE], [BASIC.string], (args) => [stringRV(new Printer().println(anys(args))), undefined])],
  ['urlquery', builtin([ANY_SLICE], [BASIC.string], (args) => [stringRV(queryEscape(evalArgs(args))), undefined])],
  ['eq', builtin([RV_TYPE, RV_SLICE], [BASIC.bool, ERROR_TYPE], ([arg1, ...arg2]) => boolResult(() => eq(arg1, arg2)))],
  ['ge', comparison((a, b) => !lt(a, b))],
  ['gt', comparison((a, b) => !le(a, b))],
  ['le', comparison(le)],
  ['lt', comparison(lt)],
  ['ne', comparison((a, b) => !eq(a, [b]))],
]);

/** The function `call` runs, which receives the name of the function it calls first. */
export const CALL_FUNC: RV = builtin([BASIC.string, RV_TYPE, RV_SLICE], [RV_TYPE, ERROR_TYPE], ([name, fn, ...args]) =>
  call((name as RV).value as string, fn, args)
);

function comparison(compare: (a: RValue, b: RValue) => boolean): RV {
  return fixed([RV_TYPE, RV_TYPE], [BASIC.bool, ERROR_TYPE], ([a, b]) => boolResult(() => compare(a, b)));
}

function boolResult(compute: () => boolean): CallResult {
  return [boolRV(compute()), undefined];
}

function stringRV(text: string): RV {
  return { type: BASIC.string, value: text };
}

function boolRV(value: boolean): RV {
  return { type: BASIC.bool, value };
}

function anys(args: RValue[]): Value[] {
  return args.map((arg) => toGoValue(arg, ANY));
}

// Checks of functions (funcs.go) ----------------------------------------------------------------------------------

/** `goodFunc`: whether a function returns one value, or a value and an error; the message says why not. */
export function goodFunc(name: string, type: FuncType): string | undefined {
  const numOut = type.results.length;
  if (numOut === 1) return undefined;
  if (numOut === 2 && identical(type.results[1], ERROR_TYPE)) return undefined;
  if (numOut === 2) {
    return sprintf(
      'invalid function signature for %s: second return value should be error; is %s',
      name,
      typeString(type.results[1])
    );
  }
  return sprintf('function %s has %d return values; should be 1 or 2', name, numOut);
}

/** `goodName`: whether a function name is an identifier. */
export function goodName(name: string): boolean {
  if (name === '') return false;
  for (let index = 0; index < name.length;) {
    const { rune, size } = decodeRune(name, index);
    if (rune !== 0x5f && ((index === 0 && !isLetter(rune)) || (!isLetter(rune) && !isDigit(rune)))) return false;
    index += size;
  }
  return true;
}

// Calls ----------------------------------------------------------------------------------------------------------

/**
 * `safeCall`: calls a function with arguments of its parameter types, turning a panic into the error it returns.
 * A Go function receives the arguments of its variadic parameter as one slice.
 */
export function safeCall(fun: RV, args: RValue[]): CallResult {
  try {
    if (fun.value instanceof BuiltinFunc) return fun.value.impl(args);
    return callGo(fun, args);
  } catch (error) {
    if (error instanceof BuiltinError) return [undefined, newError(error.message)];
    if (error instanceof GoPanic && !(error instanceof BranchPanic)) return [undefined, panicError(error.value)];
    throw error;
  }
}

function callGo(fun: RV, args: RValue[]): CallResult {
  const type = funcTypeOf(fun);
  const fn = fun.value as GoFunc | undefined;
  if (!fn) throw new BuiltinError('reflect.Value.Call: call of nil function');
  const values: Value[] = [];
  const fixedCount = type.variadic ? type.params.length - 1 : type.params.length;
  for (let position = 0; position < fixedCount; position++)
    values.push(toGoValue(args[position], type.params[position]));
  if (type.variadic) {
    const element = (underlying(type.params[fixedCount]) as SliceType).element;
    const rest = args.slice(fixedCount).map((arg) => toGoValue(arg, element));
    values.push(new Slice(rest, 0, rest.length, rest.length));
  }
  const returned = fn.call(values);
  const results = type.results.length === 1 ? [returned as Value] : (returned as Value[]);
  const result: RV = { type: type.results[0], value: results[0] };
  return [result, type.results.length === 2 ? results[1] : undefined];
}

/** The error `safeCall` returns for a panic: the panic's error, or its value formatted with %v. */
function panicError(value: Value): Value {
  if (value instanceof Iface && implementsError(value.type)) return value;
  return newError(new Printer().printf('%v', [value]));
}

/** A `{{break}}` or `{{continue}}`, which Go raises as a panic with the error "break" or "continue". */
export class BranchPanic extends GoPanic {
  constructor(readonly branch: 'break' | 'continue') {
    super(newError(branch));
  }
}

/** `call`: calls the function value `fn` with the arguments. */
function call(name: string, fnArg: RValue, args: RValue[]): CallResult {
  const fn = indirectInterface(fnArg);
  if (!fn) fail('call of nil');
  if (kindOf(fn) !== 'func') fail('non-function %s of type %s', name, typeString(fn.type));
  const type = funcTypeOf(fn);
  const bad = goodFunc(name, type);
  if (bad) throw new BuiltinError(bad);
  const numIn = type.params.length;
  let dddType: Type | undefined;
  if (type.variadic) {
    if (args.length < numIn - 1)
      fail('wrong number of args for %s: got %d want at least %d', name, args.length, numIn - 1);
    dddType = (underlying(type.params[numIn - 1]) as SliceType).element;
  } else if (args.length !== numIn) {
    fail('wrong number of args for %s: got %d want %d', name, args.length, numIn);
  }
  const argv = args.map((arg, position) => {
    const argType = !type.variadic || position < numIn - 1 ? type.params[position] : (dddType as Type);
    const [prepared, error] = prepareArg(indirectInterface(arg), argType);
    if (error !== undefined) fail('arg %d: %s', position, error);
    return prepared;
  });
  return safeCall(fn, argv);
}

function prepareArg(value: RValue, argType: Type): [RValue, string | undefined] {
  let current = value;
  if (!current) {
    if (!canBeNil(argType)) return [undefined, sprintf('value is nil; should be of type %s', typeString(argType))];
    current = zeroRV(argType) as RV;
  }
  if (assignableTo(current.type, argType)) return [current, undefined];
  if (intLike(current) && ['int', 'uint'].includes(typeKind(argType)))
    return [convertInteger(current, argType), undefined];
  return [undefined, sprintf('value has type %s; should be %s', typeString(current.type), typeString(argType))];
}

function intLike(value: RValue): boolean {
  const kind = kindOf(value);
  return kind === 'int' || kind === 'uint';
}

// Indexing ---------------------------------------------------------------------------------------------------------

function indexArg(index: RValue, cap: number): number {
  let x: bigint;
  const kind = kindOf(index);
  if (kind === 'int') x = integerOf(index as RV);
  else if (kind === 'uint') x = BigInt.asIntN(64, integerOf(index as RV));
  else if (kind === 'invalid') return fail('cannot index slice/array with nil');
  else return fail('cannot index slice/array with type %s', typeString((index as RV).type));
  if (x < 0n || x > BigInt(cap)) fail('index out of range: %d', new Iface(BASIC.int64, x));
  return Number(x);
}

function index(itemArg: RValue, indexes: RValue[]): CallResult {
  let item = indirectInterface(itemArg);
  if (!item) fail('index of untyped nil');
  for (const indexArgument of indexes) {
    const position = indirectInterface(indexArgument);
    const [target, isNil] = indirect(item);
    if (isNil) fail('index of nil pointer');
    item = target as RV;
    switch (kindOf(item)) {
      case 'array':
      case 'slice':
      case 'string': {
        item = indexOf(item, indexArg(position, lengthOf(item)));
        break;
      }
      case 'map': {
        const keyType = (underlying(item.type) as { key: Type }).key;
        const [key, error] = prepareArg(position, keyType);
        if (error !== undefined) fail('%s', error);
        item =
          mapIndex(item, toGoValue(key, keyType)) ?? (zeroRV((underlying(item.type) as { value: Type }).value) as RV);
        break;
      }
      default: {
        fail("can't index item of type %s", typeString(item.type));
      }
    }
  }
  return [item, undefined];
}

function slice(itemArg: RValue, indexes: RValue[]): CallResult {
  const direct = indirectInterface(itemArg);
  if (!direct) fail('slice of untyped nil');
  const [target, isNil] = indirect(direct);
  if (isNil) fail('slice of nil pointer');
  const item = target as RV;
  if (indexes.length > 3) fail('too many slice indexes: %d', indexes.length);
  let cap: number;
  const kind = kindOf(item);
  if (kind === 'string') {
    if (indexes.length === 3) fail('cannot 3-index slice a string');
    cap = lengthOf(item);
  } else if (kind === 'array' || kind === 'slice') {
    cap = capOf(item);
  } else {
    return fail("can't slice item of type %s", typeString(item.type));
  }
  const idx = [0, lengthOf(item), 0];
  for (const [position, value] of indexes.entries()) idx[position] = indexArg(value, cap);
  if (idx[0] > idx[1]) fail('invalid slice index: %d > %d', idx[0], idx[1]);
  if (indexes.length < 3) return [sliceOf3(item, idx[0], idx[1], cap), undefined];
  if (idx[1] > idx[2]) fail('invalid slice index: %d > %d', idx[1], idx[2]);
  return [sliceOf3(item, idx[0], idx[1], idx[2]), undefined];
}

/** `Value.Slice` and `Value.Slice3`. */
function sliceOf3(item: RV, low: number, high: number, max: number): RV {
  const kind = kindOf(item);
  if (kind === 'string') return { type: item.type, value: (item.value as string).slice(low, high) };
  if (kind === 'array') {
    if (!item.addr) fail('reflect.Value.Slice: slice of unaddressable array');
    const element = (underlying(item.type) as { element: Type }).element;
    const elements = (item.value as { elements: Value[] }).elements;
    return { type: sliceOf(element), value: new Slice(elements, low, high - low, max - low) };
  }
  const value = item.value as Slice | undefined;
  if (!value) return { type: item.type, value: undefined };
  return { type: item.type, value: new Slice(value.array, value.offset + low, high - low, max - low) };
}

function length(itemArg: RValue): CallResult {
  const [item, isNil] = indirect(itemArg);
  if (isNil) fail('len of nil pointer');
  if (!item) fail('reflect: call of reflect.Value.Type on zero Value');
  if (['array', 'map', 'slice', 'string'].includes(kindOf(item))) {
    return [{ type: BASIC.int, value: BigInt(lengthOf(item)) }, undefined];
  }
  return fail('len of type %s', typeString(item.type));
}

// Booleans and comparisons -----------------------------------------------------------------------------------------

/** `isTrue`: whether a value is non-empty, and whether its kind has truth at all. */
export function isTrue(value: RValue): [boolean, boolean] {
  if (!value) return [false, true];
  const raw = value.value;
  switch (kindOf(value)) {
    case 'array':
    case 'map':
    case 'slice':
    case 'string': {
      return [lengthOf(value) > 0, true];
    }
    case 'bool': {
      return [raw as boolean, true];
    }
    case 'complex': {
      return [(raw as Complex).re !== 0 || (raw as Complex).im !== 0, true];
    }
    case 'func':
    case 'pointer':
    case 'interface': {
      return [!isNilValue(value), true];
    }
    case 'int':
    case 'uint': {
      return [raw !== 0n, true];
    }
    case 'float': {
      return [raw !== 0, true];
    }
    case 'struct': {
      return [true, true];
    }
    default: {
      return [false, false];
    }
  }
}

export function truth(value: RValue): boolean {
  return isTrue(indirectInterface(value))[0];
}

type BasicKind = 'invalid' | 'bool' | 'complex' | 'int' | 'float' | 'string' | 'uint';

function basicKind(value: RValue): BasicKind {
  const kind = kindOf(value);
  return ['bool', 'complex', 'int', 'float', 'string', 'uint'].includes(kind) ? (kind as BasicKind) : 'invalid';
}

const ERR_BAD_COMPARISON_TYPE = 'invalid type for comparison';

function eq(arg1Value: RValue, arg2: RValue[]): boolean {
  const arg1 = indirectInterface(arg1Value);
  if (arg2.length === 0) fail('missing argument for comparison');
  const k1 = basicKind(arg1);
  for (const argValue of arg2) {
    const arg = indirectInterface(argValue);
    const k2 = basicKind(arg);
    let result = false;
    if (k1 === k2) {
      result = equalSameKind(k1, arg1, arg);
    } else if (k1 === 'int' && k2 === 'uint') {
      result = integerOf(arg1 as RV) >= 0n && BigInt.asUintN(64, integerOf(arg1 as RV)) === integerOf(arg as RV);
    } else if (k1 === 'uint' && k2 === 'int') {
      result = integerOf(arg as RV) >= 0n && integerOf(arg1 as RV) === BigInt.asUintN(64, integerOf(arg as RV));
    } else if (arg1 && arg) {
      fail('incompatible types for comparison: %v and %v', typeString(arg1.type), typeString(arg.type));
    }
    if (result) return true;
  }
  return false;
}

function equalSameKind(kind: BasicKind, arg1: RValue, arg: RValue): boolean {
  if (kind === 'complex') {
    const [a, b] = [(arg1 as RV).value as Complex, (arg as RV).value as Complex];
    return a.re === b.re && a.im === b.im;
  }
  if (kind !== 'invalid') return (arg1 as RV).value === (arg as RV).value;
  if (kindOf(arg1) !== kindOf(arg) && arg1 && arg) {
    fail('non-comparable types %s: %v, %s: %v', shown(arg1), typeString(arg1.type), typeString(arg.type), shown(arg));
  }
  const nil1 = isNil(arg1);
  const nil2 = isNil(arg);
  if (nil1 || nil2) return nil1 === nil2;
  const [a, b] = [arg1 as RV, arg as RV];
  if (!isComparable(b.type)) fail('non-comparable type %s: %v', shown(b), typeString(b.type));
  return identical(a.type, b.type) && equalityOf(a.type)(a.value, b.value);
}

function isNil(value: RValue): boolean {
  if (!value) return true;
  return ['func', 'interface', 'map', 'pointer', 'slice'].includes(kindOf(value)) && isNilValue(value);
}

function lt(arg1Value: RValue, arg2Value: RValue): boolean {
  const arg1 = indirectInterface(arg1Value);
  const k1 = basicKind(arg1);
  if (k1 === 'invalid') fail(ERR_BAD_COMPARISON_TYPE);
  const arg2 = indirectInterface(arg2Value);
  const k2 = basicKind(arg2);
  if (k2 === 'invalid') fail(ERR_BAD_COMPARISON_TYPE);
  const [a, b] = [arg1 as RV, arg2 as RV];
  if (k1 !== k2) {
    if (k1 === 'int' && k2 === 'uint') return integerOf(a) < 0n || BigInt.asUintN(64, integerOf(a)) < integerOf(b);
    if (k1 === 'uint' && k2 === 'int') return integerOf(b) >= 0n && integerOf(a) < BigInt.asUintN(64, integerOf(b));
    return fail('incompatible types for comparison: %v and %v', typeString(a.type), typeString(b.type));
  }
  if (k1 === 'bool' || k1 === 'complex') return fail(ERR_BAD_COMPARISON_TYPE);
  return (a.value as number | bigint | string) < (b.value as number | bigint | string);
}

function le(arg1: RValue, arg2: RValue): boolean {
  return lt(arg1, arg2) || eq(arg1, [arg2]);
}

// Escaping ---------------------------------------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '\0': String.fromCharCode(0xef, 0xbf, 0xbd),
  '"': '&#34;',
  "'": '&#39;',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

/** `HTMLEscape`, which writes the text between escapes and each escape with separate writes. */
export function htmlEscape(write: (bytes: string) => void, bytes: string): void {
  let last = 0;
  for (let position = 0; position < bytes.length; position++) {
    const html = HTML_ESCAPES[bytes[position]];
    if (html === undefined) continue;
    write(bytes.slice(last, position));
    write(html);
    last = position + 1;
  }
  write(bytes.slice(last));
}

export function htmlEscapeString(text: string): string {
  if (!/['"&<>\0]/.test(text)) return text;
  let result = '';
  htmlEscape((bytes) => (result += bytes), text);
  return result;
}

const BACKSLASH = '\\';
const HEX = '0123456789ABCDEF';

const JS_ESCAPES: Record<string, string> = {
  '\\': BACKSLASH + BACKSLASH,
  "'": `${BACKSLASH}'`,
  '"': `${BACKSLASH}"`,
  '<': `${BACKSLASH}u003C`,
  '>': `${BACKSLASH}u003E`,
  '&': `${BACKSLASH}u0026`,
  '=': `${BACKSLASH}u003D`,
};

/** `JSEscape`, which writes the text between escapes and each escape with separate writes. */
export function jsEscape(write: (bytes: string) => void, bytes: string): void {
  let last = 0;
  for (let position = 0; position < bytes.length; position++) {
    const c = bytes.charCodeAt(position);
    if (!jsIsSpecial(c)) continue;
    write(bytes.slice(last, position));
    if (c < 0x80) {
      write(JS_ESCAPES[bytes[position]] ?? `${BACKSLASH}u00${HEX[c >> 4]}${HEX[c & 0x0f]}`);
    } else {
      const { rune, size } = decodeRune(bytes, position);
      if (isPrint(rune)) write(bytes.slice(position, position + size));
      else write(sprintf(`${BACKSLASH}u%04X`, rune));
      position += size - 1;
    }
    last = position + 1;
  }
  write(bytes.slice(last));
}

export function jsEscapeString(text: string): string {
  let special = false;
  for (let position = 0; position < text.length && !special; position++)
    special = jsIsSpecial(text.charCodeAt(position));
  if (!special) return text;
  let result = '';
  jsEscape((bytes) => (result += bytes), text);
  return result;
}

function jsIsSpecial(c: number): boolean {
  return String.raw`\'"<>&=`.includes(String.fromCharCode(c)) || c < 0x20 || c >= 0x80;
}

/** `url.QueryEscape`. */
export function queryEscape(text: string): string {
  let result = '';
  for (const char of text) {
    if (/[A-Za-z0-9\-_.~]/.test(char)) result += char;
    else if (char === ' ') result += '+';
    else result += `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return result;
}

/** `evalArgs`: the text of the arguments of html, js, and urlquery. */
export function evalArgs(args: RValue[]): string {
  const values = args.map((arg) => toGoValue(arg, ANY));
  const [first] = values;
  if (values.length === 1 && first instanceof Iface && isBasic(first.type, 'string') && first.type.kind === 'basic') {
    return first.value as string;
  }
  const printed = values.map((value) => {
    const [printable, ok] = printableValue(valueOf(value));
    return ok ? printable : value;
  });
  return new Printer().print(printed);
}

/** `printableValue`: the value fmt prints for a value, which uses an addressable value's pointer methods. */
export function printableValue(valueArg: RValue): [Value, boolean] {
  let value = valueArg;
  if (kindOf(value) === 'pointer') [value] = indirect(value);
  if (!value) return [new Iface(BASIC.string, '<no value>'), true];
  if (!implementsError(value.type) && !implementsStringer(value.type)) {
    const pointer = pointerTo(value.type);
    if (value.addr && (implementsError(pointer) || implementsStringer(pointer))) {
      return [new Iface(pointer, value.addr), true];
    }
    if (kindOf(value) === 'func') return [undefined, false];
  }
  return [interfaceOf(value), true];
}
