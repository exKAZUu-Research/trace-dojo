import { registerModule, registerModuleValues, registerUnsupportedAttributes } from '../modules';
import { checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import {
  callValue,
  deleteItem,
  getAttribute,
  getAttributeOrUndefined,
  getItem,
  isTruthy,
  iterateOr,
  lengthOf,
  lookupSpecial,
  type NextFunction,
  setItem,
} from '../objects';
import { binaryOp, compareOp, contains, equals, inplaceOp, isSame, unaryOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { exceptionClassNamed, nativeFunction, None, NotImplemented, typeError, typeName, valueError } from '../types';
import { DONE, type Kwargs, PyError, type PyValue } from '../values';
import { attrgetterClass, itemgetterClass, methodcallerClass } from './operatorCallables';

const BINARY = {
  add: '+',
  sub: '-',
  mul: '*',
  truediv: '/',
  floordiv: '//',
  mod: '%',
  pow: '**',
  matmul: '@',
  lshift: '<<',
  rshift: '>>',
  and_: '&',
  or_: '|',
  xor: '^',
} as const;

const COMPARISONS = { lt: '<', le: '<=', eq: '==', ne: '!=', ge: '>=', gt: '>' } as const;

type Run = (args: PyValue[], kwargs: Kwargs) => PyValue;

/** `operator.__all__`. */
const PUBLIC_NAMES = [
  'abs',
  'add',
  'and_',
  'attrgetter',
  'call',
  'concat',
  'contains',
  'countOf',
  'delitem',
  'eq',
  'floordiv',
  'ge',
  'getitem',
  'gt',
  'iadd',
  'iand',
  'iconcat',
  'ifloordiv',
  'ilshift',
  'imatmul',
  'imod',
  'imul',
  'index',
  'indexOf',
  'inv',
  'invert',
  'ior',
  'ipow',
  'irshift',
  'is_',
  'is_none',
  'is_not',
  'is_not_none',
  'isub',
  'itemgetter',
  'itruediv',
  'ixor',
  'le',
  'length_hint',
  'lshift',
  'lt',
  'matmul',
  'methodcaller',
  'mod',
  'mul',
  'ne',
  'neg',
  'not_',
  'or_',
  'pos',
  'pow',
  'rshift',
  'setitem',
  'sub',
  'truediv',
  'truth',
  'xor',
];

/** The public names that have no alias between double underscores, such as `__add__` for `add`. */
const NAMES_WITHOUT_ALIAS = new Set([
  'attrgetter',
  'countOf',
  'indexOf',
  'is_',
  'is_none',
  'is_not',
  'is_not_none',
  'itemgetter',
  'length_hint',
  'methodcaller',
  'truth',
]);

registerModule('operator', () => {
  const namespace = new Map<string, PyValue>([
    ['itemgetter', itemgetterClass],
    ['attrgetter', attrgetterClass],
    ['methodcaller', methodcallerClass],
    [
      'call',
      variadic('call', 1, Number.POSITIVE_INFINITY, ([fn, ...args], kwargs) => callValue(fn, args, kwargs), true),
    ],
    ['length_hint', variadic('length_hint', 1, 2, ([value, fallback]) => lengthHint(value, fallback ?? 0n))],
  ]);
  for (const [name, count, run] of operatorFunctions()) namespace.set(name, variadic(name, count, count, run));
  for (const name of PUBLIC_NAMES) {
    if (!NAMES_WITHOUT_ALIAS.has(name)) namespace.set(`__${name.replace(/_$/, '')}__`, namespace.get(name) as PyValue);
  }
  return namespace;
});
registerModuleValues('operator', '', PUBLIC_NAMES);
registerUnsupportedAttributes('operator', {
  __builtins__: 'モジュールの __builtins__（組み込みの名前空間そのもの）',
  __cached__: 'モジュールの __cached__（ファイルのパス）',
  __doc__: 'モジュールの説明文（__doc__）',
  __file__: 'モジュールの __file__（ファイルのパス）',
  __loader__: 'モジュールの __loader__（import の仕組み）',
  __spec__: 'モジュールの __spec__（import の仕組み）',
});

/** The functions of `_operator`, each with the number of arguments it takes. */
function operatorFunctions(): [string, number, Run][] {
  const functions: [string, number, Run][] = [
    ['concat', 2, ([a, b]) => binaryOp('+', sequenceOperand(a), b)],
    ['iconcat', 2, ([a, b]) => inplaceOp('+', sequenceOperand(a), b)],
    ['is_', 2, ([a, b]) => isSame(a, b)],
    ['is_not', 2, ([a, b]) => !isSame(a, b)],
    ['is_none', 1, ([a]) => a === None],
    ['is_not_none', 1, ([a]) => a !== None],
    ['neg', 1, ([a]) => unaryOp('-', a)],
    ['pos', 1, ([a]) => unaryOp('+', a)],
    ['inv', 1, ([a]) => unaryOp('~', a)],
    ['invert', 1, ([a]) => unaryOp('~', a)],
    ['not_', 1, ([a]) => !isTruthy(a)],
    ['truth', 1, ([a]) => isTruthy(a)],
    ['abs', 1, ([a]) => callValue(currentRuntime().builtins.get('abs') as PyValue, [a])],
    ['index', 1, ([a]) => toIndex(a)],
    ['contains', 2, ([a, b]) => contains(a, b)],
    ['countOf', 2, ([a, b]) => countOf(a, b)],
    ['indexOf', 2, ([a, b]) => indexOf(a, b)],
    ['getitem', 2, ([a, b]) => getItem(a, b)],
    ['setitem', 3, ([a, b, c]) => (setItem(a, b, c), None)],
    ['delitem', 2, ([a, b]) => (deleteItem(a, b), None)],
  ];
  for (const [name, operator] of Object.entries(BINARY)) {
    functions.push(
      [name, 2, ([a, b]) => binaryOp(operator, a, b)],
      [`i${name.replace(/_$/, '')}`, 2, ([a, b]) => inplaceOp(operator, a, b)]
    );
  }
  for (const [name, operator] of Object.entries(COMPARISONS)) {
    functions.push([name, 2, ([a, b]) => compareOp(operator, a, b)]);
  }
  return functions;
}

/** A function of the C module `_operator`, whose errors about a wrong call CPython words with that module's name. */
function variadic(name: string, min: number, max: number, run: Run, hasKeywords = false): PyValue {
  const spec = {
    qualified: `_operator.${name}`,
    short: name,
    min,
    max,
    style: max === 1 ? 'one' : 'expected',
  } as const;
  return nativeFunction(name, (args, kwargs) => {
    checkArgs(spec, args, hasKeywords ? undefined : kwargs);
    return run(args, kwargs);
  });
}

function sequenceOperand(value: PyValue): PyValue {
  if (getAttributeOrUndefined(value, '__getitem__') === undefined) {
    throw typeError(`'${typeName(value)}' object can't be concatenated`);
  }
  return value;
}

function countOf(container: PyValue, item: PyValue): PyValue {
  let count = 0n;
  const next = iterateArgument(container);
  for (let element = next(); element !== DONE; element = next()) {
    currentRuntime().spend();
    if (equals(element, item)) count++;
  }
  return count;
}

function indexOf(container: PyValue, item: PyValue): PyValue {
  let index = 0n;
  const next = iterateArgument(container);
  for (let element = next(); element !== DONE; element = next()) {
    currentRuntime().spend();
    if (equals(element, item)) return index;
    index++;
  }
  throw valueError('sequence.index(x): x not in sequence');
}

function iterateArgument(container: PyValue): NextFunction {
  return iterateOr(container, `argument of type '${typeName(container)}' is not iterable`);
}

/** `operator.length_hint`, as PyObject_LengthHint: the length, else what `__length_hint__` estimates, else the default. */
function lengthHint(value: PyValue, fallback: PyValue): PyValue {
  const defaultLength = toIndex(fallback);
  try {
    return BigInt(lengthOf(value));
  } catch (error) {
    if (!(error instanceof PyError) || !error.exception.cls.isSubclassOf(exceptionClassNamed('TypeError'))) throw error;
  }
  const hint = lookupSpecial(value, '__length_hint__');
  if (hint === undefined) return defaultLength;
  const result = callValue(getAttribute(value, '__length_hint__'), []);
  if (result === NotImplemented) return defaultLength;
  if (typeof result !== 'bigint' && typeof result !== 'boolean') {
    throw typeError(`__length_hint__ must be an integer, not ${typeName(result)}`);
  }
  if (BigInt(result) < 0n) throw valueError('__length_hint__() should return >= 0');
  return BigInt(result);
}
