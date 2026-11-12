// code-gauge-allow-file fileNcss 405 -- The builtin functions and their namespace belong together.
import { abstractSubclassCheck } from './abstractClasses';
import { complexAbs } from './complexNumbers';
import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { builtin } from './define';
import { enumMembersOf } from './enums';
import { pyHash } from './hashing';
import { argument, checkArgs } from './nativeArgs';
import { asFloat, divmodFloat, floorDivInt, modInt, toIndex } from './numbers';
import {
  attributeName,
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
  iterateEach,
  iterateHeld,
  lengthOf,
  lookupSpecial,
  nextOf,
  setAttribute,
  toArray,
} from './objects';
import { binaryOp, compareOp } from './operators';
import { currentRuntime } from './runtimeContext';
import { iterStr, strLength } from './strings';
import { turtleClass } from './turtle';
import { sortList } from './typeContainers';
import { roundFloat, roundInt } from './typeNumbers';
import { defineIteratorClass, nextValue } from './typeObject';
import {
  argumentTypeName,
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
  valueError,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import { DONE, type Kwargs, PyClass, PyComplex, PyDict, PyIterator, PyObject, PyTuple, type PyValue } from './values';

// Iterator classes --------------------------------------------------------------------------------------------------

export const enumerateClass = builtinClass('enumerate');
enumerateClass.construct = (cls, args, kwargs) => {
  checkEnumerateArgs(args.length, [...(kwargs?.keys() ?? [])]);
  const { next, held } = iterateHeld(argument(args, kwargs, 0, 'iterable') as PyValue);
  let index = toIndex(argument(args, kwargs, 1, 'start') ?? 0n);
  return new PyIterator(
    cls,
    () => {
      const item = next();
      if (item === DONE) return DONE;
      return currentRuntime().tuple([index++, item]);
    },
    () => [held]
  );
};

/** Follows enumerate's own argument parser (enum_vectorcall in Objects/enumobject.c). */
function checkEnumerateArgs(count: number, keywords: string[]): void {
  const given = count + keywords.length;
  if (given === 0 || (given > 2 && count === 0)) throw typeError("enumerate() missing required argument 'iterable'");
  if (given > 2) throw typeError(`enumerate() takes at most 2 arguments (${given} given)`);
  const expected = keywords[0] === 'start' && given === 2 ? ['start', 'iterable'] : ['iterable', 'start'].slice(count);
  const wrong = keywords.find((keyword, index) => keyword !== expected[index]);
  if (wrong !== undefined) throw typeError(`'${wrong}' is an invalid keyword argument for enumerate()`);
}

export const zipClass = builtinClass('zip');
// code-gauge-allow duplicateLines 27 -- zip yields tuples where map calls a function, and itertools.zip_longest stops differently.
zipClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'zip', min: 0, max: Number.POSITIVE_INFINITY, style: 'takes', keywords: ['strict'] },
    args,
    kwargs
  );
  const strict = isTruthy(kwargs?.get('strict') ?? false);
  const { nexts, held } = iterateEach(args);
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
          if (strict) checkStrictLengths('zip', nexts, index);
          return DONE;
        }
        items.push(item);
      }
      return currentRuntime().tuple(items);
    },
    held
  );
};

/** Raises the error of a strict `zip` or `map` whose iterable at `index` ended first, unless all end together. */
function checkStrictLengths(name: 'zip' | 'map', nexts: (() => PyValue | typeof DONE)[], index: number): void {
  const mismatch = (position: number, relation: string): Error =>
    valueError(
      `${name}() argument ${position + 1} is ${relation} than argument${position === 1 ? '' : 's'} 1${position > 1 ? `-${position}` : ''}`
    );
  if (index > 0) throw mismatch(index, 'shorter');
  for (const [other, next] of nexts.entries()) {
    if (other > 0 && next() !== DONE) throw mismatch(other, 'longer');
  }
}

export const mapClass = builtinClass('map');
// code-gauge-allow duplicateLines 25 -- map calls a function where zip yields tuples.
mapClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'map', min: 0, max: Number.POSITIVE_INFINITY, style: 'takes', keywords: ['strict'] },
    args,
    kwargs
  );
  if (args.length < 2) throw typeError('map() must have at least two arguments.');
  const [fn, ...iterables] = args;
  const strict = isTruthy(kwargs?.get('strict') ?? false);
  const { nexts, held } = iterateEach(iterables);
  return new PyIterator(
    cls,
    () => {
      const items: PyValue[] = [];
      for (const [index, next] of nexts.entries()) {
        const item = next();
        if (item === DONE) {
          if (strict) checkStrictLengths('map', nexts, index);
          return DONE;
        }
        items.push(item);
      }
      return callValue(fn, items);
    },
    () => [fn, ...held()]
  );
};

