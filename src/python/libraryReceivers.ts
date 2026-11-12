import { getAttribute } from './objects';
import { typeName } from './types';
import { UnsupportedFeatureError } from './unsupported';
import type { PyValue } from './values';

/**
 * The receiver of a method that CPython's library writes in Python, which runs its body with any receiver: one its
 * native body cannot handle fails as the body's first read of `attribute` from it does, and one that has the attribute
 * stops the program, since the native body cannot follow what the Python body would do with it.
 */
export function libraryReceiver<T extends PyValue>(
  self: PyValue,
  isHandled: (value: PyValue) => value is T,
  attribute: string,
  method: string
): T {
  if (isHandled(self)) return self;
  getAttribute(self, attribute);
  throw unsupportedReceiver(self, method);
}

/** Stops a program that calls a method of a class written in Python with a receiver its native body cannot handle. */
export function unsupportedReceiver(self: PyValue, method: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(`${typeName(self)} 型の値を self とする ${method}() の呼び出し`);
}
