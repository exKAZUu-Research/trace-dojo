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
  'replaceAll',
  'replaceFirst',
]);

/** The methods that return the pooled empty string for an empty result, as the JDK's `newString` does. */
const RETURNS_POOLED_EMPTY = new Set(['repeat', 'substring', 'trim', 'strip', 'stripLeading', 'stripTrailing']);

const BUILDER_RETURNS_POOLED_EMPTY = new Set(['substring', 'toString']);

/**
 * Gives `String` the identities the JDK's strings have: `intern()`, which returns the string the program's literals of
 * that text are, methods that return the receiver itself when their result has its text, so `s.trim() == s`, and
 * empty results that are the program's `""`, as `s.substring(s.length()) == ""`, also from `StringBuilder.substring`
 * and `toString`.
 */
export function defineStringIdentity(stringClass: ClassInfo, builderClass: ClassInfo): void {
  for (const method of builderClass.methods) {
    // JDK 25's StringBuilder.toString returns the pooled empty string, which JDK 21's did not.
    if (method.native && BUILDER_RETURNS_POOLED_EMPTY.has(method.name)) method.native = pooledWhenEmpty(method.native);
  }
  for (const method of stringClass.methods) {
    const { native } = method;
    if (!native) continue;
    // String.valueOf(Object) gives a string its own toString(), which is the string itself.
    const isValueOfObject = method.isStatic && method.name === 'valueOf' && method.parameterTypes[0]?.kind === 'class';
    if (isValueOfObject) method.native = itselfWhenString(native);
    else if (!method.isStatic && RETURNS_SELF_WHEN_UNCHANGED.has(method.name)) {
      method.native = selfWhenUnchanged(RETURNS_POOLED_EMPTY.has(method.name) ? pooledWhenEmpty(native) : native);
    }
  }
  defineIntern(stringClass);
}

function itselfWhenString(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => (args[0] instanceof JavaString ? args[0] : native(frame, receiver, args));
}

function pooledWhenEmpty(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => {
    const result = native(frame, receiver, args);
    if (!(result instanceof JavaString) || result.value !== '') return result;
    const table = frame.runtime.internedStrings;
    const empty = table.get('');
    if (empty) return empty;
    table.set('', result);
    return result;
  };
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
