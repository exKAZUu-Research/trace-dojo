import type { Collections } from './builtinCollections';
import { linkOverrides } from './builtinCollectionSupport';
import { defineLocale } from './builtinLocale';
import { type PrintWrite } from './builtinPrint';
import { standardChannelOf, stringify } from './builtins';
import {
  addAbstractMethod,
  addConstructor,
  addInterface,
  addMethod,
  defineInterface,
  newString,
  type Registry,
  requireString,
  text,
} from './builtinSupport';
import { JAVA_WHITESPACE } from './builtinWrappers';
import { formatText } from './javaFormatter';
import { translateJavaRegex, UnsupportedRegexError } from './javaRegex';
import { javaReplacer, ReplacementError } from './javaReplacement';
import { encodable, type Frame, throwBuiltin } from './runtime';
import { defineStringIdentity } from './stringIdentity';
import {
  BOOLEAN,
  CHAR,
  type ClassInfo,
  DOUBLE,
  FLOAT,
  INT,
  type JavaType,
  LONG,
  type MethodInfo,
  type NativeMethod,
  VOID,
} from './types';
import { charCodeOf, charToString, JavaArray, JavaObject, JavaString, type Value } from './values';

const LEADING_WHITESPACE = new RegExp(`^${JAVA_WHITESPACE}+`, 'u');
const TRAILING_WHITESPACE = new RegExp(`${JAVA_WHITESPACE}+$`, 'u');
const BLANK = new RegExp(`^${JAVA_WHITESPACE}*$`, 'u');
const CHAR_ARRAY: JavaType = { kind: 'array', element: CHAR };

export function defineText(
  registry: Registry,
  objectClass: ClassInfo,
  stringClass: ClassInfo,
  printStreamClass: ClassInfo,
  collections: Collections
): void {
  const objectType = objectClass.type;
  const stringType = stringClass.type;
  const objectArray: JavaType = { kind: 'array', element: objectType };
  // StringBuffer has StringBuilder's members, synchronized, which a single-threaded program cannot tell apart.
  for (const name of ['StringBuilder', 'StringBuffer']) defineStringBuilder(registry, objectClass, stringClass, name);
  defineCharSequence(registry, [
    stringClass,
    ...['StringBuilder', 'StringBuffer'].map((name) => registry.classes.get(name) as ClassInfo),
  ]);
  defineStringJoiner(registry, objectClass, stringClass.type);
  defineStringExtras(stringClass, collections);
  defineStringVariants(stringClass, objectClass);
  defineStringIdentity(
    stringClass,
    ['StringBuilder', 'StringBuffer'].map((name) => registry.classes.get(name) as ClassInfo)
  );
  const format = addMethod(
    stringClass,
    'format',
    [stringType, objectArray],
    stringType,
    true,
    (frame, _, [pattern, args]) =>
      newString(
        frame,
        formatText(frame, requireString(frame, pattern), (args as JavaArray | undefined)?.values ?? [undefined])
      )
  );
  format.isVarargs = true;
  const formatted = addMethod(stringClass, 'formatted', [objectArray], stringType, false, (frame, receiver, [args]) =>
    newString(frame, formatText(frame, text(receiver), (args as JavaArray | undefined)?.values ?? [undefined]))
  );
  formatted.isVarargs = true;
  definePrintf(printStreamClass, stringType, objectType, (frame, receiver, text) => {
    standardChannelOf(frame, receiver).write(encodable(text));
  });
  defineLocale(registry, objectClass, stringClass, printStreamClass);
}

/** Defines `printf` and `format`, which write what `String.format` returns and return the receiver. */
export function definePrintf(cls: ClassInfo, stringType: JavaType, objectType: JavaType, write: PrintWrite): void {
  for (const name of ['printf', 'format']) {
    const method = addMethod(
      cls,
      name,
      [stringType, { kind: 'array', element: objectType }],
      cls.type,
      false,
      (frame, receiver, [pattern, args]) => {
        const text = formatText(
          frame,
          requireString(frame, pattern),
          (args as JavaArray | undefined)?.values ?? [undefined]
        );
        write(frame, receiver, text, true);
        return receiver;
      }
    );
    method.isVarargs = true;
  }
}