export const filterClass = builtinClass('filter');
filterClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'filter', min: 2, max: 2, style: 'expected' }, args, kwargs);
  const [fn, iterable] = args;
  const { next, held } = iterateHeld(iterable);
  return new PyIterator(
    cls,
    () => {
      for (let item = next(); item !== DONE; item = next()) {
        currentRuntime().spend();
        if (isTruthy(fn === None ? item : callValue(fn, [item]))) return item;
      }
      return DONE;
    },
    () => [fn, held]
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
  const iterator = new PyIterator(
    reversedClass,
    () => (index >= 0n ? getItem(sequence, index--) : DONE),
    () => [sequence]
  );
  iterator.lengthHint = () => (index >= 0n ? Number(index) + 1 : 0);
  return iterator;
};

for (const cls of [enumerateClass, zipClass, mapClass, filterClass, reversedClass]) defineIteratorClass(cls);

// Functions ---------------------------------------------------------------------------------------------------------

function print(args: PyValue[], kwargs: Kwargs): PyValue {
  const { separator, end } = printTexts(kwargs);
  const file = kwargs?.get('file') ?? None;
  const runtime = currentRuntime();
  const isStdout = file === None || file === runtime.standardStream('stdout');
  // Each piece is written on its own, as CPython writes them, so that the output limit ends a huge print early.
  const write = (text: string): void => {
    if (isStdout) runtime.budget.print(text);
    else callValue(getAttribute(file, 'write'), [text]);
  };
  for (const [index, value] of args.entries()) {
    if (index > 0) write(separator);
    write(pyStr(value));
  }
  write(end);
  return None;
}

/** The separator and the end of a print call, after the checks CPython makes on its keywords. */
function printTexts(kwargs: Kwargs): { separator: string; end: string } {
  for (const key of kwargs?.keys() ?? []) {
    if (!['sep', 'end', 'file', 'flush'].includes(key))
      throw typeError(`print() got an unexpected keyword argument '${key}'`);
  }
  const separator = kwargs?.get('sep') ?? None;
  const end = kwargs?.get('end') ?? None;
  if (separator !== None && typeof separator !== 'string')
    throw typeError(`sep must be None or a string, not ${typeName(separator)}`);
  if (end !== None && typeof end !== 'string') throw typeError(`end must be None or a string, not ${typeName(end)}`);
  return { separator: typeof separator === 'string' ? separator : ' ', end: typeof end === 'string' ? end : '\n' };
}

// code-gauge-allow functionNcss 33 -- Follows CPython's builtin sum, including its float compensation.
// code-gauge-allow functionCognitiveComplexity 21 -- Follows CPython's builtin sum, including its float compensation.
function sum(args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length === 0) throw typeError('sum() takes at least 1 positional argument (0 given)');
  checkArgs({ qualified: 'sum', min: 1, max: 2, style: 'takes', keywords: ['start'], named: 1 }, args, kwargs);
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

