import { addMethod } from './builtinSupport';
import { type ClassInfo, type NativeMethod } from './types';
import { JavaArray, JavaString, type Value } from './values';

/** Whether a method returns the receiver itself, given the receiver's text, the arguments, and the result's text. */
type ReturnsSelf = (receiver: string, args: readonly Value[], result: string) => boolean;

/** These only remove or map characters, so the JDK's returns the receiver exactly when the text is unchanged. */
const unchanged: ReturnsSelf = (receiver, _, result) => result === receiver;

/**
 * The methods that may return the string itself, with the JDK's rule for when they do; any empty result they return
 * otherwise is the pooled `""`. `replaceAll` and `replaceFirst` return the receiver themselves when the pattern finds
 * no match, which only the regex can tell.
 */
const RETURNS_SELF = new Map<string, ReturnsSelf>([
  ['trim', unchanged],
  ['strip', unchanged],
  ['stripLeading', unchanged],
  ['stripTrailing', unchanged],
  ['toLowerCase', unchanged],
  ['toUpperCase', unchanged],
  ['concat', unchanged],
  ['substring', unchanged],
  ['repeat', (_, [count]) => count === 1],
  ['replace', (receiver, [from, to]) => replacesNothing(receiver, from, to)],
  ['replaceAll', () => false],
  ['replaceFirst', () => false],
]);

const BUILDER_RETURNS_POOLED_EMPTY = new Set(['substring', 'toString']);

/**
 * Gives `String` the identities the JDK's strings have: `intern()`, which returns the string the program's literals of
 * that text are, methods that return the receiver itself, so `s.trim() == s`, a split without a match, which returns
 * the receiver as its only part, and empty results that are the program's `""`, as `s.substring(s.length()) == ""`,
 * also from `StringBuilder.substring` and `toString`.
 */
export function defineStringIdentity(stringClass: ClassInfo, builderClass: ClassInfo): void {
  for (const method of builderClass.methods) {
    // JDK 25's StringBuilder.toString returns the pooled empty string, which JDK 21's did not.
    if (method.native && BUILDER_RETURNS_POOLED_EMPTY.has(method.name)) method.native = pooledWhenEmpty(method.native);
  }
  for (const method of stringClass.methods) {
    const { native } = method;
    if (!native) continue;
    const returnsSelf = RETURNS_SELF.get(method.name);
    // String.valueOf(Object) gives a string its own toString(), which is the string itself.
    const isValueOfObject = method.isStatic && method.name === 'valueOf' && method.parameterTypes[0]?.kind === 'class';
    if (isValueOfObject) method.native = itselfWhenString(native);
    else if (method.isStatic) continue;
    else if (returnsSelf) method.native = selfOrPooledEmpty(native, returnsSelf);
    else if (method.name === 'split') method.native = selfAsWholePart(native);
  }
  defineIntern(stringClass);
}

/**
 * Whether `replace` finds nothing to change, as the JDK's decides: a one-character target and replacement compare as
 * characters, so `s.replace("b", "b") == s`, and an empty target always matches.
 */
function replacesNothing(receiver: string, from: Value, to: Value): boolean {
  if (typeof from === 'number') return from === to || !receiver.includes(String.fromCodePoint(from));
  if (!(from instanceof JavaString) || !(to instanceof JavaString) || from.value === '') return false;
  if (from.value.length === 1 && to.value.length === 1 && from.value === to.value) return true;
  return !receiver.includes(from.value);
}

function itselfWhenString(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => (args[0] instanceof JavaString ? args[0] : native(frame, receiver, args));
}

function selfOrPooledEmpty(native: NativeMethod, returnsSelf: ReturnsSelf): NativeMethod {
  const pooled = pooledWhenEmpty(native);
  return (frame, receiver, args) => {
    const result = pooled(frame, receiver, args);
    if (!(result instanceof JavaString) || result === receiver) return result;
    return returnsSelf((receiver as JavaString).value, args, result.value) ? receiver : result;
  };
}

/** A split's part that is the whole string is the receiver, as Pattern.split returns it without a match. */
function selfAsWholePart(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => {
    const result = native(frame, receiver, args);
    if (!(result instanceof JavaArray) || result.values.length !== 1) return result;
    const [part] = result.values;
    if (part instanceof JavaString && part.value === (receiver as JavaString).value) result.values[0] = receiver;
    return result;
  };
}

function pooledWhenEmpty(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => {
    const result = native(frame, receiver, args);
    if (!(result instanceof JavaString) || result.value !== '' || result === receiver) return result;
    const table = frame.runtime.internedStrings;
    const empty = table.get('');
    if (empty) return empty;
    table.set('', result);
    return result;
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
