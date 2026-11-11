import type { BinaryOperator, CompareOperator } from '../ast';
import { complexAbs } from '../complexNumbers';
import { pyRepr } from '../conversions';
import { method } from '../define';
import { registerModule } from '../modules';
import { type ArgStyle, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import {
  bindValue,
  callValue,
  deleteItem,
  getAttribute,
  getItem,
  isTruthy,
  iterate,
  lengthOf,
  lookupSpecial,
  remainingOf,
  setItem,
} from '../objects';
import { binaryOp, compareOp, contains, equals, inplaceOp, isSame, unaryOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  defineMethod,
  nativeFunction,
  newTuple,
  None,
  NotImplemented,
  pyError,
  typeError,
  typeName,
} from '../types';
import { DONE, type Kwargs, PyComplex, PyDict, PyError, PyIterator, PyOpaque, type PyValue } from '../values';

type Run = (args: PyValue[], kwargs: Kwargs) => PyValue;

/** A function of `_operator`, which words its argument errors as its C argument parser does. */
function operatorFunction(name: string, style: ArgStyle, min: number, max: number, run: Run): PyValue {
  const spec = { qualified: `_operator.${name}`, short: name, min, max, style };
  return nativeFunction(name, (args, kwargs) => {
    checkArgs(spec, args, kwargs);
    return run(args, kwargs);
  });
}

const BINARY: [string, BinaryOperator][] = [
  ['add', '+'],
  ['and_', '&'],
  ['floordiv', '//'],
  ['lshift', '<<'],
  ['matmul', '@'],
  ['mod', '%'],
  ['mul', '*'],
  ['or_', '|'],
  ['pow', '**'],
  ['rshift', '>>'],
  ['sub', '-'],
  ['truediv', '/'],
  ['xor', '^'],
];

const COMPARISONS: [string, CompareOperator][] = [
  ['lt', '<'],
  ['le', '<='],
  ['eq', '=='],
  ['ne', '!='],
  ['ge', '>='],
  ['gt', '>'],
];

function abs(value: PyValue): PyValue {
  if (typeof value === 'bigint') return value < 0n ? -value : value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return Math.abs(value);
  if (value instanceof PyComplex) return complexAbs(value);
  const special = lookupSpecial(value, '__abs__');
  if (special === undefined) throw typeError(`bad operand type for abs(): '${typeName(value)}'`);
  return callValue(bindValue(special, value), []);
}

/** Whether a value is a sequence as `PySequence_Check` decides: it supports indexing and is not a dict. */
function isSequence(value: PyValue): boolean {
  if (typeof value === 'string') return true;
  if (typeof value !== 'object' || value instanceof PyDict) return false;
  return lookupSpecial(value, '__getitem__') !== undefined;
}

function concat(left: PyValue, right: PyValue, inPlace: boolean): PyValue {
  if (!isSequence(left)) throw typeError(`'${typeName(left)}' object can't be concatenated`);
  return inPlace ? inplaceOp('+', left, right) : binaryOp('+', left, right);
}

function iterableOf(value: PyValue): () => PyValue | typeof DONE {
  try {
    return iterate(value);
  } catch (error) {
    if (error instanceof PyError && isNotIterableError(error)) {
      throw typeError(`argument of type '${typeName(value)}' is not iterable`);
    }
    throw error;
  }
}

function isNotIterableError(error: PyError): boolean {
  const message = error.exception.exception?.args.items[0];
  return error.exception.cls.name === 'TypeError' && typeof message === 'string' && message.endsWith('is not iterable');
}

function countOf(sequence: PyValue, item: PyValue): bigint {
  const next = iterableOf(sequence);
  let count = 0n;
  for (let element = next(); element !== DONE; element = next()) {
    currentRuntime().spend();
    if (isSame(element, item) || equals(element, item)) count++;
  }
  return count;
}

function indexOf(sequence: PyValue, item: PyValue): bigint {
  const next = iterableOf(sequence);
  let index = 0n;
  for (let element = next(); element !== DONE; element = next()) {
    currentRuntime().spend();
    if (isSame(element, item) || equals(element, item)) return index;
    index++;
  }
  throw pyError('ValueError', 'sequence.index(x): x not in sequence');
}

function lengthHint(value: PyValue, fallback: PyValue | undefined): PyValue {
  const defaultValue = fallback === undefined ? 0n : toIndex(fallback);
  if (lookupSpecial(value, '__len__') !== undefined || typeof value === 'string' || value instanceof PyDict) {
    return BigInt(lengthOf(value));
  }
  if (value instanceof PyIterator) {
    const remaining = remainingOf(value.next);
    if (remaining !== undefined) return BigInt(remaining);
  }
  const hint = lookupSpecial(value, '__length_hint__');
  if (hint === undefined) return defaultValue;
  const result = callValue(bindValue(hint, value), []);
  if (result === NotImplemented) return defaultValue;
  if (typeof result !== 'bigint' && typeof result !== 'boolean') {
    throw typeError(`__length_hint__ must be an integer, not ${typeName(result)}`);
  }
  if (BigInt(result) < 0n) throw pyError('ValueError', '__length_hint__() should return >= 0');
  return BigInt(result);
}

function operatorFunctions(): [string, PyValue][] {
  const one = (name: string, run: (value: PyValue) => PyValue): [string, PyValue] => [
    name,
    operatorFunction(name, 'one', 1, 1, ([value]) => run(value)),
  ];
  const two = (name: string, run: (a: PyValue, b: PyValue) => PyValue): [string, PyValue] => [
    name,
    operatorFunction(name, 'expected', 2, 2, ([a, b]) => run(a, b)),
  ];
  return [
    one('abs', abs),
    one('index', (value) => toIndex(value)),
    one('inv', (value) => unaryOp('~', value)),
    one('invert', (value) => unaryOp('~', value)),
    one('neg', (value) => unaryOp('-', value)),
    one('pos', (value) => unaryOp('+', value)),
    one('not_', (value) => !isTruthy(value)),
    one('truth', (value) => isTruthy(value)),
    one('is_none', (value) => value === None),
    one('is_not_none', (value) => value !== None),
    ...BINARY.map(([name, operator]) => two(name, (a, b) => binaryOp(operator, a, b))),
    ...BINARY.map(([name, operator]) => two(`i${name.replace('_', '')}`, (a, b) => inplaceOp(operator, a, b))),
    ...COMPARISONS.map(([name, operator]) => two(name, (a, b) => compareOp(operator, a, b))),
    two('is_', (a, b) => isSame(a, b)),
    two('is_not', (a, b) => !isSame(a, b)),
    two('concat', (a, b) => concat(a, b, false)),
    two('iconcat', (a, b) => concat(a, b, true)),
    two('contains', (a, b) => contains(a, b)),
    two('countOf', countOf),
    two('indexOf', indexOf),
    two('getitem', (a, b) => getItem(a, b)),
    two('delitem', (a, b) => {
      deleteItem(a, b);
      return None;
    }),
    [
      'setitem',
      operatorFunction('setitem', 'expected', 3, 3, ([a, b, c]) => {
        setItem(a, b, c);
        return None;
      }),
    ],
    [
      'length_hint',
      operatorFunction('length_hint', 'expected', 1, 2, ([value, fallback]) => lengthHint(value, fallback)),
    ],
    ['call', callFunction],
  ];
}

const callFunction = nativeFunction('call', (args, kwargs) => {
  if (args.length === 0) throw typeError('call expected at least 1 argument, got 0');
  return callValue(args[0], args.slice(1), kwargs);
});

/** The names of `operator` that are also exported with double underscores, such as `__add__`. */
const DUNDER_ALIASES: Record<string, string> = { inv: '__inv__', not_: '__not__', and_: '__and__', or_: '__or__' };

function dunderName(name: string): string | undefined {
  if (name in DUNDER_ALIASES) return DUNDER_ALIASES[name];
  if (['is_', 'is_not', 'is_none', 'is_not_none', 'countOf', 'indexOf', 'length_hint', 'truth'].includes(name)) {
    return undefined;
  }
  return `__${name}__`;
}

// itemgetter, attrgetter, and methodcaller ----------------------------------------------------------------------------

const itemgetterClass = builtinClass('itemgetter');
const attrgetterClass = builtinClass('attrgetter');
const methodcallerClass = builtinClass('methodcaller');
for (const cls of [itemgetterClass, attrgetterClass, methodcallerClass]) cls.module = 'operator';

interface Getter {
  items: PyValue[];
}

interface Caller {
  name: string;
  args: PyValue[];
  kwargs: Kwargs;
}

function rejectKeywords(name: string, kwargs: Kwargs): void {
  if (kwargs && kwargs.size > 0) throw typeError(`${name}() takes no keyword arguments`);
}

itemgetterClass.construct = (cls, args, kwargs) => {
  rejectKeywords('itemgetter', kwargs);
  if (args.length === 0) throw typeError('itemgetter expected 1 argument, got 0');
  return new PyOpaque(cls, `operator.itemgetter(${args.map(pyRepr).join(', ')})`, { items: args } satisfies Getter);
};

attrgetterClass.construct = (cls, args, kwargs) => {
  rejectKeywords('attrgetter', kwargs);
  if (args.length === 0) throw typeError('attrgetter expected 1 argument, got 0');
  if (args.some((name) => typeof name !== 'string')) throw typeError('attribute name must be a string');
  return new PyOpaque(cls, `operator.attrgetter(${args.map(pyRepr).join(', ')})`, { items: args } satisfies Getter);
};

methodcallerClass.construct = (cls, args, kwargs) => {
  if (args.length === 0) throw typeError('methodcaller needs at least one argument, the method name');
  const [name, ...rest] = args;
  if (typeof name !== 'string') throw typeError('method name must be a string');
  const shown = [
    pyRepr(name),
    ...rest.map(pyRepr),
    ...[...(kwargs ?? [])].map(([key, value]) => `${key}=${pyRepr(value)}`),
  ];
  return new PyOpaque(cls, `operator.methodcaller(${shown.join(', ')})`, {
    name,
    args: rest,
    kwargs: kwargs && kwargs.size > 0 ? new Map(kwargs) : undefined,
  } satisfies Caller);
};

function callOne(name: string, args: PyValue[], kwargs: Kwargs): PyValue {
  rejectKeywords(name, kwargs);
  if (args.length !== 1) throw typeError(`${name} expected 1 argument, got ${args.length}`);
  return args[0];
}

function dottedAttribute(value: PyValue, path: string): PyValue {
  let result = value;
  for (const part of path.split('.')) result = getAttribute(result, part);
  return result;
}

defineMethod(itemgetterClass, '__call__', (self, args, kwargs) => {
  const target = callOne('itemgetter', args, kwargs);
  const { items } = (self as PyOpaque).data as Getter;
  if (items.length === 1) return getItem(target, items[0]);
  return newTuple(items.map((item) => getItem(target, item)));
});

defineMethod(attrgetterClass, '__call__', (self, args, kwargs) => {
  const target = callOne('attrgetter', args, kwargs);
  const { items } = (self as PyOpaque).data as Getter;
  if (items.length === 1) return dottedAttribute(target, items[0] as string);
  return newTuple(items.map((item) => dottedAttribute(target, item as string)));
});

defineMethod(methodcallerClass, '__call__', (self, args, kwargs) => {
  if (args.length !== 1 || (kwargs && kwargs.size > 0)) {
    throw typeError(`methodcaller expected 1 argument, got ${kwargs && kwargs.size > 0 ? 0 : args.length}`);
  }
  const caller = (self as PyOpaque).data as Caller;
  return callValue(getAttribute(args[0], caller.name), [...caller.args], caller.kwargs);
});

for (const cls of [itemgetterClass, attrgetterClass, methodcallerClass]) {
  method(cls, '__repr__', 'none', 0, 0, (self) => (self as PyOpaque).text);
}

registerModule('operator', () => {
  const namespace = new Map<string, PyValue>();
  for (const [name, fn] of operatorFunctions()) {
    namespace.set(name, fn);
    const alias = dunderName(name);
    if (alias) namespace.set(alias, fn);
  }
  namespace.set('itemgetter', itemgetterClass);
  namespace.set('attrgetter', attrgetterClass);
  namespace.set('methodcaller', methodcallerClass);
  return namespace;
});