/** What a `StringJoiner` holds: its delimiter, prefix, and suffix, the parts added, and the text when it is empty. */
interface Joiner {
  delimiter: string;
  prefix: string;
  suffix: string;
  parts: string[];
  emptyValue?: string;
}

const joiners = new WeakMap<JavaObject, Joiner>();

/** `CharSequence`, which strings and string builders implement, its `isEmpty` a default method as in the JDK. */
function defineCharSequence(registry: Registry, implementations: ClassInfo[]): void {
  const cls = defineInterface(registry, 'CharSequence', 'java.lang');
  addAbstractMethod(cls, 'length', [], INT);
  addAbstractMethod(cls, 'charAt', [INT], CHAR);
  addAbstractMethod(cls, 'subSequence', [INT, INT], cls.type);
  addMethod(
    cls,
    'isEmpty',
    [],
    BOOLEAN,
    false,
    (frame, receiver) => frame.runtime.invokeVirtual(frame, cls, 'length', receiver, []) === 0
  );
  for (const implementation of implementations) {
    const substring = implementation.methods.find(
      (method) => method.name === 'substring' && method.parameterTypes.length === 2
    ) as MethodInfo;
    addMethod(implementation, 'subSequence', [INT, INT], cls.type, false, (frame, receiver, args) =>
      (substring.native as NativeMethod)(frame, receiver, args)
    );
    addInterface(implementation, { kind: 'class', cls });
    linkOverrides(implementation);
  }
}

function joinerOf(receiver: Value): Joiner {
  return joiners.get(receiver as JavaObject) as Joiner;
}

function joined(joiner: Joiner): string {
  if (joiner.parts.length === 0 && joiner.emptyValue !== undefined) return joiner.emptyValue;
  return `${joiner.prefix}${joiner.parts.join(joiner.delimiter)}${joiner.suffix}`;
}

function defineStringJoiner(registry: Registry, objectClass: ClassInfo, stringType: JavaType): void {
  const cls = registry.define('StringJoiner', objectClass, 'java.util');
  for (const parameters of [[stringType], [stringType, stringType, stringType]]) {
    addConstructor(cls, parameters, (frame, receiver, [delimiter, prefix, suffix]) => {
      joiners.set(receiver as JavaObject, {
        delimiter: requireString(frame, delimiter),
        prefix: prefix === undefined && parameters.length === 1 ? '' : requireString(frame, prefix),
        suffix: suffix === undefined && parameters.length === 1 ? '' : requireString(frame, suffix),
        parts: [],
      });
    });
  }
  addMethod(cls, 'add', [stringType], cls.type, false, (frame, receiver, [part]) => {
    joinerOf(receiver).parts.push(part === undefined ? 'null' : text(part));
    frame.runtime.scanString(1);
    return receiver;
  });
  addMethod(cls, 'setEmptyValue', [stringType], cls.type, false, (frame, receiver, [value]) => {
    joinerOf(receiver).emptyValue = requireString(frame, value);
    return receiver;
  });
  addMethod(cls, 'length', [], INT, false, (_, receiver) => joined(joinerOf(receiver)).length);
  addMethod(cls, 'toString', [], stringType, false, (frame, receiver) => newString(frame, joined(joinerOf(receiver))));
}

function builderOf(receiver: Value): string {
  return (receiver as JavaObject).builder as string;
}

/**
 * Gives a builder new content, charging for the characters the Java operation writes or moves, `work`, rather than
 * for rebuilding the whole content, as a growing builder's append costs Java only its new characters.
 */
function setBuilder(frame: Frame, receiver: Value, value: string, work = value.length): Value {
  frame.runtime.allocateString(frame, value.length, work);
  (receiver as JavaObject).builder = value;
  return receiver;
}

