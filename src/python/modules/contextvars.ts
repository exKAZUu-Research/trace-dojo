// `contextvars` and `_contextvars`.
import { addressOf, pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { keyError } from '../items';
import { registerModule } from '../modules';
import { callValue, getAttribute } from '../objects';
import { equals } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { callSuspending } from '../threadIteration';
import { getThreadContext, registerSuspendingVariant, setThreadContext } from '../threads';
import {
  builtinClass,
  defineMethod,
  exceptionClassNamed,
  newException,
  newTuple,
  None,
  NotImplemented,
  pyError,
  stringValue,
  typeError,
  typeName,
} from '../types';
import { DONE, type PyBuiltinFunction, PyError, PyIterator, PyOpaque, type PyValue } from '../values';
import { defineProperty } from './numberSupport';

const contextClass = builtinClass('Context');
const contextVarClass = builtinClass('ContextVar');
const tokenClass = builtinClass('Token');
const missingClass = builtinClass('Token.MISSING');
for (const cls of [contextClass, contextVarClass, tokenClass]) {
  cls.module = '_contextvars';
  cls.typeName = `_contextvars.${cls.name}`;
}
const MISSING = new PyOpaque(missingClass, 'MISSING');
method(missingClass, '__repr__', 'none', 0, 0, () => '<Token.MISSING>');
tokenClass.dict.set('MISSING', MISSING);

interface Context {
  values: Map<PyOpaque, PyValue>;
  entered?: boolean;
}

interface ContextVar {
  name: PyValue;
  default?: PyValue;
}

interface Token {
  context: ContextObject;
  variable: PyOpaque;
  old: PyValue;
  used: boolean;
}

type ContextObject = PyOpaque & { data: Context };

function currentContext(): ContextObject {
  const runtime = currentRuntime();
  let context = getThreadContext(runtime) as ContextObject | undefined;
  if (context === undefined) {
    context = newContext(new Map());
    setThreadContext(context, runtime);
  }
  return context;
}

export function newInternalContextVar(name: string): PyOpaque {
  return new PyOpaque(contextVarClass, stringValue(name) as string, { name } satisfies ContextVar);
}

export function getInternalContextVar(variable: PyOpaque): PyValue | undefined {
  return currentContext().data.values.get(variable);
}

export function setInternalContextVar(variable: PyOpaque, value: PyValue): void {
  setContextValue(currentContext().data.values, variable, value);
}

function copyContext(context: Context): ContextObject {
  currentRuntime().allocate(context.values.size * 2);
  return newContext(new Map(context.values));
}

function newContext(values: Map<PyOpaque, PyValue>): ContextObject {
  return new PyOpaque(contextClass, 'Context', {
    values,
  } satisfies Context) as ContextObject;
}

function setContextValue(values: Context['values'], variable: PyOpaque, value: PyValue): void {
  if (!values.has(variable)) currentRuntime().allocate(2);
  values.set(variable, value);
}

const contextOf = (value: PyValue): Context => (value as ContextObject).data;
const variableOf = (value: PyValue): ContextVar => (value as PyOpaque).data as ContextVar;
const tokenOf = (value: PyValue): Token => (value as PyOpaque).data as Token;

// Context -----------------------------------------------------------------------------------------------------------

contextClass.construct = (_cls, args, kwargs) => {
  if (args.length > 0 || (kwargs && kwargs.size > 0)) throw typeError('Context() does not accept any arguments');
  return newContext(new Map());
};
contextClass.dict.set('__hash__', None);

function enterContext(self: PyValue | undefined, args: PyValue[]): { context: ContextObject; previous: ContextObject } {
  if (self === undefined) throw typeError("descriptor 'run' of '_contextvars.Context' object needs an argument");
  if (!(self instanceof PyOpaque && self.cls === contextClass)) {
    throw typeError(
      `descriptor 'run' for '_contextvars.Context' objects doesn't apply to a '${typeName(self)}' object`
    );
  }
  if (args.length === 0) throw typeError('run() missing 1 required positional argument');
  const context = self as ContextObject;
  if (context.data.entered) {
    throw pyError('RuntimeError', `cannot enter context: ${pyRepr(context)} is already entered`);
  }
  const previous = currentContext();
  context.data.entered = true;
  setThreadContext(context);
  return { context, previous };
}

function exitContext(context: ContextObject, previous: ContextObject): void {
  setThreadContext(previous);
  context.data.entered = false;
}

defineMethod(contextClass, 'run', (self, args, kwargs) => {
  const { context, previous } = enterContext(self, args);
  try {
    return callValue(args[0], args.slice(1), kwargs);
  } finally {
    exitContext(context, previous);
  }
});
registerSuspendingVariant(contextClass.dict.get('run') as PyBuiltinFunction, function* ([self, ...args], kwargs) {
  const { context, previous } = enterContext(self, args);
  try {
    return yield* callSuspending(args[0], args.slice(1), kwargs);
  } finally {
    exitContext(context, previous);
  }
});
method(contextClass, 'copy', 'none', 0, 0, (self) => copyContext(contextOf(self)));
method(contextClass, '__getitem__', 'one', 1, 1, (self, [key]) => {
  const value = contextOf(self).values.get(checkedVariable(key));
  if (value === undefined) throw keyError(key);
  return value;
});
method(contextClass, 'get', 'expected', 1, 2, (self, [key, fallback]) => {
  return contextOf(self).values.get(checkedVariable(key)) ?? fallback ?? None;
});
method(contextClass, '__contains__', 'one', 1, 1, (self, [key]) => contextOf(self).values.has(checkedVariable(key)));
method(contextClass, '__len__', 'none', 0, 0, (self) => BigInt(contextOf(self).values.size));
method(contextClass, '__iter__', 'none', 0, 0, (self) => iterate([...contextOf(self).values.keys()]));
method(contextClass, 'keys', 'none', 0, 0, (self) => currentRuntime().listOf([...contextOf(self).values.keys()]));
method(contextClass, 'values', 'none', 0, 0, (self) => currentRuntime().listOf([...contextOf(self).values.values()]));
method(contextClass, 'items', 'none', 0, 0, (self) =>
  currentRuntime().listOf([...contextOf(self).values].map((entry) => newTuple(entry)))
);
method(contextClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyOpaque && other.cls === contextClass)) return NotImplemented;
  const [mine, theirs] = [contextOf(self).values, contextOf(other).values];
  if (mine.size !== theirs.size) return false;
  for (const [key, value] of mine) {
    const their = theirs.get(key);
    if (their === undefined || !equals(value, their)) return false;
  }
  return true;
});

