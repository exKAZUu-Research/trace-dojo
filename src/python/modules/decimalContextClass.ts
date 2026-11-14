import { pyRepr } from '../conversions';
import { method } from '../define';
import { iterate } from '../objects';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  exceptionClassNamed,
  newDict,
  newException,
  newList,
  None,
  objectClass,
  propertyClass,
  pyError,
  stringValue,
  typeClass,
  typeError,
  valueError,
} from '../types';
import {
  DONE,
  type Kwargs,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyDict,
  PyError,
  PyInstance,
  PyIterator,
  PyOpaque,
  type PyValue,
} from '../values';
import { getInternalContextVar, newInternalContextVar, setInternalContextVar } from './contextvars';
import {
  type Condition,
  conditionSet,
  conditionsOf,
  copyContextState,
  type DecimalContext,
  INVALID_CONDITIONS,
  newContextState,
  type Rounding,
  ROUNDINGS,
  type Signal,
  signalOf,
  SIGNALS,
} from './decimalContext';
import { defineSlot } from './numberSupport';

// Exceptions ---------------------------------------------------------------------------------------------------------

function exceptionClass(name: string, bases: PyClass[], mro: string[]): PyClass {
  const cls = new PyClass(name, bases, typeClass);
  cls.module = 'decimal';
  cls.layout = { base: 'exception' };
  cls.isBaseType = true;
  cls.construct = exceptionClassNamed('Exception').construct;
  cls.mro = [cls, ...mro.map((each) => decimalExceptions.get(each) ?? exceptionClassNamed(each))];
  decimalExceptions.set(name, cls);
  return cls;
}

export const decimalExceptions = new Map<string, PyClass>();
const tail = ['ArithmeticError', 'Exception', 'BaseException'];
const named = (name: string): PyClass => decimalExceptions.get(name) ?? exceptionClassNamed(name);

exceptionClass('DecimalException', [named('ArithmeticError')], tail);
for (const name of ['Clamped', 'Inexact', 'Rounded', 'Subnormal', 'InvalidOperation']) {
  exceptionClass(name, [named('DecimalException')], ['DecimalException', ...tail]);
}
exceptionClass(
  'DivisionByZero',
  [named('DecimalException'), named('ZeroDivisionError')],
  ['DecimalException', 'ZeroDivisionError', ...tail]
);
exceptionClass(
  'FloatOperation',
  [named('DecimalException'), named('TypeError')],
  ['DecimalException', 'ArithmeticError', 'TypeError', 'Exception', 'BaseException']
);
for (const name of ['ConversionSyntax', 'DivisionImpossible', 'InvalidContext']) {
  exceptionClass(name, [named('InvalidOperation')], ['InvalidOperation', 'DecimalException', ...tail]);
}
exceptionClass(
  'DivisionUndefined',
  [named('InvalidOperation'), named('ZeroDivisionError')],
  ['InvalidOperation', 'DecimalException', 'ZeroDivisionError', ...tail]
);
exceptionClass('Overflow', [named('Inexact'), named('Rounded')], ['Inexact', 'Rounded', 'DecimalException', ...tail]);
exceptionClass(
  'Underflow',
  [named('Inexact'), named('Rounded'), named('Subnormal')],
  ['Inexact', 'Rounded', 'Subnormal', 'DecimalException', ...tail]
);
for (const cls of decimalExceptions.values()) cls.mro.push(objectClass);

function signalClass(signal: Condition): PyClass {
  return decimalExceptions.get(signal) as PyClass;
}

function signalOfClass(value: PyValue): Signal | undefined {
  return SIGNALS.find((signal) => signalClass(signal) === value);
}

