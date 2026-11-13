import { pyRepr, pyStr } from './conversions';
import { method } from './define';
import { deriveGroup, makeExceptionGroup, splitGroup } from './exceptionGroups';
import { callValue, isTruthy, toArray } from './objects';
import { currentRuntime } from './runtimeContext';
import { setTraceback } from './tracebacks';
import {
  addNote,
  argumentTypeName,
  baseExceptionClass,
  defineMethod,
  exceptionClasses,
  exceptionClassNamed,
  initExceptionFields,
  newList,
  newTuple,
  None,
  typeError,
} from './types';
import { type Kwargs, PyClass, PyInstance, PyList, PyTuple, type PyValue } from './values';

const instanceOf = (self: PyValue): PyInstance => self as PyInstance;

function rejectKeywords(cls: PyClass, kwargs: Kwargs): void {
  if (kwargs && kwargs.size > 0 && keywordOwner(cls) === undefined)
    throw typeError(`${cls.name}() takes no keyword arguments`);
}

baseExceptionClass.construct = (cls, args, kwargs) => {
  if (cls.isSubclassOf(exceptionClassNamed('BaseExceptionGroup'))) return constructGroup(cls, args, kwargs);
  const exception = new PyInstance(osErrorSubclass(cls, args));
  exception.exception = { args: newTuple(args), suppressContext: false };
  if (cls.isBuiltin) checkKeywordFields(exception.cls, kwargs);
  initExceptionFields(exception.cls, exception.exception, args, cls.isBuiltin ? kwargs : undefined);
  return exception;
};
for (const cls of exceptionClasses.values())
  if (cls !== baseExceptionClass) cls.construct ??= baseExceptionClass.construct;

defineMethod(
  baseExceptionClass,
  '__init__',
  (self, args, kwargs) => {
    const instance = instanceOf(self);
    checkKeywordFields(instance.cls, kwargs);
    const state = instance.exception;
    if (!state) return None;
    if (!state.exceptions) state.args = newTuple(args);
    initExceptionFields(instance.cls, state, args, kwargs);
    return None;
  },
  { receiver: 'wrapper' }
);

/** The keyword arguments of the builtin exceptions that take some, which set their fields. */
const EXCEPTION_KEYWORDS = new Map<string, readonly string[]>([
  ['ImportError', ['name', 'path', 'name_from']],
  ['AttributeError', ['name', 'obj']],
  ['NameError', ['name']],
]);

/** The builtin exception class whose `__init__` takes the keyword arguments of `cls`, if any. */
function keywordOwner(cls: PyClass): string | undefined {
  return cls.mro.find((each) => each.isBuiltin && EXCEPTION_KEYWORDS.has(each.name))?.name;
}

/** Validates the keyword arguments passed to an exception's constructor or `__init__`. */
function checkKeywordFields(cls: PyClass, kwargs: Kwargs): void {
  const owner = keywordOwner(cls);
  if (owner === undefined) return rejectKeywords(cls, kwargs);
  const accepted = EXCEPTION_KEYWORDS.get(owner) ?? [];
  for (const key of kwargs?.keys() ?? []) {
    if (!accepted.includes(key)) throw typeError(`${owner}() got an unexpected keyword argument '${key}'`);
  }
}

/**
 * The subclass `OSError(errno, strerror)` creates for the error numbers of macOS that one stands for, such as
 * FileNotFoundError for ENOENT.
 */
const OS_ERROR_SUBCLASSES = new Map<number, string>([
  [1, 'PermissionError'],
  [2, 'FileNotFoundError'],
  [3, 'ProcessLookupError'],
  [4, 'InterruptedError'],
  [10, 'ChildProcessError'],
  [13, 'PermissionError'],
  [17, 'FileExistsError'],
  [20, 'NotADirectoryError'],
  [21, 'IsADirectoryError'],
  [32, 'BrokenPipeError'],
  [35, 'BlockingIOError'],
  [36, 'BlockingIOError'],
  [37, 'BlockingIOError'],
  [53, 'ConnectionAbortedError'],
  [54, 'ConnectionResetError'],
  [58, 'BrokenPipeError'],
  [60, 'TimeoutError'],
  [61, 'ConnectionRefusedError'],
]);

function osErrorSubclass(cls: PyClass, args: readonly PyValue[]): PyClass {
  if (cls !== exceptionClassNamed('OSError') || args.length < 2 || args.length > 5) return cls;
  const code = args[0];
  if (typeof code !== 'bigint' && typeof code !== 'boolean') return cls;
  const name = OS_ERROR_SUBCLASSES.get(Number(code));
  return name === undefined ? cls : exceptionClassNamed(name);
}

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
  if (typeof note !== 'string') throw typeError(`add_note() argument must be str, not ${argumentTypeName(note)}`);
  addNote(instanceOf(self), note);
  return None;
});
method(baseExceptionClass, 'with_traceback', 'one', 1, 1, (self, [traceback]) => {
  const state = (self as PyInstance).exception;
  if (state) setTraceback(state, traceback);
  return self;
});

/** `str()` of an exception, as BaseException and the builtin exceptions that override it define it. */
// code-gauge-allow functionCognitiveComplexity 19 -- One case per builtin exception type that overrides __str__.
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
  if (is('OSError')) {
    const errno = state.fields?.get('errno') ?? None;
    const strerror = state.fields?.get('strerror') ?? None;
    const filename = state.fields?.get('filename') ?? None;
    const filename2 = state.fields?.get('filename2') ?? None;
    if (errno !== None && strerror !== None) {
      const message = `[Errno ${pyStr(errno)}] ${pyStr(strerror)}`;
      if (filename === None) return message;
      if (filename2 === None) return `${message}: ${pyRepr(filename)}`;
      return `${message}: ${pyRepr(filename)} -> ${pyRepr(filename2)}`;
    }
  }
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
  if (typeof message !== 'string') {
    throw typeError(`BaseExceptionGroup.__new__() argument 1 must be str, not ${argumentTypeName(message)}`);
  }
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
