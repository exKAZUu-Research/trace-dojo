// code-gauge-allow-file fileNcss 420 -- The builtins module keeps every builtin function together.
import { bytearrayClass, bytesClass, memoryviewClass, PyBytes } from './bytesValues';
import { complexAbs } from './complexNumbers';
import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { aiter, anext } from './coroutines';
import { builtin } from './define';
import { claimedClass } from './descriptors';
import { compile, COMPILE_KEYWORDS, evaluate, execute } from './dynamicCode';
import { enumMembersOf } from './enums';
import { pyHash } from './hashing';
import { help } from './help';
import { dunderImport } from './modules/importlib';
import { argument, checkArgs } from './nativeArgs';
import { asFloat, divmodFloat, floorDivInt, modInt, toIndex } from './numbers';
import {
  bindValue,
  callValue,
  deleteAttribute,
  getAttribute,
  getAttributeOrUndefined,
  getItem,
  getIterator,
  isCallable,
  isTruthy,
  iterate,
  lengthOf,
  lookupSpecial,
  nextOf,
  setAttribute,
  toArray,
} from './objects';
import { binaryOp, compareOp } from './operators';
import { callerGlobals, callerLocals, callerNames, vars } from './reflection';
import { currentRuntime } from './runtimeContext';
import { iterStr, strLength } from './strings';
import { turtleClass } from './turtle';
import { sortList } from './typeContainers';
import { roundFloat, roundInt } from './typeNumbers';
import { defineIteratorClass, nextValue } from './typeObject';
import {
  boolClass,
  builtinClass,
  classmethodClass,
  classOf,
  complexClass,
  dictClass,
  Ellipsis,
  exceptionClasses,
  floatClass,
  frozensetClass,
  intClass,
  iteratorClass,
  listClass,
  nativeFunction,
  newList,
  newTuple,
  None,
  NotImplemented,
  objectClass,
  propertyClass,
  rangeClass,
  setClass,
  sliceClass,
  staticmethodClass,
  strClass,
  superClass,
  tupleClass,
  typeClass,
  typeError,
  typeName,
  unbox,
  valueError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  DONE,
  type Kwargs,
  PyClass,
  PyComplex,
  PyDict,
  PyIterator,
  PyModule,
  PyOpaque,
  PyTuple,
  type PyValue,
} from './values';

// Iterator classes --------------------------------------------------------------------------------------------------

export const enumerateClass = builtinClass('enumerate');
enumerateClass.construct = (cls, args, kwargs) => {
  const iterable = argument(args, kwargs, 0, 'iterable');
  if (iterable === undefined) throw typeError("enumerate() missing required argument 'iterable'");
  checkArgs({ qualified: 'enumerate', min: 1, max: 2, style: 'takes', keywords: ['iterable', 'start'] }, args, kwargs);
  let index = toIndex(argument(args, kwargs, 1, 'start') ?? 0n);
  const next = iterate(iterable);
  return new PyIterator(
    cls,
    () => {
      const item = next();
      if (item === DONE) return DONE;
      return currentRuntime().tuple([index++, item]);
    },
    () => [iterable]
  );
};

export const zipClass = builtinClass('zip');
// code-gauge-allow duplicateLines 23 -- zip and itertools.zip_longest stop on exhausted iterables differently.
zipClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'zip', min: 0, max: Number.POSITIVE_INFINITY, style: 'takes', keywords: ['strict'] },
    args,
    kwargs
  );
  const strict = isTruthy(kwargs?.get('strict') ?? false);
  const nexts = args.map((iterable) => iterate(iterable));
  let finished = false;
  return new PyIterator(
    cls,
    () => {
      if (finished || nexts.length === 0) return DONE;
      const items: PyValue[] = [];
      for (const [index, next] of nexts.entries()) {
        const item = next();
        if (item === DONE) {
          finished = true;
          if (strict) checkStrictZip(nexts, index);
          return DONE;
        }
        items.push(item);
      }
      return currentRuntime().tuple(items);
    },
    () => args
  );
};