function checkedVariable(key: PyValue): PyOpaque {
  if (!(key instanceof PyOpaque && key.cls === contextVarClass)) {
    throw typeError(`a ContextVar key was expected, got ${pyRepr(key)}`);
  }
  return key;
}

function iterate(items: PyValue[]): PyIterator {
  let index = 0;
  return new PyIterator(builtinClass('context_iterator'), () => (index < items.length ? items[index++] : DONE));
}

// ContextVar --------------------------------------------------------------------------------------------------------

contextVarClass.construct = (_cls, args, kwargs) => {
  for (const key of kwargs?.keys() ?? []) {
    if (key !== 'default') throw typeError(`ContextVar() got an unexpected keyword argument '${key}'`);
  }
  if (args.length !== 1) {
    throw typeError(`ContextVar() takes exactly 1 positional argument (${args.length} given)`);
  }
  const [name] = args;
  if (stringValue(name) === undefined) throw typeError('context variable name must be a str');
  return new PyOpaque(contextVarClass, stringValue(name) as string, {
    name,
    default: kwargs?.get('default'),
  } satisfies ContextVar);
};
defineProperty(contextVarClass, 'name', (self) => variableOf(self).name);
method(contextVarClass, '__repr__', 'none', 0, 0, (self) => {
  const variable = variableOf(self);
  const fallback = variable.default === undefined ? '' : ` default=${pyRepr(variable.default)}`;
  return `<ContextVar name=${pyRepr(variable.name)}${fallback} at ${addressOf(self as PyOpaque)}>`;
});
method(contextVarClass, 'get', 'expected', 0, 1, (self, [fallback]) => {
  const value = currentContext().data.values.get(self as PyOpaque) ?? fallback ?? variableOf(self).default;
  if (value === undefined) throw new PyError(newException(exceptionClassNamed('LookupError'), [self]));
  return value;
});
method(contextVarClass, 'set', 'one', 1, 1, (self, [value]) => {
  const context = currentContext();
  const variable = self as PyOpaque;
  const old = context.data.values.get(variable) ?? MISSING;
  setContextValue(context.data.values, variable, value);
  return new PyOpaque(tokenClass, 'Token', {
    context,
    variable,
    old,
    used: false,
  } satisfies Token);
});
method(contextVarClass, 'reset', 'one', 1, 1, (self, [token]) => {
  if (!(token instanceof PyOpaque && token.cls === tokenClass)) {
    throw typeError(`an instance of Token was expected, got ${pyRepr(token)}`);
  }
  resetToken(self as PyOpaque, token);
  return None;
});

