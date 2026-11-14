import { newComplex } from '../complexNumbers';
import { builtin } from '../define';
import { registerModule } from '../modules';
import { exactBinary, parseFloatText } from '../numbers';
import { callValue } from '../objects';
import {
  nativeFunction,
  newList,
  newTuple,
  None,
  NotImplemented,
  objectClass,
  pyError,
  stringValue,
  typeClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import { type Kwargs, PyClass, PyComplex, PyList, PyNumberInstance, PyTuple, type PyValue } from '../values';
import { abcRegister } from './abc';
import { unpackCArguments } from './clinicArgs';
import { makeNamedTupleClass } from './collections';
import {
  absolute,
  divideWithRemainder,
  floorDivide,
  fromInteger,
  negate,
  plus,
  quantize,
  remainder,
} from './decimalArithmetic';
import { type DecimalContext, type Rounding, ROUNDINGS } from './decimalContext';
import {
  commitStatus,
  contextArgument,
  contextClass,
  decimalExceptions,
  getContext,
  localContext,
  MAX_EMAX,
  MAX_PREC,
  MIN_EMIN,
  moduleState,
  type PyContext,
  setContext,
} from './decimalContextClass';
import {
  compareCheckNans,
  compareValues,
  type Dec,
  dec,
  type FiniteDec,
  fix,
  isFinite,
  isNan,
  isNonzero,
  multiply,
  raiseCondition,
  rescale,
  tenTo,
  truncatedInt,
} from './decimalNumber';
import { DECIMAL_OPERATIONS, type Operation, OPERATORS } from './decimalOperations';
import { power, powerModulo } from './decimalPower';
import { decimalString, formatDecimal, parseDecimal } from './decimalText';
import { hashRatio, rationalRatio } from './fractions';
import { numberClass, registerVirtual } from './numbers';
import { defineProperty, defineSlot } from './numberSupport';

/** A `decimal.Decimal`. */
export class PyDecimal extends PyNumberInstance {
  constructor(
    cls: PyClass,
    readonly value: Dec
  ) {
    super(cls);
  }

  reprText(): string {
    return `Decimal('${decimalString(this.value, 1)}')`;
  }
}

export const decimalClass = new PyClass('Decimal', [objectClass], typeClass);
decimalClass.mro = [decimalClass, objectClass];
decimalClass.module = 'decimal';
decimalClass.typeName = 'decimal.Decimal';
decimalClass.isBaseType = true;
registerVirtual(numberClass, decimalClass);

export function newDecimal(value: Dec, cls: PyClass = decimalClass): PyDecimal {
  return new PyDecimal(cls, value);
}

function valueOf(value: PyValue): Dec {
  return (value as PyDecimal).value;
}

/** Runs an operation in a context, then records its conditions and raises the exception of a trapped one. */
export function inContext<T>(context: PyContext, run: (state: DecimalContext) => T): T {
  const { state } = context;
  state.status.clear();
  try {
    return run(state);
  } finally {
    commitStatus(state);
  }
}

// Construction -------------------------------------------------------------------------------------------------------

decimalClass.construct = (cls: PyClass, args: PyValue[], kwargs: Kwargs) => {
  const [value = '0', context] = unpackCArguments(
    { params: ['value', 'context'], required: 0, positionalOnly: 0, legacy: true },
    args,
    kwargs
  );
  return newDecimal(convertExact(value, contextArgument(context)), cls);
};

/** `Decimal(value)`: the exact value of an int, float, string, tuple, or Decimal. */
function convertExact(value: PyValue, context: PyContext): Dec {
  if (value instanceof PyDecimal) return value.value;
  if (typeof value === 'bigint' || typeof value === 'boolean') return fromInteger(BigInt(value));
  const text = stringValue(value);
  if (text !== undefined) {
    const parsed = parseDecimal(text);
    return parsed ?? inContext(context, (state) => raiseCondition(state, 'ConversionSyntax'));
  }
  if (typeof value === 'number') {
    inContext(context, (state) => state.status.add('FloatOperation'));
    return fromFloat(value);
  }
  if (value instanceof PyTuple || value instanceof PyList) return fromTuple(value.items);
  throw typeError(`conversion from ${typeName(value)} to Decimal is not supported`);
}

export function fromFloat(value: number): Dec {
  if (Number.isNaN(value)) return dec(0, '', 'n');
  if (!Number.isFinite(value)) return dec(value < 0 ? 1 : 0, '0', 'F');
  const sign = value < 0 || Object.is(value, -0) ? 1 : 0;
  let { mantissa, exponent } = exactBinary(Math.abs(value));
  if (mantissa === 0n) return dec(sign, '0', 0);
  while (exponent < 0 && (mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exponent++;
  }
  if (exponent >= 0) return dec(sign, (mantissa << BigInt(exponent)).toString(), 0);
  return dec(sign, multiply(mantissa, 5n ** BigInt(-exponent)).toString(), exponent);
}

// code-gauge-allow functionCognitiveComplexity 21 -- Follows the argument handling of the C module _decimal.
function fromTuple(items: readonly PyValue[]): Dec {
  if (items.length !== 3) throw valueError('argument must be a sequence of length 3');
  const [sign, digits, rawExponent] = items;
  if ((typeof sign !== 'bigint' && typeof sign !== 'boolean') || (BigInt(sign) !== 0n && BigInt(sign) !== 1n)) {
    throw valueError('sign must be an integer with the value 0 or 1');
  }
  const exponent = stringValue(rawExponent) ?? rawExponent;
  let exp: Dec['exp'];
  if (typeof exponent === 'string') {
    if (!['F', 'n', 'N'].includes(exponent)) {
      throw valueError("string argument in the third position must be 'F', 'n' or 'N'");
    }
    exp = exponent as 'F' | 'n' | 'N';
  } else if (typeof exponent === 'bigint' || typeof exponent === 'boolean') {
    exp = Number(exponent);
  } else {
    throw valueError('exponent must be an integer');
  }
  if (!(digits instanceof PyTuple || digits instanceof PyList))
    throw valueError('coefficient must be a tuple of digits');
  let text = '';
  for (const digit of digits.items) {
    if (typeof digit !== 'bigint' || digit < 0n || digit > 9n)
      throw valueError('coefficient must be a tuple of digits');
    text += digit.toString();
  }
  const stripped = text.replace(/^0+/, '');
  if (exp === 'F') return dec(Number(sign), '0', 'F');
  if (exp === 'n' || exp === 'N') return dec(Number(sign), stripped, exp);
  return dec(Number(sign), stripped || '0', exp);
}

// Operands -----------------------------------------------------------------------------------------------------------

/** An operand of an arithmetic operator: a Decimal or an int, or undefined for any other type. */
function operand(value: PyValue): Dec | undefined {
  if (value instanceof PyDecimal) return value.value;
  if (typeof value === 'bigint' || typeof value === 'boolean') return fromInteger(BigInt(value));
  return undefined;
}

/** An operand of a method, which must be a Decimal or an int. */
export function requireOperand(value: PyValue): Dec {
  const result = operand(value);
  if (result === undefined) throw typeError(`conversion from ${typeName(value)} to Decimal is not supported`);
  return result;
}

type Binary = (a: Dec, b: Dec, context: DecimalContext) => Dec | [Dec, Dec];

function wrap(result: Dec | [Dec, Dec]): PyValue {
  return Array.isArray(result) ? newTuple(result.map((each) => newDecimal(each))) : newDecimal(result);
}

function defineOperator(name: string, operate: Binary): void {
  defineSlot(decimalClass, `__${name}__`, (self, [other]) => {
    const b = operand(other);
    if (b === undefined) return NotImplemented;
    return wrap(inContext(getContext(), (state) => operate(valueOf(self), b, state)));
  });
  defineSlot(decimalClass, `__r${name}__`, (self, [other]) => {
    const a = operand(other);
    if (a === undefined) return NotImplemented;
    return wrap(inContext(getContext(), (state) => operate(a, valueOf(self), state)));
  });
}

for (const [name, operate] of OPERATORS) defineOperator(name, operate);
defineOperator('floordiv', floorDivide);
defineOperator('mod', remainder);
defineOperator('divmod', divideWithRemainder);

defineSlot(decimalClass, '__pow__', (self, [other, modulo]) => {
  const b = operand(other);
  if (b === undefined) return NotImplemented;
  if (modulo !== undefined && modulo !== None) {
    const m = operand(modulo);
    if (m === undefined) return NotImplemented;
    return newDecimal(inContext(getContext(), (state) => powerModulo(valueOf(self), b, m, state)));
  }
  return newDecimal(inContext(getContext(), (state) => power(valueOf(self), b, state)));
});
defineSlot(decimalClass, '__rpow__', (self, [other, modulo]) => {
  const a = operand(other);
  if (a === undefined) return NotImplemented;
  if (modulo !== undefined && modulo !== None) {
    const m = operand(modulo);
    if (m === undefined) return NotImplemented;
    return newDecimal(inContext(getContext(), (state) => powerModulo(a, valueOf(self), m, state)));
  }
  return newDecimal(inContext(getContext(), (state) => power(a, valueOf(self), state)));
});

defineSlot(decimalClass, '__neg__', (self) =>
  newDecimal(inContext(getContext(), (state) => negate(valueOf(self), state)))
);
defineSlot(decimalClass, '__pos__', (self) =>
  newDecimal(inContext(getContext(), (state) => plus(valueOf(self), state)))
);
defineSlot(decimalClass, '__abs__', (self) =>
  newDecimal(inContext(getContext(), (state) => absolute(valueOf(self), state)))
);

// Comparisons --------------------------------------------------------------------------------------------------------

type Order = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** The two decimals `self op other` compares, as `_convert_for_comparison` makes them, or undefined. */
function comparisonOperands(self: Dec, other: PyValue, order: Order): [Dec, Dec] | undefined {
  if (other instanceof PyDecimal) return [self, other.value];
  const ratio = rationalRatio(other);
  if (ratio) {
    const scaled = isFinite(self) ? dec(self.sign, multiply(BigInt(self.int), ratio[1]).toString(), self.exp) : self;
    return [scaled, fromInteger(ratio[0])];
  }
  const equality = order === '==' || order === '!=';
  const real = equality && other instanceof PyComplex && other.imag === 0 ? other.real : other;
  if (typeof real !== 'number') return undefined;
  inContext(getContext(), (state) => {
    if (equality) state.flags.add('FloatOperation');
    else state.status.add('FloatOperation');
  });
  return [self, fromFloat(real)];
}

const ORDER_TESTS: Record<Order, (order: number) => boolean> = {
  '==': (order) => order === 0,
  '!=': (order) => order !== 0,
  '<': (order) => order < 0,
  '<=': (order) => order <= 0,
  '>': (order) => order > 0,
  '>=': (order) => order >= 0,
};

function richCompare(self: PyValue, other: PyValue, order: Order): PyValue {
  const operands = comparisonOperands(valueOf(self), other, order);
  if (!operands) return NotImplemented;
  const [a, b] = operands;
  if (isNan(a) || isNan(b)) {
    const signaling = a.exp === 'N' || b.exp === 'N';
    if (signaling || (order !== '==' && order !== '!=')) {
      inContext(getContext(), (state) => compareCheckNans(a, b, state));
    }
    return order === '!=';
  }
  return ORDER_TESTS[order](compareValues(a, b));
}

for (const [name, order] of [
  ['__eq__', '=='],
  ['__ne__', '!='],
  ['__lt__', '<'],
  ['__le__', '<='],
  ['__gt__', '>'],
  ['__ge__', '>='],
] as const) {
  defineSlot(decimalClass, name, (self, [other]) => richCompare(self, other, order));
}

defineSlot(decimalClass, '__hash__', (self) => {
  const value = valueOf(self);
  if (value.exp === 'N') throw typeError('Cannot hash a signaling NaN value');
  if (value.exp === 'n') return BigInt((self as PyDecimal).identity) * 16n + 7n;
  if (value.exp === 'F') return value.sign ? -314_159n : 314_159n;
  const ratio = asIntegerRatio(value as FiniteDec);
  return hashRatio(ratio);
});

// Conversions --------------------------------------------------------------------------------------------------------

function asIntegerRatio(self: FiniteDec): [bigint, bigint] {
  if (self.int === '0') return [0n, 1n];
  let n = BigInt(self.int);
  let d: bigint;
  if (self.exp >= 0) {
    n = multiply(n, tenTo(self.exp));
    d = 1n;
  } else {
    let d5 = -self.exp;
    while (d5 > 0 && n % 5n === 0n) {
      n /= 5n;
      d5 -= 1;
    }
    let d2 = -self.exp;
    let shift = 0;
    while (shift < d2 && (n & 1n) === 0n) {
      n >>= 1n;
      shift++;
    }
    d2 -= shift;
    d = (5n ** BigInt(d5)) << BigInt(d2);
  }
  return [self.sign ? -n : n, d];
}

function integerValue(value: Dec): FiniteDec {
  if (isNan(value)) throw valueError('cannot convert NaN to integer');
  if (!isFinite(value)) throw pyError('OverflowError', 'cannot convert Infinity to integer');
  return value;
}

function roundedInt(self: PyValue, rounding: Rounding): bigint {
  return truncatedInt(rescale(integerValue(valueOf(self)), 0, rounding) as FiniteDec);
}

defineSlot(decimalClass, '__int__', (self) => truncatedInt(integerValue(valueOf(self))));
defineSlot(decimalClass, '__trunc__', (self) => truncatedInt(integerValue(valueOf(self))));
defineSlot(decimalClass, '__floor__', (self) => roundedInt(self, 'ROUND_FLOOR'));
defineSlot(decimalClass, '__ceil__', (self) => roundedInt(self, 'ROUND_CEILING'));
defineSlot(decimalClass, '__float__', (self) => decimalToFloat(valueOf(self)));
defineSlot(decimalClass, '__complex__', (self) => newComplex(decimalToFloat(valueOf(self)), 0));
defineSlot(decimalClass, '__bool__', (self) => isNonzero(valueOf(self)));

export function decimalToFloat(value: Dec): number {
  if (value.exp === 'N') throw valueError('cannot convert signaling NaN to float');
  if (value.exp === 'n') return Number.NaN;
  return parseFloatText(decimalString(value, 1)) as number;
}

defineSlot(decimalClass, '__round__', (self, args) => {
  if (args.length > 1) throw typeError(`__round__ expected at most 1 argument, got ${args.length}`);
  const [digits] = args;
  if (digits === undefined) return roundedInt(self, 'ROUND_HALF_EVEN');
  if (typeof digits !== 'bigint' && typeof digits !== 'boolean') throw typeError('optional arg must be an integer');
  const exponent = dec(0, '1', -Number(digits));
  return newDecimal(inContext(getContext(), (state) => quantize(valueOf(self), exponent, state.rounding, state)));
});

defineSlot(
  decimalClass,
  '__repr__',
  (self) => `Decimal('${decimalString(valueOf(self), getContext().state.capitals)}')`
);
defineSlot(decimalClass, '__str__', (self) => decimalString(valueOf(self), getContext().state.capitals));
defineSlot(decimalClass, '__format__', (self, args) => {
  if (args.length === 0 || args.length > 2) throw typeError(`__format__ expected 1 or 2 arguments, got ${args.length}`);
  const spec = stringValue(args[0]) ?? args[0];
  if (typeof spec !== 'string') throw typeError(`format spec must be a string`);
  return formatDecimal(valueOf(self), spec, getContext().state);
});
defineSlot(decimalClass, '__copy__', (self) => self);
defineSlot(decimalClass, '__deepcopy__', (self) => self);

defineProperty(decimalClass, 'real', (self) => self);
defineProperty(decimalClass, 'imag', () => newDecimal(dec(0, '0', 0)));
defineSlot(decimalClass, 'conjugate', (self) => self);
defineSlot(decimalClass, 'radix', () => newDecimal(dec(0, '10', 0)));
defineSlot(decimalClass, 'adjusted', (self) => {
  const value = valueOf(self);
  return BigInt(isFinite(value) ? value.exp + value.int.length - 1 : 0);
});
defineSlot(decimalClass, 'as_integer_ratio', (self) => {
  const value = valueOf(self);
  if (isNan(value)) throw valueError('cannot convert NaN to integer ratio');
  if (!isFinite(value)) throw pyError('OverflowError', 'cannot convert Infinity to integer ratio');
  return newTuple(asIntegerRatio(value));
});

let decimalTupleClass: PyClass | undefined;

/** `decimal.DecimalTuple`, created when a program first imports decimal or calls `as_tuple()`. */
function decimalTuple(): PyClass {
  decimalTupleClass ??= makeNamedTupleClass('DecimalTuple', ['sign', 'digits', 'exponent'], 'decimal');
  return decimalTupleClass;
}

defineSlot(decimalClass, 'as_tuple', (self) => {
  const value = valueOf(self);
  const digits = value.exp === 'F' ? [0n] : value.int.split('').map(BigInt);
  const exponent = typeof value.exp === 'number' ? BigInt(value.exp) : value.exp;
  return callValue(decimalTuple(), [BigInt(value.sign), newTuple(digits), exponent]);
});

for (const [name, binding] of [
  ['from_float', 'class'],
  ['from_number', 'class'],
] as const) {
  defineSlot(
    decimalClass,
    name,
    (cls, [value]) => {
      if (
        name === 'from_float' &&
        typeof value !== 'number' &&
        typeof value !== 'bigint' &&
        typeof value !== 'boolean'
      ) {
        throw typeError('argument must be int or float');
      }
      if (
        name === 'from_number' &&
        !(value instanceof PyDecimal) &&
        typeof value !== 'number' &&
        typeof value !== 'bigint' &&
        typeof value !== 'boolean'
      ) {
        throw typeError('conversion from ' + typeName(value) + ' to Decimal is not supported');
      }
      const result = typeof value === 'number' ? fromFloat(value) : (operand(value) as Dec);
      return newDecimal(result, cls as PyClass);
    },
    binding
  );
}

// Methods shared with Context -----------------------------------------------------------------------------------------

type Result = ReturnType<Operation['run']>;

function wrapResult(result: Result): PyValue {
  if (typeof result === 'boolean' || typeof result === 'string') return result;
  return wrap(result);
}

/** Defines a Decimal method `name(self, *operands, [rounding,] context=None)` and the Context method `name(a, ...)`. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows the argument handling of the C module _decimal.
function defineShared(name: string, operation: Operation): void {
  const operandCount = operation.arity - 1;
  if (!operation.contextOnly) {
    const keywords =
      operation.contextFree && operandCount === 0 ? [] : operation.rounding ? ['rounding', 'context'] : ['context'];
    defineSlot(decimalClass, name, (self, args, kwargs) => {
      if (keywords.length === 0 && (args.length > 0 || (kwargs && kwargs.size > 0))) {
        if (kwargs && kwargs.size > 0) throw typeError(`Decimal.${name}() takes no keyword arguments`);
        throw typeError(`Decimal.${name}() takes no arguments (${args.length} given)`);
      }
      const names = [...operation.names, ...keywords];
      const bound = bindFunctionArgs(args, kwargs, operandCount, names);
      const operands = [valueOf(self), ...bound.slice(0, operandCount).map((each) => requireOperand(each as PyValue))];
      const rounding = operation.rounding ? roundingArgument(bound[operandCount]) : undefined;
      const context = contextArgument(bound[names.indexOf('context')]);
      return wrapResult(inContext(context, (state) => operation.run(operands, state, rounding)));
    });
  }
  if (operation.contextName === null) return;
  const contextNames = ['a', 'b', 'c'].slice(0, operation.arity);
  defineSlot(contextClass, operation.contextName ?? name, (self, args, kwargs) => {
    const bound = bindFunctionArgs(args, kwargs, operation.arity, contextNames);
    const operands = bound.map((each) => requireOperand(each as PyValue));
    return wrapResult(inContext(self as PyContext, (state) => operation.run(operands, state, undefined)));
  });
}

function roundingArgument(value: PyValue | undefined): Rounding | undefined {
  value = stringValue(value) ?? value;
  if (value === undefined || value === None) return undefined;
  if (typeof value !== 'string' || !(ROUNDINGS as readonly string[]).includes(value)) {
    throw typeError(
      'valid values for rounding are:\n  [ROUND_CEILING, ROUND_FLOOR, ROUND_UP, ROUND_DOWN,\n   ROUND_HALF_UP, ROUND_HALF_DOWN, ROUND_HALF_EVEN,\n   ROUND_05UP]'
    );
  }
  return value as Rounding;
}

/** Binds arguments as `PyArg_ParseTupleAndKeywords` does for a C method, whose messages name no function. */
function bindFunctionArgs(
  args: PyValue[],
  kwargs: Kwargs,
  required: number,
  names: readonly string[]
): (PyValue | undefined)[] {
  const given = args.length + (kwargs?.size ?? 0);
  if (given > names.length) {
    throw typeError(`function takes at most ${names.length} argument${names.length === 1 ? '' : 's'} (${given} given)`);
  }
  const bound: (PyValue | undefined)[] = [...args];
  for (const [key, value] of kwargs ?? []) {
    const index = names.indexOf(key);
    if (index === -1) throw typeError(`this function got an unexpected keyword argument '${key}'`);
    if (index < args.length)
      throw typeError(`argument for function given by name ('${key}') and position (${index + 1})`);
    bound[index] = value;
  }
  for (let index = 0; index < required; index++) {
    if (bound[index] === undefined)
      throw typeError(`function missing required argument '${names[index]}' (pos ${index + 1})`);
  }
  return bound;
}

for (const [name, operation] of Object.entries(DECIMAL_OPERATIONS)) defineShared(name, operation);

// Context methods without a Decimal counterpart --------------------------------------------------------------------------

defineSlot(contextClass, 'create_decimal', (self, args) => {
  if (args.length > 1) throw typeError(`function takes at most 1 argument (${args.length} given)`);
  const value = stringValue(args[0]) ?? args[0] ?? '0';
  const context = self as PyContext;
  return newDecimal(
    inContext(context, (state) => {
      if (typeof value === 'string') {
        const strict = /^\S(?:.*\S)?$/su.test(value) && !value.includes('_') ? parseDecimal(value) : undefined;
        // libmpdec rejects a NaN whose payload does not fit the context, which the constructor keeps.
        const fits = strict !== undefined && !(isNan(strict) && strict.int.length > state.prec - state.clamp);
        return fix(fits ? strict : raiseCondition(state, 'ConversionSyntax'), state);
      }
      if (typeof value === 'number') return fix(fromFloat(value), state);
      return fix(convertExact(value, context), state);
    })
  );
});
defineSlot(contextClass, 'create_decimal_from_float', (self, [value]) => {
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'boolean') {
    throw typeError('argument must be int or float');
  }
  const exact = typeof value === 'number' ? fromFloat(value) : fromInteger(BigInt(value));
  return newDecimal(inContext(self as PyContext, (state) => fix(exact, state)));
});
defineSlot(contextClass, 'radix', () => newDecimal(dec(0, '10', 0)));
defineSlot(contextClass, '_apply', (self, [value]) =>
  newDecimal(inContext(self as PyContext, (state) => fix(requireOperand(value), state)))
);
defineSlot(contextClass, 'to_sci_string', (self, [value]) =>
  decimalString(requireOperand(value), (self as PyContext).state.capitals)
);
defineSlot(contextClass, 'to_eng_string', (self, [value]) =>
  decimalString(requireOperand(value), (self as PyContext).state.capitals, true)
);
defineSlot(contextClass, 'power', (self, args, kwargs) => {
  const bound = bindFunctionArgs(args, kwargs, 2, ['a', 'b', 'modulo']);
  const [a, b] = bound.slice(0, 2).map((each) => requireOperand(each as PyValue));
  const modulo = bound[2];
  return newDecimal(
    inContext(self as PyContext, (state) =>
      modulo === undefined || modulo === None ? power(a, b, state) : powerModulo(a, b, requireOperand(modulo), state)
    )
  );
});

defineSlot(decimalClass, 'to_eng_string', (self, args, kwargs) => {
  const [context] = bindFunctionArgs(args, kwargs, 0, ['context']);
  return decimalString(valueOf(self), contextArgument(context).state.capitals, true);
});

// The module ---------------------------------------------------------------------------------------------------------

/** `IEEEContext(bits)`: the context of an IEEE 754 decimal interchange format of `bits` bits. */
function ieeeContext(bits: PyValue): PyValue {
  if (typeof bits !== 'bigint' && typeof bits !== 'boolean') throw typeError('an integer is required');
  const size = BigInt(bits);
  if (size <= 0n || size > 512n || size % 32n !== 0n) {
    throw valueError('argument must be a multiple of 32, with a maximum of 512');
  }
  const emax = 3n * 2n ** (size / 16n + 3n);
  return callValue(
    contextClass,
    [],
    new Map<string, PyValue>([
      ['prec', 9n * (size / 32n) - 2n],
      ['rounding', 'ROUND_HALF_EVEN'],
      ['Emin', 1n - emax],
      ['Emax', emax],
      ['capitals', 1n],
      ['clamp', 1n],
      ['flags', newList([])],
      ['traps', newList([])],
    ])
  );
}

registerModule('decimal', () => {
  // As _decimal registers Decimal with numbers.Number when imported.
  abcRegister(numberClass, decimalClass, true);
  const state = moduleState();
  const namespace = new Map<string, PyValue>([
    ['Decimal', decimalClass],
    ['Context', contextClass],
    ['DecimalTuple', decimalTuple()],
    ['getcontext', builtin('getcontext', 'none', 0, 0, () => getContext())],
    [
      'setcontext',
      builtin('setcontext', 'one', 1, 1, ([context]) => {
        setContext(context);
        return None;
      }),
    ],
    ['localcontext', nativeFunction('localcontext', localContext)],
    ['DefaultContext', state.defaultContext],
    ['BasicContext', state.basicContext],
    ['ExtendedContext', state.extendedContext],
    ['MAX_PREC', MAX_PREC],
    ['MAX_EMAX', MAX_EMAX],
    ['MIN_EMIN', MIN_EMIN],
    ['MIN_ETINY', MIN_EMIN - MAX_PREC + 1n],
    ['IEEE_CONTEXT_MAX_BITS', 512n],
    ['IEEEContext', builtin('IEEEContext', 'one', 1, 1, ([bits]) => ieeeContext(bits))],
    ['HAVE_THREADS', true],
    ['HAVE_CONTEXTVAR', true],
  ]);
  for (const rounding of ROUNDINGS) namespace.set(rounding, rounding);
  for (const [name, cls] of decimalExceptions) namespace.set(name, cls);
  return namespace;
});