// code-gauge-allow functionCognitiveComplexity 16 -- Words each length mismatch as CPython's strict zip does.
function checkStrictZip(nexts: (() => PyValue | typeof DONE)[], index: number): void {
  if (index > 0) {
    throw valueError(
      `zip() argument ${index + 1} is shorter than argument${index === 1 ? '' : 's'} 1${index > 1 ? `-${index}` : ''}`
    );
  }
  for (const [other, next] of nexts.entries()) {
    if (other === 0) continue;
    if (next() !== DONE) {
      throw valueError(
        `zip() argument ${other + 1} is longer than argument${other === 1 ? '' : 's'} 1${other > 1 ? `-${other}` : ''}`
      );
    }
  }
}

export const mapClass = builtinClass('map');
mapClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'map', min: 0, max: Number.POSITIVE_INFINITY, style: 'takes', keywords: ['strict'] },
    args,
    kwargs
  );
  if (args.length < 2) throw typeError('map() must have at least two arguments.');
  const [fn, ...iterables] = args;
  const nexts = iterables.map((iterable) => iterate(iterable));
  return new PyIterator(
    cls,
    () => {
      const items: PyValue[] = [];
      for (const next of nexts) {
        const item = next();
        if (item === DONE) return DONE;
        items.push(item);
      }
      return callValue(fn, items);
    },
    () => args
  );
};

export const filterClass = builtinClass('filter');
filterClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'filter', min: 2, max: 2, style: 'expected' }, args, kwargs);
  const [fn, iterable] = args;
  const next = iterate(iterable);
  return new PyIterator(
    cls,
    () => {
      for (let item = next(); item !== DONE; item = next()) {
        currentRuntime().spend();
        if (isTruthy(fn === None ? item : callValue(fn, [item]))) return item;
      }
      return DONE;
    },
    () => args
  );
};

export const reversedClass = builtinClass('reversed');
reversedClass.construct = (_cls, args, kwargs) => {
  checkArgs({ qualified: 'reversed', min: 1, max: 1, style: 'expected' }, args, kwargs);
  const [sequence] = args;
  const special = lookupSpecial(sequence, '__reversed__');
  if (special !== undefined && special !== None) return callValue(bindValue(special, sequence), []);
  if (
    special === None ||
    lookupSpecial(sequence, '__getitem__') === undefined ||
    lookupSpecial(sequence, '__len__') === undefined ||
    sequence instanceof PyDict
  ) {
    throw typeError(`'${typeName(sequence)}' object is not reversible`);
  }
  let index = BigInt(lengthOf(sequence)) - 1n;
  return new PyIterator(
    reversedClass,
    () => (index >= 0n ? getItem(sequence, index--) : DONE),
    () => [sequence]
  );
};

for (const cls of [enumerateClass, zipClass, mapClass, filterClass, reversedClass]) defineIteratorClass(cls);

// Functions ---------------------------------------------------------------------------------------------------------

// code-gauge-allow functionCognitiveComplexity 19 -- Follows CPython's print, which writes to a replaced stdout or another file piece by piece.
// code-gauge-allow functionNcss 31 -- Follows CPython's print, which writes to a replaced stdout or another file piece by piece.
function print(args: PyValue[], kwargs: Kwargs): PyValue {
  for (const key of kwargs?.keys() ?? []) {
    if (!['sep', 'end', 'file', 'flush'].includes(key))
      throw typeError(`print() got an unexpected keyword argument '${key}'`);
  }
  const separator = kwargs?.get('sep') ?? None;
  const end = kwargs?.get('end') ?? None;
  if (separator !== None && typeof separator !== 'string')
    throw typeError(`sep must be None or a string, not ${typeName(separator)}`);
  if (end !== None && typeof end !== 'string') throw typeError(`end must be None or a string, not ${typeName(end)}`);
  const runtime = currentRuntime();
  let file = kwargs?.get('file') ?? None;
  // `sys.stdout` may have been replaced, as contextlib.redirect_stdout does.
  if (file === None) file = runtime.modules.get('sys')?.dict.get('stdout') ?? None;
  const sep = typeof separator === 'string' ? separator : ' ';
  const ending = typeof end === 'string' ? end : '\n';
  if (file !== None && file !== runtime.standardStream('stdout') && file !== runtime.standardStream('stderr')) {
    // Another file receives each piece in its own write() call, as CPython writes them.
    const write = getAttribute(file, 'write');
    for (const [index, value] of args.entries()) {
      if (index > 0) callValue(write, [sep]);
      callValue(write, [pyStr(value)]);
    }
    callValue(write, [ending]);
    return None;
  }
  const text = args.map((value) => pyStr(value)).join(sep) + ending;
  runtime.buildString(text.length);
  if (file === runtime.standardStream('stderr')) runtime.errorOutput += text;
  else runtime.budget.print(text);
  return None;
}

