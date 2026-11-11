// `contextvars`, whose classes CPython defines in C as `_contextvars`.
import { addressOf, pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { keyError } from '../items';
import { registerModule } from '../modules';
import { callValue, getAttribute } from '../objects';
import { equals } from '../operators';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  defineMethod,
  exceptionClassNamed,
  newException,
  newTuple,
  None,
  NotImplemented,
  pyError,
  typeError,
} from '../types';
import { DONE, PyError, PyIterator, PyOpaque, type PyValue } from '../values';
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
  /** The context that was current before `run` entered this one, or undefined while it is not entered. */
  previous?: ContextObject;
}

interface ContextVar {
  name: string;
  default?: PyValue;
}

interface Token {
  context: ContextObject;
  variable: PyOpaque;
  old: PyValue;
  used: boolean;
}

type ContextObject = PyOpaque & { data: Context };

const currentContexts = new WeakMap<Runtime, ContextObject>();

function currentContext(): ContextObject {
  const runtime = currentRuntime();
  let context = currentContexts.get(runtime);
  if (context === undefined) {
    context = newContext(new Map());
    currentContexts.set(runtime, context);
  }
  return context;
}

function newContext(values: Map<PyOpaque, PyValue>): ContextObject {
  return new PyOpaque(contextClass, 'Context', {
    values,
  } satisfies Context) as ContextObject;
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

defineMethod(contextClass, 'run', (self, args, kwargs) => {
  if (args.length === 0) throw typeError('run() missing 1 required positional argument');
  const context = self as ContextObject;
  if (context.data.previous !== undefined) {
    throw pyError('RuntimeError', `cannot enter context: ${pyRepr(context)} is already entered`);
  }
  const runtime = currentRuntime();
  context.data.previous = currentContext();
  currentContexts.set(runtime, context);
  try {
    return callValue(args[0], args.slice(1), kwargs);
  } finally {
    currentContexts.set(runtime, context.data.previous);
    context.data.previous = undefined;
  }
});
method(contextClass, 'copy', 'none', 0, 0, (self) => newContext(new Map(contextOf(self).values)));
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
  if (typeof name !== 'string') throw typeError('context variable name must be a str');
  return new PyOpaque(contextVarClass, name, {
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
  context.data.values.set(variable, value);
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
  data.used = true;
  if (data.old === MISSING) context.data.values.delete(variable);
  else context.data.values.set(variable, data.old);
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

registerModule('contextvars', (runtime) => {
  const mapping = getAttribute(runtime.importModule('collections.abc'), 'Mapping');
  callValue(getAttribute(mapping, 'register'), [contextClass]);
  return new Map<string, PyValue>([
    ['Context', contextClass],
    ['ContextVar', contextVarClass],
    ['Token', tokenClass],
    ['copy_context', builtin('copy_context', 'none', 0, 0, () => newContext(new Map(currentContext().data.values)))],
    ['__all__', newTuple(['Context', 'ContextVar', 'Token', 'copy_context'])],
  ]);
});
