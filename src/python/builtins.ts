// code-gauge-allow-file fileNcss 531 -- The builtins module keeps every builtin function together.
import { bytearrayClass, bytesClass, memoryviewClass, PyBytes } from './bytesValues';
import { checkShortcuts } from './checkShortcuts';
import { buildClass } from './classes';
import { complexAbs } from './complexNumbers';
import { pyAscii, pyFormat, pyRepr, pyStr } from './conversions';
import { aiter, anext } from './coroutines';
import { builtin } from './define';
import { compile, COMPILE_KEYWORDS, evaluate, execute } from './dynamicCode';
import { enumMembersOf } from './enums';
import { pyHash } from './hashing';
import { input } from './inputStream';
import { defineConstructingNew } from './instances';
import { reduction, withState } from './iteratorStates';
import { dunderImport } from './modules/importlib';
import { checkExtraName, missingNamespaceName, readProgramAttribute } from './namespaceDifferences';
import { argument, checkArgs } from './nativeArgs';
import { asFloat, divmodFloat, floorDivInt, modInt, toIndex } from './numbers';
import {
  attributeName,
  bindValue,
  callValue,
  deleteAttribute,
  exactLength,
  getAttribute,
  getAttributeOrUndefined,
  getItem,
  getIterator,
  isCallable,
  isTruthy,
  iterate,
  lookupSpecial,
  nextOf,
  setAttribute,
  toArray,
  withRemaining,
} from './objects';
import { binaryOp, compareOp } from './operators';
import { callerGlobals, callerLocals, callerNames, vars } from './reflection';
import { currentRuntime } from './runtimeContext';
import { siteBuiltins } from './siteBuiltins';
import { iterStr, strLength } from './strings';
import { sum } from './sum';
import { registerBuiltinVariants } from './suspendingBuiltins';
import { callSuspending, suspendingNextOf, withSuspendingNext } from './threadIteration';
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
  pyError,
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
import { unsupportedClassAttribute } from './unsupportedAttributes';
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
  checkEnumerateArgs(args.length, [...(kwargs?.keys() ?? [])]);
  const iterable = argument(args, kwargs, 0, 'iterable') as PyValue;
  let index = toIndex(argument(args, kwargs, 1, 'start') ?? 0n);
  const iterator = getIterator(iterable);
  const next = nextOf(iterator);
  const enumerated = (): PyValue | typeof DONE => {
    const item = next();
    if (item === DONE) return DONE;
    return currentRuntime().tuple([index++, item]);
  };
  withState(enumerated, { reduce: () => newTuple([cls, newTuple([iterator, index])]) });
  withSuspendingNext(enumerated, function* () {
    const item = yield* suspendingNextOf(iterator)();
    if (item === DONE) return DONE;
    return currentRuntime().tuple([index++, item]);
  });
  return new PyIterator(cls, enumerated, () => [iterator]);
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
// code-gauge-allow functionCognitiveComplexity 26 -- Each builtin iterator keeps its next function, its reduction, and its suspending next together.
// code-gauge-allow functionNcss 35 -- Each builtin iterator keeps its next function, its reduction, and its suspending next together.
zipClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'zip', min: 0, max: Number.POSITIVE_INFINITY, style: 'takes', keywords: ['strict'] },
    args,
    kwargs
  );
  let strict = isTruthy(kwargs?.get('strict') ?? false);
  const iterators = args.map((iterable) => getIterator(iterable));
  const nexts = iterators.map((iterator) => nextOf(iterator));
  let finished = false;
  const zipped = (): PyValue | typeof DONE => {
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
  };
  withSuspendingNext(zipped, function* () {
    if (finished || nexts.length === 0) return DONE;
    const items: PyValue[] = [];
    for (const [index, iterator] of iterators.entries()) {
      const item = yield* suspendingNextOf(iterator)();
      if (item === DONE) {
        finished = true;
        if (strict) checkStrictLengths('zip', nexts, index);
        return DONE;
      }
      items.push(item);
    }
    return currentRuntime().tuple(items);
  });
  withState(zipped, {
    reduce: () => newTuple(strict ? [cls, newTuple(iterators), true] : [cls, newTuple(iterators)]),
    setState: (state) => {
      strict = state !== 0n;
    },
  });
  return new PyIterator(cls, zipped, () => iterators);
};

/** Raises the error of a strict `zip` or `map` whose iterable at `index` ended first, unless all end together. */
function checkStrictLengths(name: 'zip' | 'map', nexts: (() => PyValue | typeof DONE)[], index: number): typeof DONE {
  const mismatch = (position: number, relation: string): Error =>
    valueError(
      `${name}() argument ${position + 1} is ${relation} than argument${position === 1 ? '' : 's'} 1${position > 1 ? `-${position}` : ''}`
    );
  if (index > 0) throw mismatch(index, 'shorter');
  for (const [other, next] of nexts.entries()) {
    if (other > 0 && next() !== DONE) throw mismatch(other, 'longer');
  }
  return DONE;
}