// code-gauge-allow functionNcss 33 -- Follows CPython's builtin sum, including its float compensation.
// code-gauge-allow functionCognitiveComplexity 21 -- Follows CPython's builtin sum, including its float compensation.
function sum(args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length === 0) throw typeError('sum() takes at least 1 positional argument (0 given)');
  checkArgs({ qualified: 'sum', min: 1, max: 2, style: 'takes', keywords: ['start'] }, args, kwargs);
  let result = argument(args, kwargs, 1, 'start') ?? 0n;
  if (typeof result === 'string') throw typeError("sum() can't sum strings [use ''.join(seq) instead]");
  const runtime = currentRuntime();
  const next = iterate(args[0]);
  let item = next();
  while (item !== DONE && typeof result === 'bigint' && (typeof item === 'bigint' || typeof item === 'boolean')) {
    runtime.spend();
    result += BigInt(item);
    item = next();
  }
  if (item !== DONE && typeof result === 'bigint') {
    result = binaryOp('+', result, item);
    item = next();
  }
  if (typeof result === 'number') {
    let high = result;
    let low = 0;
    for (; item !== DONE; item = next()) {
      runtime.spend();
      if (typeof item !== 'number' && typeof item !== 'bigint' && typeof item !== 'boolean') break;
      const x = asFloat(item);
      const total = high + x;
      low += Math.abs(high) >= Math.abs(x) ? high - total + x : x - total + high;
      high = total;
    }
    result = low && Number.isFinite(low) ? high + low : high;
  }
  for (; item !== DONE; item = next()) {
    runtime.spend();
    result = binaryOp('+', result, item);
  }
  return result;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Follows CPython's min_max argument checks.
function minMax(name: 'min' | 'max'): (args: PyValue[], kwargs: Kwargs) => PyValue {
  return (args, kwargs) => {
    const unexpected = [...(kwargs?.keys() ?? [])].find((key) => key !== 'key' && key !== 'default');
    if (unexpected !== undefined) throw typeError(`${name}() got an unexpected keyword argument '${unexpected}'`);
    if (args.length === 0) throw typeError(`${name} expected at least 1 argument, got 0`);
    const key = kwargs?.get('key') ?? None;
    const fallback = kwargs?.get('default');
    if (args.length > 1 && fallback !== undefined) {
      throw typeError(`Cannot specify a default for ${name}() with multiple positional arguments`);
    }
    const items = args.length === 1 ? toArray(args[0]) : args;
    if (items.length === 0) {
      if (fallback !== undefined) return fallback;
      throw valueError(`${name}() iterable argument is empty`);
    }
    return bestItem(items, key, name === 'max' ? '>' : '<');
  };
}

function bestItem(items: PyValue[], key: PyValue, operator: '>' | '<'): PyValue {
  let best = items[0];
  let bestKey = key === None ? best : callValue(key, [best]);
  for (const item of items.slice(1)) {
    currentRuntime().spend();
    const itemKey = key === None ? item : callValue(key, [item]);
    if (isTruthy(compareOp(operator, itemKey, bestKey))) {
      best = item;
      bestKey = itemKey;
    }
  }
  return best;
}

function abs([value]: PyValue[]): PyValue {
  if (typeof value === 'bigint') return value < 0n ? -value : value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return Math.abs(value);
  if (value instanceof PyComplex) return complexAbs(value);
  const special = lookupSpecial(value, '__abs__');
  if (special === undefined) throw typeError(`bad operand type for abs(): '${typeName(value)}'`);
  return callValue(bindValue(special, value), []);
}

function isInt(value: PyValue): value is bigint | boolean {
  return typeof value === 'bigint' || typeof value === 'boolean';
}

