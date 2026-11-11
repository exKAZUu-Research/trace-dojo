import { abstractPlaceholders } from '../abstractPlaceholders';
import { newComplex } from '../complexNumbers';
import { registerModule } from '../modules';
import { getAttribute, isTruthy } from '../objects';
import { binaryOp, compareOp, unaryOp } from '../operators';
import { toFloat, toInt } from '../typeNumbers';
import { complexClass, floatClass, intClass, newSet, newTuple, None, objectClass, pyError, typeError } from '../types';
import { type Kwargs, PyBuiltinFunction, PyClass, PyDescriptor, PyInstance, type PyValue } from '../values';
import { abcMetaClass, registerVirtual } from './abc';
import { defineProperty, defineSlot } from './numberSupport';

export { abcMetaClass, registerVirtual };

const abstractNames = new Map<PyClass, string[]>();

/** The abstract methods a class leaves unimplemented, in the order the ABCs of its MRO declare them. */
function abstractMethodsOf(cls: PyClass): string[] {
  const names = new Set(
    cls.mro.flatMap((base) => abstractNames.get(base) ?? []).map((name) => name.replace(/[@?]$/, ''))
  );
  return [...names].filter((name) => abstractPlaceholders.has(cls.lookup(name) as PyValue));
}

function abstractClass(name: string, base: PyClass, abstracts: string): PyClass {
  const cls = new PyClass(name, [base], abcMetaClass);
  cls.mro = [cls, ...base.mro];
  cls.module = 'numbers';
  cls.isBaseType = true;
  cls.construct = constructAbstract;
  const names = abstracts.split(' ').filter(Boolean);
  abstractNames.set(cls, names);
  for (const entry of names) defineAbstract(cls, entry);
  return cls;
}

/** Defines an abstract method: `name` raises NotImplementedError, `name@` is a property, and `name?` returns None. */
function defineAbstract(cls: PyClass, entry: string): void {
  const name = entry.replace(/[@?]$/, '');
  const run = (): PyValue => {
    if (entry.endsWith('?')) return None;
    throw pyError('NotImplementedError');
  };
  if (entry.endsWith('@')) {
    defineProperty(cls, name, run);
  } else {
    defineSlot(cls, name, run);
  }
  const placeholder = cls.dict.get(name) as PyValue;
  abstractPlaceholders.add(placeholder instanceof PyDescriptor ? placeholder.fn : placeholder);
  abstractPlaceholders.add(placeholder);
}

/** Creates an instance of an abstract base class or its subclass, refusing one with abstract methods left. */
function constructAbstract(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  const missing = abstractMethodsOf(cls).toSorted();
  if (missing.length > 0) {
    const plural = missing.length === 1 ? 'method' : 'methods';
    throw typeError(
      `Can't instantiate abstract class ${cls.name} without an implementation for abstract ${plural} ${missing.map((name) => `'${name}'`).join(', ')}`
    );
  }
  const hasArguments = args.length > 0 || (kwargs !== undefined && kwargs.size > 0);
  const init = cls.lookup('__init__');
  if (hasArguments && init instanceof PyBuiltinFunction && init === objectClass.dict.get('__init__')) {
    throw typeError(`${cls.qualifiedName}() takes no arguments`);
  }
  return new PyInstance(cls);
}

export const numberClass = abstractClass('Number', objectClass, '');
numberClass.dict.set('__hash__', None);

export const complexAbstractClass = abstractClass(
  'Complex',
  numberClass,
  '__complex__? real@ imag@ __add__ __radd__ __neg__ __pos__ __mul__ __rmul__ __truediv__ __rtruediv__ __pow__ __rpow__ __abs__ conjugate __eq__'
);
defineSlot(complexAbstractClass, '__bool__', (self) => isTruthy(compareOp('!=', self, 0n)));
defineSlot(complexAbstractClass, '__sub__', (self, [other]) => binaryOp('+', self, unaryOp('-', other)));
defineSlot(complexAbstractClass, '__rsub__', (self, [other]) => binaryOp('+', unaryOp('-', self), other));