function defineStringBuilder(registry: Registry, objectClass: ClassInfo, stringClass: ClassInfo, name: string): void {
  const stringType = stringClass.type;
  const cls = registry.define(name, objectClass);
  cls.isFinal = true;
  const builderType = cls.type;
  addConstructor(cls, [], (_, receiver) => {
    (receiver as JavaObject).builder = '';
  });
  addConstructor(cls, [INT], (frame, receiver, [capacity]) => {
    if ((capacity as number) < 0) throwBuiltin(frame, 'NegativeArraySizeException', String(capacity as number));
    (receiver as JavaObject).builder = '';
  });
  addConstructor(cls, [stringType], (frame, receiver, [initial]) => {
    setBuilder(frame, receiver, requireString(frame, initial));
  });
  addConstructor(stringClass, [builderType], (frame, _, [builder]) => {
    if (!(builder instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
    return newString(frame, builderOf(builder));
  });
  for (const type of [stringType, CHAR, INT, LONG, DOUBLE, FLOAT, BOOLEAN, objectClass.type, CHAR_ARRAY]) {
    addMethod(cls, 'append', [type], builderType, false, (frame, receiver, [value]) => {
      const appended = type === CHAR_ARRAY ? arrayOfChars(frame, value) : stringify(frame, value, type);
      return setBuilder(frame, receiver, builderOf(receiver) + appended, appended.length);
    });
    if (type === CHAR_ARRAY) continue;
    addMethod(cls, 'insert', [INT, type], builderType, false, (frame, receiver, [offset, value]) => {
      checkOffset(frame, offset as number, builderOf(receiver).length);
      return spliceBuilder(frame, receiver, offset as number, offset as number, stringify(frame, value, type));
    });
  }
  defineBuilderEdits(cls, stringType);
  defineBuilderQueries(cls, stringType);
}

/** The StringBuilder methods that change characters in place or add a code point. */
function defineBuilderEdits(cls: ClassInfo, stringType: JavaType): void {
  const builderType = cls.type;
  addMethod(cls, 'appendCodePoint', [INT], builderType, false, (frame, receiver, [code]) => {
    const point = code as number;
    if (point < 0 || point > 0x10_ff_ff) {
      throwBuiltin(
        frame,
        'IllegalArgumentException',
        `Not a valid Unicode code point: 0x${(point >>> 0).toString(16).toUpperCase()}`
      );
    }
    const appended = String.fromCodePoint(point);
    return setBuilder(frame, receiver, builderOf(receiver) + appended, appended.length);
  });
  addMethod(cls, 'setCharAt', [INT, CHAR], VOID, false, (frame, receiver, [index, code]) => {
    checkIndex(frame, index as number, builderOf(receiver).length);
    spliceBuilder(frame, receiver, index as number, (index as number) + 1, charToString(code as number));
  });
  addMethod(cls, 'deleteCharAt', [INT], builderType, false, (frame, receiver, [index]) => {
    checkIndex(frame, index as number, builderOf(receiver).length);
    return spliceBuilder(frame, receiver, index as number, (index as number) + 1, '');
  });
  addMethod(cls, 'delete', [INT, INT], builderType, false, (frame, receiver, [start, end]) => {
    const stop = Math.min(end as number, builderOf(receiver).length);
    checkSpan(frame, start as number, end as number, builderOf(receiver).length, (start as number) > stop);
    return spliceBuilder(frame, receiver, start as number, stop, '');
  });
  addMethod(
    cls,
    'replace',
    [INT, INT, stringType],
    builderType,
    false,
    (frame, receiver, [start, end, replacement]) => {
      const { length } = builderOf(receiver);
      checkSpan(
        frame,
        start as number,
        end as number,
        length,
        (start as number) > length || (start as number) > (end as number)
      );
      return spliceBuilder(
        frame,
        receiver,
        start as number,
        Math.min(end as number, length),
        requireString(frame, replacement)
      );
    }
  );
  addMethod(cls, 'reverse', [], builderType, false, (frame, receiver) =>
    // Reversing keeps surrogate pairs together, as StringBuilder.reverse does.
    // oxlint-disable-next-line typescript/no-misused-spread -- Splitting into code points is what keeps the pairs.
    setBuilder(frame, receiver, [...builderOf(receiver)].toReversed().join(''))
  );
  addMethod(cls, 'setLength', [INT], VOID, false, (frame, receiver, [length]) => {
    if ((length as number) < 0) {
      throwBuiltin(frame, 'StringIndexOutOfBoundsException', `String index out of range: ${length as number}`);
    }
    const current = builderOf(receiver);
    setBuilder(
      frame,
      receiver,
      current.slice(0, length as number).padEnd(length as number, '\0'),
      Math.abs((length as number) - current.length)
    );
  });
}

/** The StringBuilder methods that read its characters. */
function defineBuilderQueries(cls: ClassInfo, stringType: JavaType): void {
  addMethod(cls, 'toString', [], stringType, false, (frame, receiver) => newString(frame, builderOf(receiver)));
  addMethod(cls, 'length', [], INT, false, (_, receiver) => builderOf(receiver).length);
  addMethod(cls, 'isEmpty', [], BOOLEAN, false, (_, receiver) => builderOf(receiver).length === 0);
  addMethod(cls, 'compareTo', [cls.type], INT, false, (frame, receiver, [other]) => {
    if (!(other instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
    const [left, right] = [builderOf(receiver), builderOf(other)];
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return charCodeOf(left, index) - charCodeOf(right, index);
    }
    return left.length - right.length;
  });
  addMethod(cls, 'charAt', [INT], CHAR, false, (frame, receiver, [index]) => {
    checkIndex(frame, index as number, builderOf(receiver).length);
    return charCodeOf(builderOf(receiver), index as number);
  });
  addMethod(cls, 'indexOf', [stringType], INT, false, (frame, receiver, [pattern]) =>
    builderOf(receiver).indexOf(requireString(frame, pattern))
  );
  addMethod(cls, 'lastIndexOf', [stringType], INT, false, (frame, receiver, [pattern]) =>
    builderOf(receiver).lastIndexOf(requireString(frame, pattern))
  );
  for (const parameterTypes of [[INT], [INT, INT]]) {
    addMethod(cls, 'substring', parameterTypes, stringType, false, (frame, receiver, [begin, end]) => {
      const current = builderOf(receiver);
      const stop = end === undefined ? current.length : (end as number);
      checkRange(frame, begin as number, stop, current.length);
      return newString(frame, current.slice(begin as number, stop));
    });
  }
}

/** Replaces the characters from `start` to `end` with `inserted`. */
function spliceBuilder(frame: Frame, receiver: Value, start: number, end: number, inserted: string): Value {
  const current = builderOf(receiver);
  // Characters after the span move unless the replacement keeps the length.
  const moved = inserted.length === end - start ? 0 : current.length - end;
  return setBuilder(frame, receiver, current.slice(0, start) + inserted + current.slice(end), inserted.length + moved);
}

function checkSpan(frame: Frame, start: number, end: number, length: number, isInvalid: boolean): void {
  if (start < 0 || isInvalid)
    throwBuiltin(
      frame,
      'StringIndexOutOfBoundsException',
      `Range [${start}, ${Math.min(end, length)}) out of bounds for length ${length}`
    );
}

/** The `count` characters of a char array from `offset`, as `new String(chars, offset, count)` takes them. */
export function charsInRange(frame: Frame, chars: Value, offset: number, count: number): string {
  if (!(chars instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
  if (offset < 0 || count < 0 || offset + count > chars.values.length) {
    throwBuiltin(
      frame,
      'StringIndexOutOfBoundsException',
      `offset ${offset}, count ${count}, length ${chars.values.length}`
    );
  }
  return chars.values
    .slice(offset, offset + count)
    .map((code) => charToString(code as number))
    .join('');
}

function arrayOfChars(frame: Frame, value: Value): string {
  if (!(value instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
  return value.values.map((code) => charToString(code as number)).join('');
}

// code-gauge-allow functionNcss 47 -- One registration per String method, each charging the characters it reads.
function defineStringExtras(stringClass: ClassInfo, collections: Collections): void {
  const stringType = stringClass.type;
  const stringArray: JavaType = { kind: 'array', element: stringType };
  addMethod(stringClass, 'split', [stringType], stringArray, false, (frame, receiver, [regex]) =>
    splitText(frame, text(receiver), requireString(frame, regex), 0)
  );
  addMethod(stringClass, 'split', [stringType, INT], stringArray, false, (frame, receiver, [regex, limit]) =>
    splitText(frame, text(receiver), requireString(frame, regex), limit as number)
  );
  const join = addMethod(
    stringClass,
    'join',
    [stringType, stringArray],
    stringType,
    true,
    (frame, _, [delimiter, parts]) => joinText(frame, requireString(frame, delimiter), (parts as JavaArray).values)
  );
  join.isVarargs = true;
  addMethod(
    stringClass,
    'join',
    [
      stringType,
      {
        kind: 'class',
        cls: collections.iterableClass,
        args: [{ kind: 'wildcard', bound: stringType, isSuper: false }],
      },
    ],
    stringType,
    true,
    (frame, _, [delimiter, parts]) => {
      if (!(parts instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
      const items = parts.elements ?? parts.store?.ordered().map((entry) => entry.key) ?? [];
      return joinText(frame, requireString(frame, delimiter), items);
    }
  );
  addMethod(stringClass, 'replace', [CHAR, CHAR], stringType, false, (frame, receiver, [from, to]) =>
    newString(frame, text(receiver).replaceAll(charToString(from as number), charToString(to as number)))
  );
  addMethod(stringClass, 'replace', [stringType, stringType], stringType, false, (frame, receiver, [from, to]) => {
    frame.runtime.scanString(text(receiver).length);
    return newString(
      frame,
      text(receiver).replaceAll(requireString(frame, from), () => requireString(frame, to))
    );
  });
  addMethod(
    stringClass,
    'replaceAll',
    [stringType, stringType],
    stringType,
    false,
    (frame, receiver, [regex, replacement]) => {
      frame.runtime.scanString(text(receiver).length);
      const pattern = compileRegex(frame, requireString(frame, regex), 'g');
      return replaceMatches(frame, receiver, pattern, requireString(frame, replacement));
    }
  );
  addMethod(stringClass, 'matches', [stringType], BOOLEAN, false, (frame, receiver, [regex]) => {
    frame.runtime.scanString(text(receiver).length);
    return compileRegex(frame, requireString(frame, regex), '', true).test(text(receiver));
  });
  addMethod(stringClass, 'lastIndexOf', [stringType], INT, false, (frame, receiver, [pattern]) => {
    frame.runtime.scanString(text(receiver).length);
    return text(receiver).lastIndexOf(requireString(frame, pattern));
  });
  addMethod(stringClass, 'lastIndexOf', [INT], INT, false, (frame, receiver, [code]) => {
    frame.runtime.scanString(text(receiver).length);
    return (code as number) < 0 || (code as number) > 0x10_ff_ff
      ? -1
      : text(receiver).lastIndexOf(String.fromCodePoint(code as number));
  });
  addMethod(stringClass, 'indexOf', [stringType, INT], INT, false, (frame, receiver, [pattern, from]) => {
    frame.runtime.scanString(text(receiver).length);
    return text(receiver).indexOf(requireString(frame, pattern), Math.max(from as number, 0));
  });
  addMethod(stringClass, 'indexOf', [INT, INT], INT, false, (frame, receiver, [code, from]) => {
    frame.runtime.scanString(text(receiver).length);
    if ((code as number) < 0 || (code as number) > 0x10_ff_ff) return -1;
    return text(receiver).indexOf(String.fromCodePoint(code as number), Math.max(from as number, 0));
  });
  addMethod(stringClass, 'strip', [], stringType, false, (frame, receiver) =>
    newString(frame, text(receiver).replace(LEADING_WHITESPACE, '').replace(TRAILING_WHITESPACE, ''))
  );
  addMethod(stringClass, 'isBlank', [], BOOLEAN, false, (_, receiver) => BLANK.test(text(receiver)));
  addMethod(stringClass, 'compareToIgnoreCase', [stringType], INT, false, (frame, receiver, [other]) =>
    compareIgnoringCase(text(receiver), requireString(frame, other))
  );
  addMethod(stringClass, 'valueOf', [CHAR_ARRAY], stringType, true, (frame, _, [chars]) =>
    newString(frame, arrayOfChars(frame, chars))
  );
  addMethod(stringClass, 'valueOf', [CHAR_ARRAY, INT, INT], stringType, true, (frame, _, [chars, offset, count]) =>
    newString(frame, charsInRange(frame, chars, offset as number, count as number))
  );
}

/** Variants of the common String methods: one-sided stripping, first-match replacement, and code points. */
function defineStringVariants(stringClass: ClassInfo, objectClass: ClassInfo): void {
  const stringType = stringClass.type;
  addMethod(stringClass, 'stripLeading', [], stringType, false, (frame, receiver) =>
    newString(frame, text(receiver).replace(LEADING_WHITESPACE, ''))
  );
  addMethod(stringClass, 'stripTrailing', [], stringType, false, (frame, receiver) =>
    newString(frame, text(receiver).replace(TRAILING_WHITESPACE, ''))
  );
  addMethod(stringClass, 'codePointCount', [INT, INT], INT, false, (frame, receiver, [begin, end]) => {
    checkRange(frame, begin as number, end as number, text(receiver).length);
    const range = text(receiver).slice(begin as number, end as number);
    let count = 0;
    // A surrogate pair, which a code point above U+FFFF takes, counts once.
    for (let index = 0; index < range.length; index += (range.codePointAt(index) as number) > 0xff_ff ? 2 : 1) count++;
    return count;
  });
  addMethod(stringClass, 'codePointAt', [INT], INT, false, (frame, receiver, [index]) => {
    checkIndex(frame, index as number, text(receiver).length);
    return text(receiver).codePointAt(index as number) as number;
  });
  addMethod(
    stringClass,
    'replaceFirst',
    [stringType, stringType],
    stringType,
    false,
    (frame, receiver, [regex, replacement]) => {
      frame.runtime.scanString(text(receiver).length);
      const pattern = compileRegex(frame, requireString(frame, regex), '');
      return replaceMatches(frame, receiver, pattern, requireString(frame, replacement));
    }
  );
  // `contentEquals` takes a CharSequence, which these programs pass as a String or a StringBuilder.
  addMethod(stringClass, 'contentEquals', [objectClass.type], BOOLEAN, false, (frame, receiver, [other]) => {
    if (other instanceof JavaString) return other.value === text(receiver);
    if (other instanceof JavaObject && other.builder !== undefined) return builderOf(other) === text(receiver);
    return throwBuiltin(frame, 'NullPointerException');
  });
  for (const searched of [stringType, INT]) {
    addMethod(stringClass, 'lastIndexOf', [searched, INT], INT, false, (frame, receiver, [target, from]) =>
      lastIndexFrom(frame, text(receiver), searched === INT ? target : requireString(frame, target), from as number)
    );
  }
  addMethod(stringClass, 'startsWith', [stringType, INT], BOOLEAN, false, (frame, receiver, [prefix, offset]) => {
    const start = offset as number;
    return start >= 0 && text(receiver).startsWith(requireString(frame, prefix), start);
  });
  addMethod(stringClass, 'copyValueOf', [CHAR_ARRAY], stringType, true, (frame, _, [chars]) =>
    newString(frame, arrayOfChars(frame, chars))
  );
}

/** `lastIndexOf` searching back from `from` for a string or, given a number, a code point. */
function lastIndexFrom(frame: Frame, value: string, target: Value | string, from: number): number {
  frame.runtime.scanString(value.length);
  if (typeof target === 'number' && (target < 0 || target > 0x10_ff_ff)) return -1;
  const needle = typeof target === 'number' ? String.fromCodePoint(target) : (target as string);
  return from < 0 ? -1 : value.lastIndexOf(needle, from);
}

/** @param isWhole Whether the expression must match the whole input, as `String.matches` requires. */
function compileRegex(frame: Frame, pattern: string, flags: string, isWhole = false): RegExp {
  try {
    const translated = translateJavaRegex(pattern, isWhole);
    return new RegExp(translated.source, translated.flags + flags);
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof UnsupportedRegexError)) throw error;
    const reason = error instanceof UnsupportedRegexError ? error.message : 'Invalid regular expression';
    return throwBuiltin(frame, 'PatternSyntaxException', `${reason}\n${pattern}`);
  }
}

/** Splits as `String.split` does: trailing empty strings go when `limit` is 0, and at most `limit` parts remain when positive. */
function splitText(frame: Frame, value: string, regex: string, limit: number): JavaArray {
  frame.runtime.scanString(value.length);
  const pattern = compileRegex(frame, regex, 'g');
  const parts: string[] = [];
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    if (limit > 0 && parts.length === limit - 1) break;
    const index = match.index;
    // A zero-width match at the start produces no leading empty string.
    if (match[0].length === 0 && (index === 0 || index >= value.length)) continue;
    parts.push(value.slice(start, index));
    start = index + match[0].length;
  }
  parts.push(value.slice(start));
  if (limit === 0) while (parts.length > 1 && parts.at(-1) === '') parts.pop();
  if (limit === 0 && parts.length === 1 && parts[0] === '' && value.length > 0) parts.pop();
  frame.runtime.allocateArray(frame, parts.length);
  return new JavaArray(
    frame.runtime.builtins.stringClass.type,
    parts.map((part) => new JavaString(part))
  );
}

function joinText(frame: Frame, delimiter: string, parts: Value[]): JavaString {
  const texts = parts.map((part) => (part instanceof JavaString ? part.value : 'null'));
  return newString(frame, texts.join(delimiter));
}

function checkIndex(frame: Frame, index: number, length: number): void {
  if (index < 0 || index >= length) {
    throwBuiltin(frame, 'StringIndexOutOfBoundsException', `Index ${index} out of bounds for length ${length}`);
  }
}

function checkOffset(frame: Frame, offset: number, length: number): void {
  if (offset < 0 || offset > length)
    throwBuiltin(
      frame,
      'StringIndexOutOfBoundsException',
      `Range [${offset}, ${length}) out of bounds for length ${length}`
    );
}

function checkRange(frame: Frame, begin: number, end: number, length: number): void {
  if (begin < 0 || end > length || begin > end) {
    throwBuiltin(
      frame,
      'StringIndexOutOfBoundsException',
      `Range [${begin}, ${end}) out of bounds for length ${length}`
    );
  }
}

/** The string with the pattern's matches replaced, which is the receiver itself when nothing matches, as in the JDK. */
function replaceMatches(frame: Frame, receiver: Value, pattern: RegExp, replacement: string): Value {
  const found = pattern.test(text(receiver));
  pattern.lastIndex = 0;
  if (!found) return receiver;
  return newString(frame, replaceWith(frame, text(receiver), pattern, replacement));
}

export function compareIgnoringCase(a: string, b: string): number {
  const left = a.toUpperCase().toLowerCase();
  const right = b.toUpperCase().toLowerCase();
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return charCodeOf(left, index) - charCodeOf(right, index);
  }
  return left.length - right.length;
}

/** `replaceAll` and `replaceFirst`, which report an invalid replacement as Java's Matcher does. */
function replaceWith(frame: Frame, value: string, pattern: RegExp, replacement: string): string {
  try {
    return value.replace(pattern, javaReplacer(replacement));
  } catch (error) {
    if (!(error instanceof ReplacementError)) throw error;
    return throwBuiltin(frame, error.exception, error.message);
  }
}