function divmod([a, b]: PyValue[]): PyValue {
  if (isInt(a) && isInt(b)) return newTuple([floorDivInt(BigInt(a), BigInt(b)), modInt(BigInt(a), BigInt(b))]);
  if ((isInt(a) || typeof a === 'number') && (isInt(b) || typeof b === 'number')) {
    return newTuple(divmodFloat(asFloat(a), asFloat(b)));
  }
  for (const [receiver, name, other] of [
    [a, '__divmod__', b],
    [b, '__rdivmod__', a],
  ] as const) {
    const special = lookupSpecial(receiver, name);
    if (special === undefined) continue;
    const result = callValue(bindValue(special, receiver), [other]);
    if (result !== NotImplemented) return result;
  }
  throw typeError(`unsupported operand type(s) for divmod(): '${typeName(a)}' and '${typeName(b)}'`);
}

function pow(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'pow', min: 0, max: 3, style: 'takes', keywords: ['base', 'exp', 'mod'] }, args, kwargs);
  const base = argument(args, kwargs, 0, 'base');
  const exponent = argument(args, kwargs, 1, 'exp');
  const modulus = argument(args, kwargs, 2, 'mod') ?? None;
  if (base === undefined) throw typeError("pow() missing required argument 'base' (pos 1)");
  if (exponent === undefined) throw typeError("pow() missing required argument 'exp' (pos 2)");
  if (modulus === None) return binaryOp('**', base, exponent);
  const [b, e, m] = [unbox(base), unbox(exponent), unbox(modulus)];
  if (!isInt(b) || !isInt(e) || !isInt(m)) return ternaryPow(base, exponent, modulus);
  return modPow(BigInt(b), BigInt(e), BigInt(m));
}

const isIntOrFloat = (value: PyValue): boolean => isInt(value) || typeof value === 'number';

/** Three-argument pow of non-ints, which `__pow__` of the base or `__rpow__` of the exponent may implement, as CPython's ternary_op does. */
function ternaryPow(base: PyValue, exponent: PyValue, modulus: PyValue): PyValue {
  if (isIntOrFloat(base) && isIntOrFloat(exponent) && isIntOrFloat(modulus)) {
    throw typeError('pow() 3rd argument not allowed unless all arguments are integers');
  }
  const attempts: [PyValue, string, PyValue][] = [
    [base, '__pow__', exponent],
    [exponent, '__rpow__', base],
  ];
  for (const [receiver, name, other] of attempts) {
    const special = isIntOrFloat(receiver) ? undefined : lookupSpecial(receiver, name);
    if (special === undefined) continue;
    const result = callValue(bindValue(special, receiver), [other, modulus]);
    if (result !== NotImplemented) return result;
  }
  throw typeError(
    `unsupported operand type(s) for ** or pow(): '${typeName(base)}', '${typeName(exponent)}', '${typeName(modulus)}'`
  );
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 0n) throw valueError('pow() 3rd argument cannot be 0');
  let b = base;
  let e = exponent;
  if (e < 0n) {
    b = modInverse(b, modulus);
    e = -e;
  }
  const m = modulus < 0n ? -modulus : modulus;
  let result = 1n % m;
  b = ((b % m) + m) % m;
  while (e > 0n) {
    currentRuntime().spend();
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  if (modulus < 0n && result !== 0n) result += modulus;
  return result;
}