export const mapClass = builtinClass('map');
// code-gauge-allow functionCognitiveComplexity 21 -- As zip's, map's iterator keeps its next function, its reduction, and its suspending next together.
mapClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'map', min: 0, max: Number.POSITIVE_INFINITY, style: 'takes', keywords: ['strict'] },
    args,
    kwargs
  );
  if (args.length < 2) throw typeError('map() must have at least two arguments.');
  const [fn, ...iterables] = args;
  let strict = isTruthy(kwargs?.get('strict') ?? false);
  const iterators = iterables.map((iterable) => getIterator(iterable));
  const nexts = iterators.map((iterator) => nextOf(iterator));
  const mapped = (): PyValue | typeof DONE => {
    const items: PyValue[] = [];
    for (const [index, next] of nexts.entries()) {
      const item = next();
      if (item === DONE) return strict ? checkStrictLengths('map', nexts, index) : DONE;
      items.push(item);
    }
    return callValue(fn, items);
  };
  withState(mapped, {
    reduce: () => newTuple(strict ? [cls, newTuple([fn, ...iterators]), true] : [cls, newTuple([fn, ...iterators])]),
    setState: (state) => {
      strict = state !== 0n;
    },
  });
  withSuspendingNext(mapped, function* () {
    const items: PyValue[] = [];
    for (const [index, iterator] of iterators.entries()) {
      const item = yield* suspendingNextOf(iterator)();
      if (item === DONE) return strict ? checkStrictLengths('map', nexts, index) : DONE;
      items.push(item);
    }
    return yield* callSuspending(fn, items);
  });
  return new PyIterator(cls, mapped, () => [fn, ...iterators]);
};

export const filterClass = builtinClass('filter');
// code-gauge-allow functionCognitiveComplexity 18 -- Each builtin iterator keeps its next function, its reduction, and its suspending next together.
filterClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'filter', min: 2, max: 2, style: 'expected' }, args, kwargs);
  const [fn, iterable] = args;
  const iterator = getIterator(iterable);
  const next = nextOf(iterator);
  const filtered = (): PyValue | typeof DONE => {
    for (let item = next(); item !== DONE; item = next()) {
      currentRuntime().spend();
      if (isTruthy(fn === None ? item : callValue(fn, [item]))) return item;
    }
    return DONE;
  };
  withState(filtered, { reduce: () => newTuple([cls, newTuple([fn, iterator])]) });
  withSuspendingNext(filtered, function* () {
    const suspendingNext = suspendingNextOf(iterator);
    for (let item = yield* suspendingNext(); item !== DONE; item = yield* suspendingNext()) {
      currentRuntime().spend();
      if (isTruthy(fn === None ? item : yield* callSuspending(fn, [item]))) return item;
    }
    return DONE;
  });
  return new PyIterator(cls, filtered, () => [fn, iterator]);
};

export const reversedClass = builtinClass('reversed');
// code-gauge-allow functionCognitiveComplexity 20 -- Each builtin iterator keeps its next function, its reduction, and its suspending next together.
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
  let index = exactLength(sequence) - 1n;
  const next = withRemaining(
    () => (index >= 0n ? getItem(sequence, index--) : DONE),
    () => (index >= 0n && exactLength(sequence) > index ? Number(index) + 1 : 0)
  );
  withState(next, {
    reduce: () => (index >= 0n ? reduction('reversed', [sequence], index) : reduction('reversed', [newTuple([])])),
    setState: (state) => {
      const last = exactLength(sequence) - 1n;
      if (index >= 0n) index = state < -1n ? -1n : state > last ? last : state;
    },
  });
  return new PyIterator(reversedClass, next, () => [sequence]);
};

for (const cls of [enumerateClass, zipClass, mapClass, filterClass, reversedClass]) {
  defineIteratorClass(cls);
  defineConstructingNew(cls);
}

// Functions ---------------------------------------------------------------------------------------------------------

function print(args: PyValue[], kwargs: Kwargs): PyValue {
  const { separator, end } = printTexts(kwargs);
  const runtime = currentRuntime();
  const file = printFile(kwargs?.get('file') ?? None);
  if (file === None) return None;
  const isStdout = file === runtime.standardStream('stdout');
  // Each piece is written on its own, as CPython writes them, so that the output limit ends a huge print early.
  const write = (text: string): void => {
    if (isStdout) runtime.io.stdout.write(text);
    else callValue(getAttribute(file, 'write'), [text]);
  };
  for (const [index, value] of args.entries()) {
    if (index > 0) write(separator);
    write(pyStr(value));
  }
  write(end);
  return None;
}