/** Records the conditions an operation met in the context's flags, raising the exception of a trapped one. */
export function commitStatus(context: DecimalContext): void {
  const { status } = context;
  if (status.size === 0) return;
  for (const condition of status) context.flags.add(condition);
  const trapped = [...status].filter((condition) => context.traps.has(condition));
  status.clear();
  if (trapped.length === 0) return;
  const signal = SIGNALS.find((each) => trapped.some((condition) => signalOf(condition) === each)) as Signal;
  const order: Condition[] = [...INVALID_CONDITIONS, ...SIGNALS.slice(1)];
  const listed = order.filter((condition) => trapped.includes(condition)).map(signalClass);
  throw new PyError(newException(signalClass(signal), [newList(listed)]));
}

// Context ------------------------------------------------------------------------------------------------------------

export const MAX_PREC = 999_999_999_999_999_999n;
export const MAX_EMAX = 999_999_999_999_999_999n;
export const MIN_EMIN = -999_999_999_999_999_999n;

/** A `decimal.Context`. */
export class PyContext extends PyInstance {
  constructor(
    cls: PyClass,
    readonly state: DecimalContext
  ) {
    super(cls);
  }
}

export const contextClass = new PyClass('Context', [objectClass], typeClass);
contextClass.mro = [contextClass, objectClass];
contextClass.module = 'decimal';
contextClass.typeName = 'decimal.Context';
contextClass.isBaseType = true;

const CONTEXT_FIELDS = ['prec', 'rounding', 'Emin', 'Emax', 'capitals', 'clamp', 'flags', 'traps'] as const;

contextClass.construct = (cls, args, kwargs) => {
  if (args.length > 8) throw typeError(`function takes at most 8 arguments (${args.length} given)`);
  for (const key of kwargs?.keys() ?? []) {
    if (!(CONTEXT_FIELDS as readonly string[]).includes(key)) {
      throw typeError(`this function got an unexpected keyword argument '${key}'`);
    }
  }
  const template = moduleState().defaultContext.state;
  const context = new PyContext(cls, { ...copyContextState(template), flags: new Set() });
  for (const [index, field] of CONTEXT_FIELDS.entries()) {
    const value = args[index] ?? kwargs?.get(field);
    if (value !== undefined && value !== None) setContextField(context, field, value);
  }
  return context;
};

export function contextState(value: PyValue): DecimalContext {
  return (value as PyContext).state;
}

function integerField(value: PyValue): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  throw typeError('an integer is required');
}

// code-gauge-allow functionCognitiveComplexity 16 -- One case per context field and signal container, with the messages of the C module.
// code-gauge-allow functionNcss 36 -- One case per context field and signal container, with the messages of the C module.
function setContextField(context: PyContext, field: string, value: PyValue): void {
  const { state } = context;
  switch (field) {
    case 'prec': {
      const prec = integerField(value);
      if (prec < 1n || prec > MAX_PREC) throw valueError('valid range for prec is [1, MAX_PREC]');
      state.prec = Number(prec);
      return;
    }
    case 'rounding': {
      value = stringValue(value) ?? value;
      if (typeof value !== 'string' || !(ROUNDINGS as readonly string[]).includes(value)) {
        throw typeError(
          'valid values for rounding are:\n  [ROUND_CEILING, ROUND_FLOOR, ROUND_UP, ROUND_DOWN,\n   ROUND_HALF_UP, ROUND_HALF_DOWN, ROUND_HALF_EVEN,\n   ROUND_05UP]'
        );
      }
      state.rounding = value as Rounding;
      return;
    }
    case 'Emin': {
      const emin = integerField(value);
      if (emin > 0n || emin < MIN_EMIN) throw valueError('valid range for Emin is [MIN_EMIN, 0]');
      state.Emin = Number(emin);
      return;
    }
    case 'Emax': {
      const emax = integerField(value);
      if (emax < 0n || emax > MAX_EMAX) throw valueError('valid range for Emax is [0, MAX_EMAX]');
      state.Emax = Number(emax);
      return;
    }
    case 'capitals':
    case 'clamp': {
      const flag = integerField(value);
      if (flag !== 0n && flag !== 1n) throw valueError(`valid values for ${field} are 0 or 1`);
      state[field] = Number(flag);
      return;
    }
    default: {
      setSignals(state[field as 'flags' | 'traps'], value);
    }
  }
}