function modInverse(value: bigint, modulus: bigint): bigint {
  const m = modulus < 0n ? -modulus : modulus;
  let [oldR, r] = [((value % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  if (oldR !== 1n) throw valueError('base is not invertible for the given modulus');
  return ((oldS % m) + m) % m;
}

function round(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'round', min: 1, max: 2, style: 'takes', keywords: ['number', 'ndigits'] }, args, kwargs);
  const value = argument(args, kwargs, 0, 'number') as PyValue;
  const digits = argument(args, kwargs, 1, 'ndigits');
  if (typeof value === 'bigint' || typeof value === 'boolean') return roundInt(BigInt(value), digits);
  if (typeof value === 'number') return roundFloat(value, digits);
  const special = lookupSpecial(value, '__round__');
  if (special === undefined) throw typeError(`type ${typeName(value)} doesn't define __round__ method`);
  return callValue(bindValue(special, value), digits === undefined ? [] : [digits]);
}

function radix(prefix: string, base: number): (args: PyValue[]) => PyValue {
  return ([value]) => {
    const integer = toIndex(value);
    const magnitude = integer < 0n ? -integer : integer;
    return `${integer < 0n ? '-' : ''}${prefix}${magnitude.toString(base)}`;
  };
}

function chr([value]: PyValue[]): PyValue {
  const code = toIndex(value);
  if (code < 0n || code > 0x10_ff_ffn) throw valueError('chr() arg not in range(0x110000)');
  return String.fromCodePoint(Number(code));
}

function ord([argument]: PyValue[]): PyValue {
  const value = unbox(argument);
  if (argument instanceof PyBytes) {
    if (argument.length === 1) return BigInt(argument.data[0]);
    throw typeError(`ord() expected a character, but string of length ${argument.length} found`);
  }
  if (typeof value !== 'string') throw typeError(`ord() expected string of length 1, but ${typeName(value)} found`);
  const length = strLength(value);
  if (length !== 1) throw typeError(`ord() expected a character, but string of length ${length} found`);
  return BigInt(value.codePointAt(0) as number);
}

/** Whether `value` is an instance of `classInfo`, a class, a tuple of them, or a union. */
export function isInstance(value: PyValue, classInfo: PyValue, name = 'isinstance'): boolean {
  if (classInfo instanceof PyClass) {
    if (classInfo.instanceCheck) return classInfo.instanceCheck(value);
    const cls = classOf(value);
    if (cls === classInfo) return true;
    const check = customCheck(classInfo, '__instancecheck__');
    return check === undefined
      ? cls.isSubclassOf(classInfo) || (claimedClass(value)?.isSubclassOf(classInfo) ?? false)
      : isTruthy(callValue(check, [value]));
  }
  if (classInfo instanceof PyTuple) return classInfo.items.some((item) => isInstance(value, item, name));
  if (classInfo instanceof PyOpaque && Array.isArray(classInfo.data)) {
    return (classInfo.data as PyValue[]).some((item) => isInstance(value, item, name));
  }
  const check = lookupSpecial(classInfo, '__instancecheck__');
  if (check !== undefined) return isTruthy(callValue(bindValue(check, classInfo), [value]));
  throw typeError(`${name}() arg 2 must be a type, a tuple of types, or a union`);
}

/** The bound `__instancecheck__` or `__subclasscheck__` that the metaclass of `cls`, such as `abc.ABCMeta`, defines. */
function customCheck(cls: PyClass, name: string): PyValue | undefined {
  if (cls.cls === typeClass) return undefined;
  const check = cls.cls.lookup(name);
  return check === undefined || check === typeClass.dict.get(name) ? undefined : bindValue(check, cls, cls.cls);
}

function isSubclass(cls: PyValue, classInfo: PyValue): boolean {
  if (classInfo instanceof PyClass) {
    const check = customCheck(classInfo, '__subclasscheck__');
    if (check !== undefined) return isTruthy(callValue(check, [cls]));
  }
  if (!(cls instanceof PyClass)) throw typeError('issubclass() arg 1 must be a class');
  if (classInfo instanceof PyClass) return cls.isSubclassOf(classInfo);
  if (classInfo instanceof PyTuple) return classInfo.items.some((item) => isSubclass(cls, item));
  if (classInfo instanceof PyOpaque && Array.isArray(classInfo.data)) {
    return (classInfo.data as PyValue[]).some((item) => isSubclass(cls, item));
  }
  const check = lookupSpecial(classInfo, '__subclasscheck__');
  if (check !== undefined) return isTruthy(callValue(bindValue(check, classInfo), [cls]));
  throw typeError('issubclass() arg 2 must be a class, a tuple of classes, or a union');
}

function iter(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'iter', min: 1, max: 2, style: 'expected' }, args, kwargs);
  if (args.length === 1) return getIterator(args[0]);
  const [fn, sentinel] = args;
  if (!isCallable(fn)) throw typeError('iter(v, w): v must be callable');
  let finished = false;
  return new PyIterator(
    iteratorClass('callable_iterator'),
    () => {
      if (finished) return DONE;
      const value = callValue(fn, []);
      if (compareOp('==', value, sentinel) === true) {
        finished = true;
        return DONE;
      }
      return value;
    },
    () => [fn, sentinel]
  );
}