/** The stream `print` writes to: its `file`, else the current `sys.stdout`, which a program may replace or remove. */
function printFile(file: PyValue): PyValue {
  if (file !== None) return file;
  const stdout = currentRuntime().importModule('sys').dict.get('stdout');
  if (stdout === undefined) throw pyError('RuntimeError', 'lost sys.stdout');
  return stdout;
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

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
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
    if (check !== undefined) return isTruthy(check(value));
    return cls.isSubclassOf(classInfo) || claimedClass(value, cls)?.isSubclassOf(classInfo) === true;
  }
  if (classInfo instanceof PyTuple) return classInfo.items.some((item) => isInstance(value, item, name));
  if (classInfo instanceof PyOpaque && Array.isArray(classInfo.data)) {
    return (classInfo.data as PyValue[]).some((item) => isInstance(value, item, name));
  }
  const check = lookupSpecial(classInfo, '__instancecheck__');
  if (check !== undefined) return isTruthy(callValue(bindValue(check, classInfo), [value]));
  throw typeError(`${name}() arg 2 must be a type, a tuple of types, or a union`);
}

/**
 * The class an object of a program's class claims through `__class__`, as a weakref proxy claims its referent's,
 * which isinstance() also accepts, or undefined for an object that claims its own.
 */
function claimedClass(value: PyValue, cls: PyClass): PyClass | undefined {
  if (typeof value !== 'object' || cls.isBuiltin) return undefined;
  if (!cls.flags.definesGetattribute && cls.lookup('__class__') === objectClass.dict.get('__class__')) return undefined;
  const claimed = getAttributeOrUndefined(value, '__class__');
  return claimed instanceof PyClass && claimed !== cls ? claimed : undefined;
}

/** The bound `__instancecheck__` or `__subclasscheck__` that the metaclass of `cls`, such as `abc.ABCMeta`, defines. */
function customCheck(cls: PyClass, name: string): ((value: PyValue) => PyValue) | undefined {
  if (cls.cls === typeClass) return undefined;
  const check = cls.cls.lookup(name);
  if (check === undefined || check === typeClass.dict.get(name)) return undefined;
  const shortcut = checkShortcuts.get(check);
  if (shortcut) return (value) => shortcut(cls, value);
  const bound = bindValue(check, cls, cls.cls);
  return (value) => callValue(bound, [value]);
}

/** Whether `cls` is a subclass of `classInfo`, a class, a tuple of them, or a union, as issubclass() says. */
export function isSubclass(cls: PyValue, classInfo: PyValue): boolean {
  if (classInfo instanceof PyClass) {
    const check = customCheck(classInfo, '__subclasscheck__');
    if (check !== undefined) return isTruthy(check(cls));
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
  const next = (): PyValue | typeof DONE => {
    if (finished) return DONE;
    const value = callValue(fn, []);
    if (compareOp('==', value, sentinel) === true) {
      finished = true;
      return DONE;
    }
    return value;
  };
  withState(next, {
    reduce: () =>
      finished ? reduction('iter', [newTuple([])]) : reduction('iter', [fn as PyValue, sentinel as PyValue]),
  });
  return new PyIterator(iteratorClass('callable_iterator'), next, () => [fn, sentinel]);
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
  if (fallback === undefined) return readProgramAttribute(object, name, () => getAttribute(object, name));
  return readProgramAttribute(object, name, () => {
    const value = getAttributeOrUndefined(object, name);
    if (value !== undefined) return value;
    // A name CPython's namespace has is not one getattr() falls back for.
    const feature = currentRuntime().inLibraryCode() ? undefined : missingNamespaceName(object, name);
    if (feature !== undefined) throw new UnsupportedFeatureError(feature);
    return fallback;
  });
}

function sorted(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'sorted', min: 1, max: 1, style: 'expected' }, args, undefined);
  // The keywords go to list.sort, which reports the wrong ones under its own name.
  checkArgs({ qualified: 'sort', min: 0, max: 0, style: 'takes', keywords: ['key', 'reverse'] }, [], kwargs);
  const list = newList(toArray(args[0]));
  sortList(list, kwargs?.get('key') ?? None, isTruthy(kwargs?.get('reverse') ?? false));
  return list;
}