function resetToken(variable: PyOpaque, token: PyOpaque): void {
  const data = tokenOf(token);
  if (data.used) throw pyError('RuntimeError', `${pyRepr(token)} has already been used once`);
  if (data.variable !== variable) {
    throw pyError('ValueError', `${pyRepr(token)} was created by a different ContextVar`);
  }
  const context = currentContext();
  if (data.context !== context) throw pyError('ValueError', `${pyRepr(token)} was created in a different Context`);
  const displaced = context.data.values.get(variable);
  if (data.old === MISSING) context.data.values.delete(variable);
  else setContextValue(context.data.values, variable, data.old);
  data.used = true;
  currentRuntime().finalizer.release([displaced]);
}

// Token -------------------------------------------------------------------------------------------------------------

tokenClass.construct = () => {
  throw pyError('RuntimeError', 'Tokens can only be created by ContextVars');
};
method(tokenClass, '__repr__', 'none', 0, 0, (self) => {
  const token = tokenOf(self);
  return `<Token${token.used ? ' used' : ''} var=${pyRepr(token.variable)} at ${addressOf(self as PyOpaque)}>`;
});
defineProperty(tokenClass, 'var', (self) => tokenOf(self).variable);
defineProperty(tokenClass, 'old_value', (self) => tokenOf(self).old);
method(tokenClass, '__enter__', 'none', 0, 0, (self) => self);
method(tokenClass, '__exit__', 'expected', 3, 3, (self) => {
  resetToken(tokenOf(self).variable, self as PyOpaque);
  return None;
});

registerModule('_contextvars', () => {
  return new Map<string, PyValue>([
    ['Context', contextClass],
    ['ContextVar', contextVarClass],
    ['Token', tokenClass],
    ['copy_context', builtin('copy_context', 'none', 0, 0, () => copyContext(currentContext().data))],
  ]);
});

registerModule('contextvars', (runtime) => {
  const cModule = runtime.importModule('_contextvars');
  const mapping = getAttribute(runtime.importModule('collections.abc'), 'Mapping');
  callValue(getAttribute(mapping, 'register'), [contextClass]);
  return new Map<string, PyValue>([
    ['Context', contextClass],
    ['ContextVar', contextVarClass],
    ['Token', tokenClass],
    ['copy_context', cModule.dict.get('copy_context') as PyValue],
    ['__all__', newTuple(['Context', 'ContextVar', 'Token', 'copy_context'])],
  ]);
});