function next(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'next', min: 1, max: 2, style: 'expected' }, args, kwargs);
  const [iterator, fallback] = args;
  if (lookupSpecial(iterator, '__next__') === undefined && !(iterator instanceof PyIterator)) {
    throw typeError(`'${typeName(iterator)}' object is not an iterator`);
  }
  if (fallback === undefined) return nextValue(iterator);
  const value = nextOf(iterator)();
  return value === DONE ? fallback : value;
}

function getattr(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'getattr', min: 2, max: 3, style: 'expected' }, args, kwargs);
  const [object, name, fallback] = args;
  if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
  if (fallback === undefined) return getAttribute(object, name);
  return getAttributeOrUndefined(object, name) ?? fallback;
}

function sorted(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'sorted', min: 1, max: 1, style: 'expected', keywords: ['key', 'reverse'] }, args, kwargs);
  const list = newList(toArray(args[0]));
  currentRuntime().allocate(list.items.length + 1);
  sortList(list, kwargs?.get('key') ?? None, isTruthy(kwargs?.get('reverse') ?? false));
  return list;
}

function unsupportedFunction(name: string, feature: string): PyValue {
  return builtin(
    name,
    'expected',
    0,
    Number.POSITIVE_INFINITY,
    () => {
      throw new UnsupportedFeatureError(feature);
    },
    { keywords: [] }
  );
}

function exitFunction(name: string): PyValue {
  return builtin(name, 'expected', 0, 1, (args) => {
    throw currentRuntime().systemExit(args[0]);
  });
}

// The namespace -----------------------------------------------------------------------------------------------------

/** The builtins module's namespace, in CPython's order, which NameError suggestions depend on. */
function one(name: string, run: (args: PyValue[]) => PyValue): PyValue {
  return builtin(name, 'one', 1, 1, run);
}

