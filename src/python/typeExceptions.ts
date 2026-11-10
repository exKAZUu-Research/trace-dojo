import { pyRepr, pyStr } from './conversions';
import { method } from './define';
import { deriveGroup, makeExceptionGroup, splitGroup } from './exceptionGroups';
import { callValue, isTruthy, toArray } from './objects';
import { currentRuntime } from './runtimeContext';
import {
  baseExceptionClass,
  exceptionClasses,
  exceptionClassNamed,
  newList,
  newTuple,
  None,
  typeError,
  typeName,
} from './types';
import { type Kwargs, PyClass, PyInstance, PyList, PyTuple, type PyValue } from './values';

const instanceOf = (self: PyValue): PyInstance => self as PyInstance;

function rejectKeywords(cls: PyClass, kwargs: Kwargs): void {
  if (kwargs && kwargs.size > 0) throw typeError(`${cls.name}() takes no keyword arguments`);
}

baseExceptionClass.construct = (cls, args, kwargs) => {
  if (cls.isSubclassOf(exceptionClassNamed('BaseExceptionGroup'))) return constructGroup(cls, args, kwargs);
  if (cls.isBuiltin) rejectKeywords(cls, kwargs);
  const exception = new PyInstance(cls);
  exception.exception = { args: newTuple(args), suppressContext: false };
  return exception;
};
for (const cls of exceptionClasses.values())
  if (cls !== baseExceptionClass) cls.construct = baseExceptionClass.construct;

method(baseExceptionClass, '__init__', 'expected', 0, Number.POSITIVE_INFINITY, (self, args, kwargs) => {
  rejectKeywords(instanceOf(self).cls, kwargs);
  const state = instanceOf(self).exception;
  if (state && !state.exceptions) state.args = newTuple(args);
  return None;
});
method(baseExceptionClass, '__str__', 'none', 0, 0, (self) => exceptionStr(instanceOf(self)));
method(baseExceptionClass, '__repr__', 'none', 0, 0, (self) => {
  const exception = instanceOf(self);
  const args = exception.exception?.args.items ?? [];
  const name = exception.cls.name;
  if (exception.exception?.exceptions) {
    return `${name}(${pyRepr(exception.exception.message ?? '')}, ${pyRepr(newList([...exception.exception.exceptions.items]))})`;
  }
  return args.length === 1 ? `${name}(${pyRepr(args[0])})` : `${name}${pyRepr(newTuple(args))}`;
});
method(baseExceptionClass, 'add_note', 'one', 1, 1, (self, [note]) => {
  if (typeof note !== 'string') throw typeError(`note must be a str, not '${typeName(note)}'`);
  const state = instanceOf(self).exception;
  if (!state) return None;
  state.notes ??= newList([]);
  if (!(state.notes instanceof PyList)) throw typeError('Cannot add note: __notes__ is not a list');
  state.notes.items.push(note);
  return None;
});
method(baseExceptionClass, 'with_traceback', 'one', 1, 1, (self) => self);

/** `str()` of an exception, as BaseException and the builtin exceptions that override it define it. */
export function exceptionStr(exception: PyInstance): string {
  const state = exception.exception;
  if (!state) return '';
  if (state.exceptions) {
    const count = state.exceptions.items.length;
    return `${state.message ?? ''} (${count} sub-exception${count === 1 ? '' : 's'})`;
  }
  const args = state.args.items;
  const is = (name: string): boolean => exception.cls.mro.some((cls) => cls.isBuiltin && cls.name === name);
  if (is('KeyError') && args.length === 1) return pyRepr(args[0]);
  if (is('OSError') && args.length >= 2) return `[Errno ${pyStr(args[0])}] ${pyStr(args[1])}`;
  if (args.length === 0) return '';
  if (args.length === 1) return pyStr(args[0]);
  return pyStr(newTuple(args));
}

// Exception groups --------------------------------------------------------------------------------------------------

function constructGroup(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyInstance {
  rejectKeywords(cls, kwargs);
  if (args.length !== 2)
    throw typeError(`BaseExceptionGroup.__new__() takes exactly 2 arguments (${args.length} given)`);
  const [message, sequence] = args;
  if (typeof message !== 'string') throw typeError(`argument 1 must be str, not ${typeName(message)}`);
  if (!(sequence instanceof PyList || sequence instanceof PyTuple)) {
    throw typeError('second argument (exceptions) must be a sequence');
  }
  const exceptions = toArray(sequence);
  if (exceptions.length === 0)
    throw currentRuntime().valueErrorOf('second argument (exceptions) must be a non-empty sequence');
  for (const [index, exception] of exceptions.entries()) {
    if (!(exception instanceof PyInstance) || !exception.exception) {
      throw currentRuntime().valueErrorOf(`Item ${index} of second argument (exceptions) is not an exception`);
    }
  }
  const allExceptions = exceptions.every((exception) =>
    (exception as PyInstance).cls.isSubclassOf(exceptionClassNamed('Exception'))
  );
  let groupClass = cls;
  if (cls === exceptionClassNamed('BaseExceptionGroup') && allExceptions)
    groupClass = exceptionClassNamed('ExceptionGroup');
  if (!allExceptions && cls.isSubclassOf(exceptionClassNamed('Exception'))) {
    throw typeError(
      `Cannot nest BaseExceptions in ${cls === exceptionClassNamed('ExceptionGroup') ? 'an ExceptionGroup' : `'${cls.name}'`}`
    );
  }
  return makeExceptionGroup(groupClass, message, exceptions);
}

const groupClass = exceptionClassNamed('BaseExceptionGroup');

/** Turns a `split`/`subgroup` condition (a type, a tuple of types, or a predicate) into a test. */
function conditionOf(condition: PyValue): (exception: PyInstance) => boolean {
  if (condition instanceof PyClass) return (exception) => exception.cls.isSubclassOf(condition);
  if (condition instanceof PyTuple && condition.items.every((item) => item instanceof PyClass)) {
    return (exception) => condition.items.some((item) => exception.cls.isSubclassOf(item as PyClass));
  }
  return (exception) => isTruthy(callValue(condition, [exception]));
}

method(groupClass, 'split', 'one', 1, 1, (self, [condition]) => {
  const [match, rest] = splitGroup(instanceOf(self), conditionOf(condition));
  return newTuple([match ?? None, rest ?? None]);
});
method(
  groupClass,
  'subgroup',
  'one',
  1,
  1,
  (self, [condition]) => splitGroup(instanceOf(self), conditionOf(condition))[0] ?? None
);
method(groupClass, 'derive', 'one', 1, 1, (self, [exceptions]) =>
  deriveGroup(instanceOf(self), toArray(exceptions) as PyInstance[])
);