function hasAttribute(object: PyValue, nameValue: PyValue): boolean {
  const name = attributeName(nameValue);
  // An attribute this grader lacks exists in CPython, so code may test for it before it uses it.
  if (object instanceof PyModule && object.unsupported.has(name)) return true;
  if (unsupportedClassAttribute(object, name) !== undefined) return true;
  if (missingNamespaceName(object, name) !== undefined) return true;
  checkExtraName(object, name);
  return getAttributeOrUndefined(object, name) !== undefined;
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

/**
 * `dir(value)`: the sorted list its type's `__dir__` gives, which for objects of types that do not override `object`'s
 * or `type`'s is the attributes they have.
 */
function dir(value: PyValue): PyValue {
  const runtime = currentRuntime();
  const custom = lookupSpecial(value, '__dir__');
  if (custom === undefined || custom === objectClass.dict.get('__dir__') || custom === typeClass.dict.get('__dir__')) {
    return runtime.dir(value);
  }
  const names = callValue(bindValue(custom, value), []);
  return callValue(runtime.builtins.get('sorted') as PyValue, [names]);
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
  const builtins = builtinNamespace();
  registerBuiltinVariants(builtins);
  return builtins;
}

function builtinNamespace(): Map<string, PyValue> {
  const exceptions = [...exceptionClasses.entries()];
  return new Map<string, PyValue>([
    ['__build_class__', buildClass],
    ['__import__', nativeFunction('__import__', dunderImport)],
    ['abs', one('abs', abs)],
    ['all', one('all', ([iterable]) => !someItem(iterable, (item) => !isTruthy(item)))],
    ['any', one('any', ([iterable]) => someItem(iterable, isTruthy))],
    ['ascii', one('ascii', ([value]) => pyAscii(value))],
    ['bin', one('bin', radix('0b', 2))],
    [
      'breakpoint',
      nativeFunction('breakpoint', (args, kwargs) => {
        const hook = currentRuntime().importModule('sys').dict.get('breakpointhook');
        if (hook === undefined) throw pyError('RuntimeError', 'lost sys.breakpointhook');
        return callValue(hook, args, kwargs);
      }),
    ],
    ['callable', one('callable', ([value]) => isCallable(value))],
    ['chr', one('chr', chr)],
    ['compile', builtin('compile', 'takes', 0, 6, compile, { keywords: COMPILE_KEYWORDS })],
    [
      'delattr',
      builtin('delattr', 'expected', 2, 2, ([object, name]) => {
        const key = attributeName(name);
        currentRuntime().finalizer.replacing(object, key, true, () => deleteAttribute(object, key));
        return None;
      }),
    ],
    ['dir', builtin('dir', 'expected', 0, 1, (args) => (args.length === 0 ? callerNames() : dir(args[0])))],
    ['divmod', builtin('divmod', 'expected', 2, 2, divmod)],
    ['eval', builtin('eval', 'takes', 1, 3, evaluate, { keywords: ['globals', 'locals'] })],
    ['exec', builtin('exec', 'takes', 1, 3, execute, { keywords: ['globals', 'locals', 'closure'] })],
    [
      'format',
      builtin('format', 'expected', 1, 2, ([value, spec]) => {
        if (spec !== undefined && typeof spec !== 'string')
          throw typeError(`format() argument 2 must be str, not ${argumentTypeName(spec)}`);
        return pyFormat(value, spec ?? '');
      }),
    ],
    ['getattr', builtin('getattr', 'expected', 2, 3, getattr)],
    ['globals', builtin('globals', 'none', 0, 0, callerGlobals)],
    ['hasattr', builtin('hasattr', 'expected', 2, 2, ([object, name]) => hasAttribute(object, name))],
    ['hash', one('hash', ([value]) => pyHash(value))],
    ['hex', one('hex', radix('0x', 16))],
    ['id', one('id', ([value]) => currentRuntime().idOf(value))],
    ['input', builtin('input', 'expected', 0, 1, ([prompt]) => input(prompt))],
    ['isinstance', builtin('isinstance', 'expected', 2, 2, ([value, classInfo]) => isInstance(value, classInfo))],
    ['issubclass', builtin('issubclass', 'expected', 2, 2, ([cls, classInfo]) => isSubclass(cls, classInfo))],
    ['iter', builtin('iter', 'expected', 1, 2, iter)],
    ['aiter', one('aiter', ([value]) => aiter(value))],
    ['len', one('len', ([value]) => exactLength(value))],
    ['locals', builtin('locals', 'none', 0, 0, callerLocals)],
    ['max', builtin('max', 'expected', 1, Number.POSITIVE_INFINITY, minMax('max'), { keywords: ['key', 'default'] })],
    ['min', builtin('min', 'expected', 1, Number.POSITIVE_INFINITY, minMax('min'), { keywords: ['key', 'default'] })],
    ['next', builtin('next', 'expected', 1, 2, next)],
    ['anext', builtin('anext', 'expected', 1, 2, ([iterator, fallback]) => anext(iterator, fallback))],
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
        const key = attributeName(name);
        currentRuntime().finalizer.replacing(object, key, true, () => setAttribute(object, key, value));
        return None;
      }),
    ],
    ['sorted', nativeFunction('sorted', sorted)],
    ['sum', builtin('sum', 'takes', 1, 2, sum, { keywords: ['start'], named: 1 })],
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
    ...siteBuiltins(),
    ['Turtle', turtleClass],
  ]);
}

export { enumMembersOf, iterStr };