export function createBuiltins(): Map<string, PyValue> {
  const exceptions = [...exceptionClasses.entries()];
  return new Map<string, PyValue>([
    ['__build_class__', unsupportedFunction('__build_class__', '__build_class__()')],
    ['__import__', nativeFunction('__import__', dunderImport)],
    ['abs', one('abs', abs)],
    ['all', one('all', ([iterable]) => toArray(iterable).every((item) => isTruthy(item)))],
    ['any', one('any', ([iterable]) => toArray(iterable).some((item) => isTruthy(item)))],
    ['ascii', one('ascii', ([value]) => pyAscii(value))],
    ['bin', one('bin', radix('0b', 2))],
    ['breakpoint', unsupportedFunction('breakpoint', 'breakpoint()')],
    ['callable', one('callable', ([value]) => isCallable(value))],
    ['chr', one('chr', chr)],
    ['compile', builtin('compile', 'takes', 0, 6, compile, { keywords: COMPILE_KEYWORDS })],
    [
      'delattr',
      builtin('delattr', 'expected', 2, 2, ([object, name]) => {
        deleteAttribute(object, name as string);
        return None;
      }),
    ],
    [
      'dir',
      builtin('dir', 'expected', 0, 1, (args) => (args.length === 0 ? callerNames() : currentRuntime().dir(args[0]))),
    ],
    ['divmod', builtin('divmod', 'expected', 2, 2, divmod)],
    ['eval', builtin('eval', 'takes', 1, 3, evaluate, { keywords: ['globals', 'locals'] })],
    ['exec', builtin('exec', 'takes', 1, 3, execute, { keywords: ['globals', 'locals', 'closure'] })],
    [
      'format',
      builtin('format', 'expected', 1, 2, ([value, spec]) => {
        if (spec !== undefined && typeof spec !== 'string')
          throw typeError(`format() argument 2 must be str, not ${typeName(spec)}`);
        return pyFormat(value, spec ?? '');
      }),
    ],
    ['getattr', builtin('getattr', 'expected', 2, 3, getattr)],
    ['globals', builtin('globals', 'none', 0, 0, callerGlobals)],
    [
      'hasattr',
      builtin('hasattr', 'expected', 2, 2, ([object, name]) => {
        if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
        // A module attribute this grader lacks exists in CPython, so code may test for it before it uses it.
        if (object instanceof PyModule && object.unsupported.has(name)) return true;
        return getAttributeOrUndefined(object, name) !== undefined;
      }),
    ],
    ['hash', one('hash', ([value]) => pyHash(value))],
    ['hex', one('hex', radix('0x', 16))],
    ['id', one('id', ([value]) => currentRuntime().idOf(value))],
    ['input', unsupportedFunction('input', '標準入力（input()）')],
    ['isinstance', builtin('isinstance', 'expected', 2, 2, ([value, classInfo]) => isInstance(value, classInfo))],
    ['issubclass', builtin('issubclass', 'expected', 2, 2, ([cls, classInfo]) => isSubclass(cls, classInfo))],
    ['iter', builtin('iter', 'expected', 1, 2, iter)],
    ['aiter', one('aiter', ([value]) => aiter(value))],
    ['len', one('len', ([value]) => BigInt(lengthOf(value)))],
    ['locals', builtin('locals', 'none', 0, 0, callerLocals)],
    ['max', builtin('max', 'expected', 0, Number.POSITIVE_INFINITY, minMax('max'), { keywords: ['key', 'default'] })],
    ['min', builtin('min', 'expected', 0, Number.POSITIVE_INFINITY, minMax('min'), { keywords: ['key', 'default'] })],
    ['next', builtin('next', 'expected', 1, 2, next)],
    ['anext', builtin('anext', 'expected', 1, 2, ([iterator, fallback]) => anext(iterator, fallback))],
    ['oct', one('oct', radix('0o', 8))],
    ['ord', one('ord', ord)],
    ['pow', builtin('pow', 'takes', 0, 3, pow, { keywords: ['base', 'exp', 'mod'] })],
    [
      'print',
      builtin('print', 'expected', 0, Number.POSITIVE_INFINITY, print, { keywords: ['sep', 'end', 'file', 'flush'] }),
    ],
    ['repr', one('repr', ([value]) => pyRepr(value))],
    ['round', builtin('round', 'takes', 1, 2, round, { keywords: ['number', 'ndigits'] })],
    [
      'setattr',
      builtin('setattr', 'expected', 3, 3, ([object, name, value]) => {
        if (typeof name !== 'string') throw typeError(`attribute name must be string, not '${typeName(name)}'`);
        setAttribute(object, name, value);
        return None;
      }),
    ],
    ['sorted', builtin('sorted', 'expected', 1, 1, sorted, { keywords: ['key', 'reverse'] })],
    ['sum', builtin('sum', 'takes', 0, 2, sum, { keywords: ['start'] })],
    ['vars', builtin('vars', 'expected', 0, 1, ([value]) => (value === undefined ? callerLocals() : vars(value)))],
    ['None', None],
    ['Ellipsis', Ellipsis],
    ['NotImplemented', NotImplemented],
    ['False', false],
    ['True', true],
    ['bool', boolClass],
    ['memoryview', memoryviewClass],
    ['bytearray', bytearrayClass],
    ['bytes', bytesClass],
    ['classmethod', classmethodClass],
    ['complex', complexClass],
    ['dict', dictClass],
    ['enumerate', enumerateClass],
    ['filter', filterClass],
    ['float', floatClass],
    ['frozenset', frozensetClass],
    ['property', propertyClass],
    ['int', intClass],
    ['list', listClass],
    ['map', mapClass],
    ['object', objectClass],
    ['range', rangeClass],
    ['reversed', reversedClass],
    ['set', setClass],
    ['slice', sliceClass],
    ['staticmethod', staticmethodClass],
    ['str', strClass],
    ['super', superClass],
    ['tuple', tupleClass],
    ['type', typeClass],
    ['zip', zipClass],
    ['__debug__', true],
    ...exceptions.filter(([name]) => !name.includes('Group')),
    ['ExceptionGroup', exceptionClasses.get('ExceptionGroup') as PyValue],
    ['BaseExceptionGroup', exceptionClasses.get('BaseExceptionGroup') as PyValue],
    ['EnvironmentError', exceptionClasses.get('OSError') as PyValue],
    ['IOError', exceptionClasses.get('OSError') as PyValue],
    ['open', unsupportedFunction('open', 'ファイルの読み書き（open()）')],
    ['quit', exitFunction('quit')],
    ['exit', exitFunction('exit')],
    ['help', nativeFunction('help', help)],
    ['Turtle', turtleClass],
  ]);
}

export { enumMembersOf, iterStr };