export const realClass = abstractClass(
  'Real',
  complexAbstractClass,
  '__float__ __trunc__ __floor__ __ceil__ __round__ __floordiv__ __rfloordiv__ __mod__ __rmod__ __lt__ __le__'
);
defineSlot(realClass, '__divmod__', (self, [other]) =>
  newTuple([binaryOp('//', self, other), binaryOp('%', self, other)])
);
defineSlot(realClass, '__rdivmod__', (self, [other]) =>
  newTuple([binaryOp('//', other, self), binaryOp('%', other, self)])
);
defineSlot(realClass, '__complex__', (self) => newComplex(toFloat(self), 0));
defineProperty(realClass, 'real', (self) => unaryOp('+', self));
defineProperty(realClass, 'imag', () => 0n);
defineSlot(realClass, 'conjugate', (self) => unaryOp('+', self));

export const rationalClass = abstractClass('Rational', realClass, 'numerator@ denominator@');
defineSlot(rationalClass, '__float__', (self) =>
  binaryOp('/', toInt(getAttribute(self, 'numerator')), toInt(getAttribute(self, 'denominator')))
);

export const integralClass = abstractClass(
  'Integral',
  rationalClass,
  '__int__ __pow__ __lshift__ __rlshift__ __rshift__ __rrshift__ __and__ __rand__ __xor__ __rxor__ __or__ __ror__ __invert__'
);
defineSlot(integralClass, '__index__', (self) => toInt(self));
defineSlot(integralClass, '__float__', (self) => toFloat(toInt(self)));
defineProperty(integralClass, 'numerator', (self) => unaryOp('+', self));
defineProperty(integralClass, 'denominator', () => 1n);

/** The docstrings of CPython's numbers ABCs. */
const DOCS: [PyClass, string][] = [
  [
    numberClass,
    'All numbers inherit from this class.\n\nIf you just want to check if an argument x is a number, without\ncaring what kind, use isinstance(x, Number).\n',
  ],
  [
    complexAbstractClass,
    "Complex defines the operations that work on the builtin complex type.\n\nIn short, those are: a conversion to complex, .real, .imag, +, -,\n*, /, **, abs(), .conjugate, ==, and !=.\n\nIf it is given heterogeneous arguments, and doesn't have special\nknowledge about them, it should fall back to the builtin complex\ntype as described below.\n",
  ],
  [
    realClass,
    'To Complex, Real adds the operations that work on real numbers.\n\nIn short, those are: a conversion to float, trunc(), divmod,\n%, <, <=, >, and >=.\n\nReal also provides defaults for the derived operations.\n',
  ],
  [
    rationalClass,
    'To Real, Rational adds numerator and denominator properties.\n\nThe numerator and denominator values should be in lowest terms,\nwith a positive denominator.\n',
  ],
  [
    integralClass,
    'Integral adds methods that work on integral numbers.\n\nIn short, these are conversion to int, pow with modulus, and the\nbit-string operations.\n',
  ],
];
for (const [cls, doc] of DOCS) {
  cls.doc = doc;
  cls.dict.set('__doc__', doc);
  cls.dict.set('__slots__', newTuple([]));
  cls.dict.set('__abstractmethods__', newSet(abstractMethodsOf(cls), true));
}

registerVirtual(complexAbstractClass, complexClass);
registerVirtual(realClass, floatClass);
registerVirtual(integralClass, intClass);

registerModule('numbers', (runtime) => {
  const abc = runtime.importModule('abc');
  return new Map<string, PyValue>([
    [
      '__doc__',
      'Abstract Base Classes (ABCs) for numbers, according to PEP 3141.\n\nTODO: Fill out more detailed documentation on the operators.',
    ],
    ['ABCMeta', abcMetaClass],
    ['abstractmethod', abc.dict.get('abstractmethod') as PyValue],
    ['Number', numberClass],
    ['Complex', complexAbstractClass],
    ['Real', realClass],
    ['Rational', rationalClass],
    ['Integral', integralClass],
  ]);
});