const INVALID_SIGNAL =
  'valid values for signals are:\n  [InvalidOperation, FloatOperation, DivisionByZero,\n   Overflow, Underflow, Subnormal, Inexact, Rounded,\n   Clamped]';

// code-gauge-allow functionCognitiveComplexity 22 -- One case per context field and signal container, with the messages of the C module.
function setSignals(target: Set<Condition>, value: PyValue): void {
  if (value instanceof PyDict || isSignalDict(value)) {
    const entries =
      value instanceof PyDict
        ? value.store.ordered().map((entry) => [entry.key, entry.value] as const)
        : signalEntries(value);
    if (entries.length !== SIGNALS.length || entries.some(([key]) => signalOfClass(key) === undefined)) {
      throw pyError('KeyError', 'invalid signal dict');
    }
    target.clear();
    for (const [key, enabled] of entries) {
      if (currentRuntime().truthy(enabled))
        for (const each of conditionsOf(signalOfClass(key) as Signal)) target.add(each);
    }
    return;
  }
  const next = iterate(value);
  const signals: Signal[] = [];
  for (let item = next(); item !== DONE; item = next()) {
    const signal = signalOfClass(item);
    if (signal === undefined) throw pyError('KeyError', INVALID_SIGNAL);
    signals.push(signal);
  }
  target.clear();
  for (const signal of signals) for (const each of conditionsOf(signal)) target.add(each);
}

/** The status bits of libmpdec in order, which decides the order of the flags and traps in a context's repr. */
const STATUS_BITS: Condition[] = [
  'Clamped',
  'ConversionSyntax',
  'DivisionByZero',
  'DivisionImpossible',
  'DivisionUndefined',
  'Inexact',
  'InvalidContext',
  'InvalidOperation',
  'FloatOperation',
  'Overflow',
  'Rounded',
  'Subnormal',
  'Underflow',
];

function signalList(conditions: Set<Condition>): string {
  const names = new Set(STATUS_BITS.filter((condition) => conditions.has(condition)).map(signalOf));
  return `[${[...names].join(', ')}]`;
}

export function contextRepr(state: DecimalContext): string {
  return `Context(prec=${state.prec}, rounding=${state.rounding}, Emin=${state.Emin}, Emax=${state.Emax}, capitals=${state.capitals}, clamp=${state.clamp}, flags=${signalList(state.flags)}, traps=${signalList(state.traps)})`;
}

method(contextClass, '__repr__', 'none', 0, 0, (self) => contextRepr(contextState(self)));
method(contextClass, 'copy', 'none', 0, 0, (self) => copyContext(self as PyContext));
method(contextClass, '__copy__', 'none', 0, 0, (self) => copyContext(self as PyContext));
method(contextClass, 'clear_flags', 'none', 0, 0, (self) => {
  contextState(self).flags.clear();
  return None;
});
method(contextClass, 'clear_traps', 'none', 0, 0, (self) => {
  contextState(self).traps.clear();
  return None;
});
method(contextClass, 'Etiny', 'none', 0, 0, (self) => BigInt(contextState(self).Emin - contextState(self).prec + 1));
method(contextClass, 'Etop', 'none', 0, 0, (self) => BigInt(contextState(self).Emax - contextState(self).prec + 1));
defineSlot(contextClass, '__setattr__', (self, [name, value]) => {
  name = stringValue(name) ?? name;
  if (typeof name !== 'string' || !(CONTEXT_FIELDS as readonly string[]).includes(name)) {
    throw pyError(
      'AttributeError',
      `'decimal.Context' object has no attribute '${typeof name === 'string' ? name : pyRepr(name)}'`
    );
  }
  setContextField(self as PyContext, name, value);
  return None;
});

