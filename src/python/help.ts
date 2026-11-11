import { getDoc } from './modules/inspect';
import { formatSignatureWithin, signature } from './modules/inspectSignature';
import { callValue } from './objects';
import { currentRuntime } from './runtimeContext';
import { classOf, None, typeError } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { type Kwargs, PyBoundMethod, PyClass, PyFunction, type PyValue } from './values';

/**
 * `help(obj)` of a function or method written in Python, which prints what pydoc's text renderer does. The help of
 * other objects shows CPython's docstrings and pydoc's layout of classes and modules, which this grader does not have.
 */
export function help(args: PyValue[], kwargs?: Kwargs): PyValue {
  for (const key of kwargs?.keys() ?? []) {
    if (key !== 'request') throw typeError(`Helper.__call__() got an unexpected keyword argument '${key}'`);
  }
  if (kwargs?.has('request') && args.length > 0) {
    throw typeError("Helper.__call__() got multiple values for argument 'request'");
  }
  const all = kwargs?.has('request') ? [kwargs.get('request') as PyValue] : args;
  if (all.length > 1) {
    throw typeError(`Helper.__call__() takes from 1 to 2 positional arguments but ${all.length + 1} were given`);
  }
  if (all.length === 0) throw new UnsupportedFeatureError('対話型のヘルプ（引数のない help()）');
  args = all;
  const [value] = args;
  const fn = value instanceof PyBoundMethod ? value.fn : value;
  if (!(fn instanceof PyFunction)) {
    throw new UnsupportedFeatureError('help() で表示する、組み込みのオブジェクトやクラスやモジュールの説明');
  }
  const runtime = currentRuntime();
  // The standard library's code here leaves out some of CPython's docstrings, so its functions without one may differ.
  if (runtime.libraryNamespaces.has(fn.globals) && typeof getDoc(value) !== 'string') {
    throw new UnsupportedFeatureError('help() で表示する、説明文のない標準ライブラリの関数の説明');
  }
  const kind = value instanceof PyBoundMethod ? 'method' : 'function';
  // As `inspect.getmodule` finds it: the module of the function's `__module__`, if one of that name is loaded.
  const loaded = typeof fn.module === 'string' && (fn.module === '__main__' || runtime.modules.has(fn.module));
  const module = loaded ? ` in module ${fn.module as string}` : '';
  const text = `Help on ${kind} ${fn.name}${module}:\n\n${documentRoutine(value, fn)}\n`;
  runtime.buildString(text.length);
  callValue(runtime.builtins.get('print') as PyValue, [text], new Map([['end', '']]));
  return None;
}

/** `pydoc.TextDoc.docroutine`: the declaration of a function, then its docstring indented. */
function documentRoutine(value: PyValue, fn: PyFunction): string {
  let note = '';
  if (value instanceof PyBoundMethod) {
    const { self } = value;
    note =
      self instanceof PyClass
        ? ` class method of ${className(self)}`
        : ` method of ${className(classOf(self))} instance`;
  }
  // pydoc puts the parameters on lines of their own when the declaration would pass 80 columns.
  const argspec = formatSignatureWithin(signature(value), fn.name === '<lambda>' ? undefined : 80 - fn.name.length);
  // pydoc writes `async ` before the name of a coroutine function or an async generator function.
  const qualifier = fn.def.scope.isAsync === true ? 'async ' : '';
  const declaration =
    fn.name === '<lambda>'
      ? `<lambda> lambda ${argspec.slice(1, -1)}${note}`
      : `${qualifier}${fn.name}${argspec}${note}`;
  const doc = getDoc(value);
  const body = typeof doc === 'string' && doc !== '' ? `${indent(doc)}\n` : '';
  return `${declaration}\n${body}`;
}

/** `pydoc.classname` with no module of the document, which qualifies every class with its module. */
function className(cls: PyClass): string {
  return `${cls.module}.${cls.name}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`.trimEnd())
    .join('\n');
}
