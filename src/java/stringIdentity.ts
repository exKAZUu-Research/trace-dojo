import { addMethod } from './builtinSupport';
import { type ClassInfo, type NativeMethod } from './types';
import { JavaString } from './values';

/** The methods that return the string itself when they change nothing, as the JDK's do. */
const RETURNS_SELF_WHEN_UNCHANGED = new Set([
  'trim',
  'strip',
  'stripLeading',
  'stripTrailing',
  'toLowerCase',
  'toUpperCase',
  'concat',
  'repeat',
  'substring',
  'replace',
]);

/**
 * Gives `String` the identities the JDK's strings have: `intern()`, which returns the string the program's literals of
 * that text are, and methods that return the receiver itself when their result has its text, so `s.trim() == s`.
 */
export function defineStringIdentity(stringClass: ClassInfo): void {
  for (const method of stringClass.methods) {
    const { native } = method;
    if (!native) continue;
    // String.valueOf(Object) gives a string its own toString(), which is the string itself.
    const isValueOfObject = method.isStatic && method.name === 'valueOf' && method.parameterTypes[0]?.kind === 'class';
    if (isValueOfObject) method.native = itselfWhenString(native);
    else if (!method.isStatic && RETURNS_SELF_WHEN_UNCHANGED.has(method.name))
      method.native = selfWhenUnchanged(native);
  }
  defineIntern(stringClass);
}

function itselfWhenString(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => (args[0] instanceof JavaString ? args[0] : native(frame, receiver, args));
}

function selfWhenUnchanged(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => {
    const result = native(frame, receiver, args);
    const isUnchanged = result instanceof JavaString && result.value === (receiver as JavaString).value;
    return isUnchanged ? receiver : result;
  };
}

/** `String.intern()`, which reads and adds to the runtime's table of the strings the program's literals are. */
function defineIntern(stringClass: ClassInfo): void {
  addMethod(stringClass, 'intern', [], stringClass.type, false, (frame, receiver) => {
    const text = (receiver as JavaString).value;
    const table = frame.runtime.internedStrings;
    const existing = table.get(text);
    if (existing) return existing;
    table.set(text, receiver as JavaString);
    return receiver;
  });
}