const getterClass = builtinClass('getter');
const deleter = new PyBuiltinFunction(getterClass, '__delete__', () => {
  throw pyError('AttributeError', 'context attributes cannot be deleted');
});
for (const field of CONTEXT_FIELDS) {
  contextClass.dict.set(
    field,
    new PyDescriptor(
      propertyClass,
      new PyBuiltinFunction(getterClass, field, ([self]) => contextField(self as PyContext, field)),
      new PyBuiltinFunction(getterClass, field, ([self, value]) => {
        setContextField(self as PyContext, field, value);
        return None;
      }),
      deleter
    )
  );
}

function contextField(context: PyContext, field: (typeof CONTEXT_FIELDS)[number]): PyValue {
  const { state } = context;
  if (field === 'flags' || field === 'traps') return new PyOpaque(signalDictClass, field, state[field]);
  if (field === 'rounding') return state.rounding;
  return BigInt(state[field]);
}

export function copyContext(context: PyContext, cls: PyClass = contextClass): PyContext {
  return new PyContext(cls, { ...copyContextState(context.state), flags: new Set(context.state.flags) });
}

// SignalDict ---------------------------------------------------------------------------------------------------------

const signalDictClass = builtinClass('SignalDict');
signalDictClass.module = 'abc';

function isSignalDict(value: PyValue): value is PyOpaque {
  return value instanceof PyOpaque && value.cls === signalDictClass;
}

function signalsOf(value: PyValue): Set<Condition> {
  return (value as PyOpaque).data as Set<Condition>;
}

function hasSignal(conditions: Set<Condition>, signal: Signal): boolean {
  return conditionsOf(signal).some((condition) => conditions.has(condition));
}

function signalEntries(value: PyValue): [PyValue, PyValue][] {
  const conditions = signalsOf(value);
  return SIGNALS.map((signal) => [signalClass(signal), hasSignal(conditions, signal)]);
}

function signalKey(key: PyValue): Signal {
  const signal = signalOfClass(key);
  if (signal === undefined) throw pyError('KeyError', INVALID_SIGNAL);
  return signal;
}

method(signalDictClass, '__getitem__', 'one', 1, 1, (self, [key]) => hasSignal(signalsOf(self), signalKey(key)));
method(signalDictClass, '__setitem__', 'expected', 2, 2, (self, [key, value]) => {
  const signal = signalKey(key);
  const conditions = signalsOf(self);
  for (const condition of conditionsOf(signal)) {
    if (currentRuntime().truthy(value)) conditions.add(condition);
    else conditions.delete(condition);
  }
  return None;
});
method(signalDictClass, '__delitem__', 'one', 1, 1, () => {
  throw valueError('signal keys cannot be deleted');
});
method(signalDictClass, '__len__', 'none', 0, 0, () => BigInt(SIGNALS.length));
method(signalDictClass, '__contains__', 'one', 1, 1, (_self, [key]) => signalOfClass(key) !== undefined);
method(signalDictClass, '__iter__', 'none', 0, 0, () => {
  const keys = SIGNALS.map(signalClass);
  let index = 0;
  return new PyIterator(builtinClass('dict_keyiterator'), () => (index < keys.length ? keys[index++] : DONE));
});
method(signalDictClass, 'keys', 'none', 0, 0, () => newList(SIGNALS.map(signalClass)));
method(signalDictClass, 'values', 'none', 0, 0, (self) =>
  newList(SIGNALS.map((signal) => hasSignal(signalsOf(self), signal)))
);
method(signalDictClass, 'items', 'none', 0, 0, (self) =>
  newList(signalEntries(self).map((entry) => currentRuntime().tuple(entry)))
);
method(signalDictClass, 'copy', 'none', 0, 0, (self) => {
  return newDict(signalEntries(self));
});
method(signalDictClass, 'get', 'expected', 1, 2, (self, [key, fallback]) => {
  const signal = signalOfClass(key);
  return signal === undefined ? (fallback ?? None) : hasSignal(signalsOf(self), signal);
});
method(signalDictClass, '__repr__', 'none', 0, 0, (self) => {
  const parts = signalEntries(self).map(([key, value]) => `${pyRepr(key)}:${value ? 'True' : 'False'}`);
  return `{${parts.join(', ')}}`;
});
method(signalDictClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (isSignalDict(other))
    return SIGNALS.every((signal) => hasSignal(signalsOf(self), signal) === hasSignal(signalsOf(other), signal));
  return false;
});