function minMax(name: 'min' | 'max'): (args: PyValue[], kwargs: Kwargs) => PyValue {
  return (args, kwargs) => {
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
  checkArgs(
    { qualified: 'pow', min: 2, max: 3, style: 'takes', keywords: ['base', 'exp', 'mod'], named: 3 },
    args,
    kwargs
  );
  const base = argument(args, kwargs, 0, 'base');
  const exponent = argument(args, kwargs, 1, 'exp');
  const modulus = argument(args, kwargs, 2, 'mod') ?? None;
  if (base === undefined) throw typeError("pow() missing required argument 'base' (pos 1)");
  if (exponent === undefined) throw typeError("pow() missing required argument 'exp' (pos 2)");
  if (modulus === None) return binaryOp('**', base, exponent);
  if (!isInt(base) || !isInt(exponent) || !isInt(modulus)) {
    throw typeError('pow() 3rd argument not allowed unless all arguments are integers');
  }
  return modPow(BigInt(base), BigInt(exponent), BigInt(modulus));
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
  const cost = stepCost(m);
  while (e > 0n) {
    currentRuntime().spend(cost);
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
  const cost = stepCost(m);
  while (r !== 0n) {
    currentRuntime().spend(cost);
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  if (oldR !== 1n) throw valueError('base is not invertible for the given modulus');
  return ((oldS % m) + m) % m;
}

/** The budget one step of modular arithmetic costs, which grows with the size of the modulus. */
function stepCost(modulus: bigint): number {
  return 1 + Math.floor((modulus.toString(16).length * 4) / 8192);
}

function round(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs(
    { qualified: 'round', min: 1, max: 2, style: 'takes', keywords: ['number', 'ndigits'], named: 2 },
    args,
    kwargs
  );
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

function ord([value]: PyValue[]): PyValue {
  if (typeof value !== 'string') throw typeError(`ord() expected string of length 1, but ${typeName(value)} found`);
  const length = strLength(value);
  if (length !== 1) throw typeError(`ord() expected a character, but string of length ${length} found`);
  return BigInt(value.codePointAt(0) as number);
}

/** Whether `value` is an instance of `classInfo`, a class, a tuple of them, or a union. */
export function isInstance(value: PyValue, classInfo: PyValue, name = 'isinstance'): boolean {
  if (classInfo instanceof PyClass) return isSubclassOfClass(classOf(value), classInfo);
  if (classInfo instanceof PyTuple) return classInfo.items.some((item) => isInstance(value, item, name));
  const check = classInfo instanceof PyObject ? classInfo.cls.subclassCheck : undefined;
  if (check) return check(classInfo, classOf(value), 'isinstance');
  throw typeError(`${name}() arg 2 must be a type, a tuple of types, or a union`);
}

/** `issubclass(cls, classInfo)`, which an abstract base class decides with its own rules. */
export function isSubclassOfClass(cls: PyClass, classInfo: PyClass): boolean {
  if (classInfo.abc) return abstractSubclassCheck(classInfo, cls, isSubclassOfClass);
  return cls.isSubclassOf(classInfo);
}

function isSubclass(cls: PyValue, classInfo: PyValue): boolean {
  if ((classInfo instanceof PyClass || classInfo instanceof PyTuple) && !(cls instanceof PyClass)) {
    throw typeError('issubclass() arg 1 must be a class');
  }
  if (classInfo instanceof PyClass) return isSubclassOfClass(cls as PyClass, classInfo);
  if (classInfo instanceof PyTuple) return classInfo.items.some((item) => isSubclass(cls, item));
  const check = classInfo instanceof PyObject ? classInfo.cls.subclassCheck : undefined;
  if (check) {
    if (!(cls instanceof PyClass)) throw typeError('issubclass() arg 1 must be a class');
    return check(classInfo, cls, 'issubclass');
  }
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
  const [object, nameValue, fallback] = args;
  const name = attributeName(nameValue);
  if (fallback === undefined) return getAttribute(object, name);
  return getAttributeOrUndefined(object, name) ?? fallback;
}

function sorted(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'sorted', min: 1, max: 1, style: 'expected' }, args, undefined);
  // The keywords go to list.sort, which reports the wrong ones under its own name.
  checkArgs({ qualified: 'sort', min: 0, max: 0, style: 'takes', keywords: ['key', 'reverse'] }, [], kwargs);
  const list = newList(toArray(args[0]));
  sortList(list, kwargs?.get('key') ?? None, isTruthy(kwargs?.get('reverse') ?? false));
  return list;
}

function vars(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'vars', min: 0, max: 1, style: 'expected' }, args, kwargs);
  if (args.length === 0) return currentRuntime().localsOfCaller();
  const dict = getAttributeOrUndefined(args[0], '__dict__');
  if (dict === undefined) throw typeError('vars() argument must have __dict__ attribute');
  return dict;
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

/** Whether an item passes the test, taking no item after the first that does, as `all` and `any` stop. */
function someItem(iterable: PyValue, test: (item: PyValue) => boolean): boolean {
  const next = iterate(iterable);
  const runtime = currentRuntime();
  for (let item = next(); item !== DONE; item = next()) {
    runtime.spend();
    if (test(item)) return true;
  }
  return false;
}

// The namespace -----------------------------------------------------------------------------------------------------

/** The builtins module's namespace, in CPython's order, which NameError suggestions depend on. */
function one(name: string, run: (args: PyValue[]) => PyValue): PyValue {
  return builtin(name, 'one', 1, 1, run);
}

export function createBuiltins(): Map<string, PyValue> {
  const exceptions = [...exceptionClasses.entries()];
  return new Map<string, PyValue>([
    ['abs', one('abs', abs)],
    ['all', one('all', ([iterable]) => !someItem(iterable, (item) => !isTruthy(item)))],
    ['any', one('any', ([iterable]) => someItem(iterable, isTruthy))],
    ['ascii', one('ascii', ([value]) => pyAscii(value))],
    ['bin', one('bin', radix('0b', 2))],
    ['breakpoint', unsupportedFunction('breakpoint', 'breakpoint()')],
    ['callable', one('callable', ([value]) => isCallable(value))],
    ['chr', one('chr', chr)],
    ['compile', unsupportedFunction('compile', 'compile()')],
    [
      'delattr',
      builtin('delattr', 'expected', 2, 2, ([object, name]) => {
        deleteAttribute(object, attributeName(name));
        return None;
      }),
    ],
    ['dir', builtin('dir', 'expected', 0, 1, (args) => currentRuntime().dir(args[0]))],
    ['divmod', builtin('divmod', 'expected', 2, 2, divmod)],
    ['eval', unsupportedFunction('eval', 'eval()')],
    ['exec', unsupportedFunction('exec', 'exec()')],
    [
      'format',
      builtin('format', 'expected', 1, 2, ([value, spec]) => {
        if (spec !== undefined && typeof spec !== 'string')
          throw typeError(`format() argument 2 must be str, not ${argumentTypeName(spec)}`);
        return pyFormat(value, spec ?? '');
      }),
    ],
    ['getattr', builtin('getattr', 'expected', 2, 3, getattr)],
    ['globals', unsupportedFunction('globals', 'globals()')],
    [
      'hasattr',
      builtin('hasattr', 'expected', 2, 2, ([object, name]) => {
        return getAttributeOrUndefined(object, attributeName(name)) !== undefined;
      }),
    ],
    ['hash', one('hash', ([value]) => pyHash(value))],
    ['hex', one('hex', radix('0x', 16))],
    ['id', one('id', ([value]) => currentRuntime().idOf(value))],
    ['input', unsupportedFunction('input', '標準入力（input()）')],
    ['isinstance', builtin('isinstance', 'expected', 2, 2, ([value, classInfo]) => isInstance(value, classInfo))],
    ['issubclass', builtin('issubclass', 'expected', 2, 2, ([cls, classInfo]) => isSubclass(cls, classInfo))],
    ['iter', builtin('iter', 'expected', 1, 2, iter)],
    ['aiter', unsupportedFunction('aiter', 'aiter()')],
    ['len', one('len', ([value]) => BigInt(lengthOf(value)))],
    ['locals', unsupportedFunction('locals', 'locals()')],
    ['max', builtin('max', 'expected', 1, Number.POSITIVE_INFINITY, minMax('max'), { keywords: ['key', 'default'] })],
    ['min', builtin('min', 'expected', 1, Number.POSITIVE_INFINITY, minMax('min'), { keywords: ['key', 'default'] })],
    ['next', builtin('next', 'expected', 1, 2, next)],
    ['anext', unsupportedFunction('anext', 'anext()')],
    ['oct', one('oct', radix('0o', 8))],
    ['ord', one('ord', ord)],
    ['pow', builtin('pow', 'takes', 2, 3, pow, { keywords: ['base', 'exp', 'mod'], named: 3 })],
    [
      'print',
      builtin('print', 'expected', 0, Number.POSITIVE_INFINITY, print, { keywords: ['sep', 'end', 'file', 'flush'] }),
    ],
    ['repr', one('repr', ([value]) => pyRepr(value))],
    ['round', builtin('round', 'takes', 1, 2, round, { keywords: ['number', 'ndigits'], named: 2 })],
    [
      'setattr',
      builtin('setattr', 'expected', 3, 3, ([object, name, value]) => {
        setAttribute(object, attributeName(name), value);
        return None;
      }),
    ],
    ['sorted', nativeFunction('sorted', sorted)],
    ['sum', builtin('sum', 'takes', 1, 2, sum, { keywords: ['start'], named: 1 })],
    ['vars', builtin('vars', 'expected', 0, 1, vars)],
    ['None', None],
    ['Ellipsis', Ellipsis],
    ['NotImplemented', NotImplemented],
    ['False', false],
    ['True', true],
    ['bool', boolClass],
    ['memoryview', unsupportedFunction('memoryview', 'memoryview')],
    ['bytearray', unsupportedFunction('bytearray', 'bytearray')],
    ['bytes', unsupportedFunction('bytes', 'bytes')],
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
    ['help', unsupportedFunction('help', 'help()')],
    ['Turtle', turtleClass],
  ]);
}

export { enumMembersOf, iterStr };
