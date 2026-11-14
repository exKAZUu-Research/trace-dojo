import { pyRepr } from './conversions';
import { builtin } from './define';
import { describeException } from './describe';
import { callValue, getAttribute } from './objects';
import { currentRuntime } from './runtimeContext';
import { None, tupleClass } from './types';
import { type PyClass, PyError, type PyInstance, PyTuple, type PyValue } from './values';

/** The type of what CPython passes `sys.unraisablehook`, a struct sequence, which the `sys` module defines. */
let hookArgsClass: PyClass | undefined;

export function setUnraisableHookArgsClass(cls: PyClass): void {
  hookArgsClass = cls;
}

export function reportUnraisable(error: PyError, message: string, object?: PyValue): void {
  const hook = currentRuntime().importModule('sys').dict.get('unraisablehook') ?? defaultUnraisableHook;
  const exception = error.exception;
  try {
    const args = new PyTuple(hookArgsClass ?? tupleClass, [
      exception.cls,
      exception,
      exception.exception?.traceback ?? None,
      object === undefined ? message : `${message} ${pyRepr(object)}`,
      None,
    ]);
    callValue(hook, [args]);
  } catch (error_) {
    // CPython reports a hook that fails on stderr too, and goes on.
    if (!(error_ instanceof PyError)) throw error_;
  }
}

/** `sys.unraisablehook`'s default, which writes the message and the exception to stderr. */
export const defaultUnraisableHook = builtin('unraisablehook', 'one', 1, 1, ([args]) => {
  const [, value, , message] = (args as PyTuple).items;
  const stderr = currentRuntime().standardStream('stderr');
  const text = `${typeof message === 'string' ? message : ''}:\n${describeException(value as PyInstance)}\n`;
  callValue(getAttribute(stderr, 'write'), [text]);
  return None;
});