// The current context ------------------------------------------------------------------------------------------------

interface ModuleState {
  contextVar: PyOpaque;
  defaultContext: PyContext;
  basicContext: PyContext;
  extendedContext: PyContext;
}

const states = new WeakMap<Runtime, ModuleState>();

export function moduleState(): ModuleState {
  const runtime = currentRuntime();
  let state = states.get(runtime);
  if (!state) {
    state = {
      contextVar: newInternalContextVar('decimal_context'),
      defaultContext: new PyContext(contextClass, newContextState()),
      basicContext: new PyContext(
        contextClass,
        newContextState({
          prec: 9,
          rounding: 'ROUND_HALF_UP',
          traps: conditionSet(['InvalidOperation', 'DivisionByZero', 'Overflow', 'Underflow', 'Clamped']),
        })
      ),
      extendedContext: new PyContext(contextClass, newContextState({ prec: 9, traps: new Set() })),
    };
    states.set(runtime, state);
  }
  return state;
}

export function getContext(): PyContext {
  const state = moduleState();
  let current = getInternalContextVar(state.contextVar) as PyContext | undefined;
  if (!current) {
    current = copyContext(state.defaultContext);
    setInternalContextVar(state.contextVar, current);
  }
  return current;
}

export function setContext(value: PyValue): void {
  if (!(value instanceof PyContext)) throw typeError('argument must be a context');
  const state = moduleState();
  const templates: PyValue[] = [state.defaultContext, state.basicContext, state.extendedContext];
  if (templates.includes(value)) {
    const copy = copyContext(value);
    copy.state.flags.clear();
    setInternalContextVar(state.contextVar, copy);
    return;
  }
  setInternalContextVar(state.contextVar, value);
}

/** The context an operation uses: the one passed as `context=`, or the current one. */
export function contextArgument(value: PyValue | undefined): PyContext {
  if (value === undefined || value === None) return getContext();
  if (!(value instanceof PyContext)) throw typeError('optional argument must be a context');
  return value;
}

// localcontext -------------------------------------------------------------------------------------------------------

const contextManagerClass = builtinClass('ContextManager');
contextManagerClass.module = 'decimal';

interface ManagerData {
  context: PyContext;
  saved?: PyContext;
}

export function localContext(args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length > 1) throw typeError(`localcontext() takes at most 1 positional argument (${args.length} given)`);
  const base = contextArgument(args[0] ?? kwargs?.get('ctx'));
  const context = copyContext(base);
  for (const [key, value] of kwargs ?? []) {
    if (key === 'ctx') continue;
    if (!(CONTEXT_FIELDS as readonly string[]).includes(key)) {
      throw typeError(`'${key}' is an invalid keyword argument for this function`);
    }
    setContextField(context, key, value);
  }
  return new PyOpaque(contextManagerClass, 'ContextManager', { context } satisfies ManagerData);
}

method(contextManagerClass, '__enter__', 'none', 0, 0, (self) => {
  const data = (self as PyOpaque).data as ManagerData;
  data.saved = getContext();
  setContext(data.context);
  return data.context;
});
method(contextManagerClass, '__exit__', 'expected', 3, 3, (self) => {
  const data = (self as PyOpaque).data as ManagerData;
  if (data.saved) setInternalContextVar(moduleState().contextVar, data.saved);
  return None;
});
