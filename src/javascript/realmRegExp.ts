import { ArrayOps } from './arrayOps';
import { DONE } from './iteration';
import type { RealmBuilder } from './realm';
import { defineHostIteratorPrototype, newHostIterator, WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  isAccessor,
  isCallable,
  isObject,
  type JsArray,
  type JsFunction,
  JsObject,
  type NativeCall,
  throwingHostErrors,
  type Value,
} from './values';

const FLAG_GETTERS = [
  ['hasIndices', 'd'],
  ['global', 'g'],
  ['ignoreCase', 'i'],
  ['multiline', 'm'],
  ['dotAll', 's'],
  ['unicode', 'u'],
  ['unicodeSets', 'v'],
  ['sticky', 'y'],
] as const;

export function defineRegExpBuiltins(builder: RealmBuilder): void {
  const { regExpPrototype } = builder.realm;
  const constructor = builder.defineClass('RegExp', 2, regExpPrototype, ({ runtime, args, newTarget }) => {
    const [pattern, flags] = args;
    const regexp = pattern instanceof JsObject ? pattern.regexp : undefined;
    if (regexp && !newTarget && flags === undefined && runtime.get(pattern, 'constructor') === constructor)
      return pattern;
    const source = regexp ? regexp.source : pattern === undefined ? '' : runtime.toString(pattern);
    const flagText = flags === undefined ? (regexp?.flags ?? '') : runtime.toString(flags);
    const object = newRegExp(runtime, source, flagText);
    object.setPrototype(runtime.prototypeFor(newTarget, regExpPrototype));
    return object;
  });
  builder.method(constructor, 'escape', 1, ({ runtime, args }) => {
    const [text] = args;
    if (typeof text !== 'string') return runtime.throwError('TypeError', 'input argument must be a string');
    runtime.scan(text.length);
    const escaped = RegExp.escape(text);
    runtime.buildString(escaped.length);
    return escaped;
  });
  builder.realm.regExpConstructor = constructor;
  builder.getter(constructor, WELL_KNOWN_SYMBOLS.species, ({ thisValue }) => thisValue);
  defineRegExpPrototype(builder);
  defineStringMethods(builder);
}

/** Creates a regular expression object, throwing JavaScript's SyntaxError for an invalid pattern or flags. */
export function newRegExp(runtime: Runtime, source: string, flags: string): JsObject {
  const regexp = throwingHostErrors(runtime, () => new RegExp(source, flags));
  const object = runtime.newObject(runtime.realm.regExpPrototype);
  object.regexp = regexp;
  runtime.defineProperty(object, 'lastIndex', {
    value: 0,
    writable: true,
    enumerable: false,
    configurable: false,
  });
  return object;
}

function defineRegExpPrototype(builder: RealmBuilder): void {
  const { regExpPrototype } = builder.realm;
  builder.realm.regExpExec = builder.method(regExpPrototype, 'exec', 1, ({ runtime, thisValue, args }) => {
    const object = thisRegExp(runtime, thisValue, 'exec');
    return exec(runtime, object, runtime.toString(args[0]));
  });
  builder.method(regExpPrototype, 'test', 1, ({ runtime, thisValue, args }) => {
    if (!isObject(thisValue))
      return runtime.throwError(
        'TypeError',
        () => `Method RegExp.prototype.test called on incompatible receiver ${runtime.describePlain(thisValue)}`
      );
    return regExpExec(runtime, thisValue, runtime.toString(args[0])) !== null;
  });
  builder.method(regExpPrototype, 'toString', 0, ({ runtime, thisValue }) => {
    return regExpToString(runtime, runtime.toObject(thisValue));
  });
  builder.getter(regExpPrototype, 'source', ({ runtime, thisValue }) =>
    thisValue === regExpPrototype ? '(?:)' : thisRegExp(runtime, thisValue, 'source', true).regexp.source
  );
  builder.getter(regExpPrototype, 'flags', ({ runtime, thisValue }) => {
    if (!isObject(thisValue)) {
      runtime.throwError(
        'TypeError',
        `RegExp.prototype.flags getter called on non-object ${runtime.describePlain(thisValue)}`
      );
    }
    const object = thisValue;
    return FLAG_GETTERS.filter(([name]) => runtime.get(object, name))
      .map(([, flag]) => flag)
      .join('');
  });
  for (const [name, flag] of FLAG_GETTERS) {
    builder.getter(regExpPrototype, name, ({ runtime, thisValue }) => {
      if (thisValue === regExpPrototype) return;
      return thisRegExp(runtime, thisValue, name, true).regexp.flags.includes(flag);
    });
  }
}

export type RegExpObject = JsObject & { regexp: RegExp };

export function regExpToString(runtime: Runtime, object: JsObject): string {
  return `/${runtime.toString(runtime.get(object, 'source'))}/${runtime.toString(runtime.get(object, 'flags'))}`;
}

function thisRegExp(runtime: Runtime, value: Value, name: string, isGetter = false): RegExpObject {
  if (value instanceof JsObject && value.regexp) return value as RegExpObject;
  return runtime.throwError('TypeError', () =>
    isGetter
      ? `RegExp.prototype.${name} getter called on non-RegExp object`
      : `Method RegExp.prototype.${name} called on incompatible receiver ${runtime.describePlain(value)}`
  );
}

/**
 * Runs `run` on a host copy of the expression that starts at the object's `lastIndex`, which a global or sticky
 * expression then updates to where the host left it.
 */
function withHostRegExp<T>(runtime: Runtime, object: RegExpObject, run: (regexp: RegExp) => T): T {
  const regexp = new RegExp(object.regexp.source, object.regexp.flags);
  const lastIndex = runtime.toNumber(runtime.get(object, 'lastIndex'));
  regexp.lastIndex = Number.isNaN(lastIndex) ? 0 : Math.max(0, Math.trunc(lastIndex));
  const result = run(regexp);
  if (regexp.global || regexp.sticky) runtime.set(object, 'lastIndex', regexp.lastIndex);
  return result;
}

function exec(runtime: Runtime, object: RegExpObject, text: string, prescanned = false): JsObject | null {
  if (!prescanned) runtime.scan(text.length);
  const match = withHostRegExp(runtime, object, (regexp) => regexp.exec(text));
  // oxlint-disable-next-line unicorn/no-null -- exec returns null when nothing matches, as in JavaScript.
  return match ? matchArray(runtime, match) : null;
}

function regExpExec(runtime: Runtime, object: JsObject, text: string, prescanned = false): JsObject | null {
  const method = runtime.get(object, 'exec');
  if (isCallable(method) && method !== runtime.realm.regExpExec) {
    const result = runtime.call(method, object, [text], runtime.currentRow);
    if (result === null || isObject(result)) return result;
    return runtime.throwError('TypeError', 'RegExp exec method returned something other than an Object or null');
  }
  return exec(runtime, thisRegExp(runtime, object, 'exec'), text, prescanned);
}

/** Converts the host's match to JavaScript's: an array with `index`, `input`, `groups`, and `indices` for `d`. */
function matchArray(runtime: Runtime, match: RegExpExecArray): JsObject {
  const array = runtime.newArray([...match]);
  runtime.createDataProperty(array, 'index', match.index);
  runtime.createDataProperty(array, 'input', match.input);
  runtime.createDataProperty(array, 'groups', groupsObject(runtime, match.groups));
  if (match.indices) {
    // A named group's pair is the same array as its numbered one, as the host's pairs are.
    const pairs = new Map<[number, number], JsObject>();
    const pairOf = (pair: [number, number] | undefined): JsObject | undefined => {
      if (!pair) return undefined;
      let converted = pairs.get(pair);
      if (!converted) {
        converted = runtime.newArray([pair[0], pair[1]]);
        pairs.set(pair, converted);
      }
      return converted;
    };
    const indices = runtime.newArray(match.indices.map((pair) => pairOf(pair)));
    const { groups } = match.indices;
    runtime.createDataProperty(
      indices,
      'groups',
      groupsObject(
        runtime,
        groups && Object.fromEntries(Object.entries(groups).map(([name, pair]) => [name, pairOf(pair)]))
      )
    );
    runtime.createDataProperty(array, 'indices', indices);
  }
  return array;
}

/** The `groups` of a match: an object without a prototype that maps each group name to what it captured. */
function groupsObject(runtime: Runtime, groups: Record<string, Value> | undefined): JsObject | undefined {
  if (!groups) return undefined;
  // oxlint-disable-next-line unicorn/no-null -- The groups object has no prototype, as in JavaScript.
  const object = runtime.newObject(null);
  for (const [name, value] of Object.entries(groups)) runtime.createDataProperty(object, name, value);
  return object;
}

// String methods --------------------------------------------------------------------------------------------------

function defineStringMethods(builder: RealmBuilder): void {
  const { stringPrototype } = builder.realm;
  const method = (name: string, run: (call: NativeCall, text: string) => Value): void => {
    builder.method(stringPrototype, name, 1, (call) => {
      const { runtime, thisValue } = call;
      if (thisValue === undefined || thisValue === null) {
        return runtime.throwError('TypeError', `String.prototype.${name} called on null or undefined`);
      }
      const text = runtime.toString(thisValue);
      runtime.scan(text.length);
      return run(call, text);
    });
  };
  method('match', ({ runtime, args }, text) => matchWithRegExp(runtime, regExpArgument(runtime, args[0], ''), text));
  method('search', ({ runtime, args }, text) => searchWithRegExp(runtime, regExpArgument(runtime, args[0], ''), text));
  const regExpStringIteratorPrototype = defineHostIteratorPrototype(builder, 'RegExp String Iterator');
  method('matchAll', ({ runtime, args }, text) => {
    const pattern = args[0];
    if (
      pattern instanceof JsObject &&
      pattern.regexp &&
      !runtime.toString(runtime.get(pattern, 'flags')).includes('g')
    ) {
      return runtime.throwError('TypeError', 'String.prototype.matchAll called with a non-global RegExp argument');
    }
    const object = regExpArgument(runtime, pattern, 'g');
    return matchAllIterator(runtime, object, text, regExpStringIteratorPrototype);
  });
}

function searchWithRegExp(runtime: Runtime, object: RegExpObject, text: string): Value {
  const previous = runtime.get(object, 'lastIndex');
  if (!Object.is(previous, 0)) runtime.set(object, 'lastIndex', 0);
  const result = regExpExec(runtime, object, text, true);
  if (!Object.is(runtime.get(object, 'lastIndex'), previous)) runtime.set(object, 'lastIndex', previous);
  return result ? runtime.get(result, 'index') : -1;
}

function matchWithRegExp(runtime: Runtime, object: RegExpObject, text: string): JsObject | null {
  const flags = runtime.toString(runtime.get(object, 'flags'));
  if (!flags.includes('g')) return regExpExec(runtime, object, text, true);
  const array = runtime.newArray([]);
  runtime.hold(array, () => {
    for (const match of globalMatches(runtime, object, text, flags)) {
      runtime.allocate(1);
      array.elements.push(match.text);
    }
  });
  // oxlint-disable-next-line unicorn/no-null -- String.prototype.match returns null on no match.
  return array.elements.length > 0 ? array : null;
}

function* globalMatches(
  runtime: Runtime,
  object: JsObject,
  text: string,
  flags: string
): Generator<{ result: JsObject; text: string }> {
  runtime.set(object, 'lastIndex', 0);
  while (true) {
    runtime.spend();
    const result = regExpExec(runtime, object, text, true);
    if (!result) return;
    const matched = runtime.toString(runtime.get(result, '0'));
    yield { result, text: matched };
    if (matched === '') advanceLastIndex(runtime, object, text, flags);
  }
}

function advanceLastIndex(runtime: Runtime, object: JsObject, text: string, flags: string): void {
  const index = matchIndex(runtime, object, 'lastIndex');
  runtime.set(object, 'lastIndex', advanceIndex(text, index, flags.includes('u') || flags.includes('v')));
}

function matchAllIterator(runtime: Runtime, object: RegExpObject, text: string, prototype: JsObject): JsObject {
  const constructor = regExpSpeciesConstructor(runtime, object);
  const flags = runtime.toString(runtime.get(object, 'flags'));
  const { matcher } = cloneRegExp(runtime, object, constructor, flags);
  const index = matchIndex(runtime, object, 'lastIndex');
  runtime.set(matcher, 'lastIndex', index);
  let done = false;
  return newHostIterator(runtime, prototype, {
    source: matcher,
    next: () => {
      if (done) return DONE;
      const match = regExpExec(runtime, matcher, text, true);
      done = match === null || !flags.includes('g');
      if (!match) return DONE;
      if (!done && runtime.toString(runtime.get(match, '0')) === '') advanceLastIndex(runtime, matcher, text, flags);
      return match;
    },
  });
}

interface RegExpClone {
  matcher: JsObject;
  isPrivate: boolean;
}

function regExpSpeciesConstructor(runtime: Runtime, object: JsObject): JsFunction | undefined {
  const constructor = runtime.get(object, 'constructor');
  if (constructor !== undefined && !isObject(constructor))
    return runtime.throwError('TypeError', 'The .constructor property is not an object');
  const species = constructor && runtime.get(constructor, WELL_KNOWN_SYMBOLS.species);
  if (species === undefined || species === null || species === runtime.realm.regExpConstructor) return undefined;
  if (!isCallable(species) || !species.isConstructor)
    return runtime.throwError('TypeError', 'object.constructor[Symbol.species] is not a constructor');
  return species;
}

function cloneRegExp(
  runtime: Runtime,
  object: RegExpObject,
  constructor: JsFunction | undefined,
  flags: string
): RegExpClone {
  return constructor
    ? { matcher: runtime.construct(constructor, [object, flags], constructor, runtime.currentRow), isPrivate: false }
    : { matcher: newRegExp(runtime, object.regexp.source, flags), isPrivate: true };
}

/** The regular expression a String method uses: its argument when it is one, else one made from its text. */
function regExpArgument(runtime: Runtime, value: Value, flags: string): RegExpObject {
  if (value instanceof JsObject && value.regexp) return value as RegExpObject;
  return newRegExp(runtime, value === undefined ? '(?:)' : runtime.toString(value), flags) as RegExpObject;
}

/**
 * Replaces the matches of a regular expression, calling `replacement` for each when it is a function. As in
 * JavaScript, every match is found first, which settles `lastIndex` before any replacement function runs, and the
 * result is built match by match within the string length limit.
 */
export function replaceWithRegExp(
  { runtime, callRow }: NativeCall,
  text: string,
  object: RegExpObject,
  replacement: Value,
  all: boolean
): string {
  const flags = runtime.toString(runtime.get(object, 'flags'));
  if (all && !flags.includes('g')) {
    return runtime.throwError('TypeError', 'String.prototype.replaceAll called with a non-global RegExp argument');
  }
  const template = isCallable(replacement) ? undefined : runtime.toString(replacement);
  runtime.scan(text.length);
  const matches = matchesToReplace(runtime, object, text, flags);
  let result = '';
  let position = 0;
  for (const match of matches.elements) {
    if (!isObject(match)) continue;
    runtime.spend();
    const { matched, captures, index, groups } = replacementMatch(runtime, match, text.length);
    const inserted =
      template === undefined
        ? runtime.toString(
            runtime.call(
              replacement,
              undefined,
              [matched, ...captures, index, text, ...(groups === undefined ? [] : [groups])],
              callRow
            )
          )
        : substitution(runtime, template, matched, text, index, captures, groupLookup(runtime, groups));
    if (index < position) continue;
    const part = text.slice(position, index) + inserted;
    runtime.extendString(result.length + part.length, part.length);
    result += part;
    position = index + matched.length;
  }
  const suffix = text.slice(position);
  runtime.extendString(result.length + suffix.length, suffix.length);
  return result + suffix;
}

function matchesToReplace(runtime: Runtime, object: JsObject, text: string, flags: string): JsArray {
  if (!flags.includes('g')) {
    const result = regExpExec(runtime, object, text, true);
    return runtime.newArray(result ? [result] : []);
  }
  const matches = runtime.newArray([]);
  return runtime.hold(matches, () => {
    for (const { result } of globalMatches(runtime, object, text, flags)) {
      runtime.allocate(1);
      matches.elements.push(result);
    }
    return matches;
  });
}

interface ReplacementMatch {
  matched: string;
  captures: (string | undefined)[];
  index: number;
  groups: Value;
}

function replacementMatch(runtime: Runtime, match: JsObject, length: number): ReplacementMatch {
  const values = new ArrayOps(runtime, match);
  const captureCount = Math.max(0, values.length - 1);
  const matched = runtime.toString(runtime.get(match, '0'));
  const index = matchIndex(runtime, match, 'index', length);
  runtime.allocate(captureCount);
  const captures = Array.from({ length: captureCount }, (_, offset) => {
    const capture = values.get(offset + 1);
    return capture === undefined ? undefined : runtime.toString(capture);
  });
  return { matched, captures, index, groups: runtime.get(match, 'groups') };
}

function groupLookup(runtime: Runtime, groups: Value): ((key: string) => string) | undefined {
  if (groups === undefined) return undefined;
  const object = runtime.toObject(groups);
  return (key) => {
    const value = runtime.get(object, key);
    return value === undefined ? '' : runtime.toString(value);
  };
}

/** Expands a replacement template for one match as the spec's GetSubstitution does: `$&`, `$1`, `$<name>`, and so on. */
// code-gauge-allow functionParameterCount -- Takes each input of the spec's GetSubstitution, which a template may refer to.
function substitution(
  runtime: Runtime,
  template: string,
  matched: string,
  text: string,
  position: number,
  captures: (string | undefined)[],
  group: ((key: string) => string) | undefined
): string {
  let result = '';
  // Each piece is charged before it is appended, so a template repeating a long expansion stays within the limit.
  const append = (piece: string): void => {
    runtime.extendString(result.length + piece.length, piece.length);
    result += piece;
  };
  let index = 0;
  while (index < template.length) {
    const dollar = template.indexOf('$', index);
    if (dollar !== index) {
      const end = dollar === -1 ? template.length : dollar;
      append(template.slice(index, end));
      index = end;
      continue;
    }
    const expansion = dollarExpansion(template, index, matched, text, position, captures, group);
    append(expansion ? expansion.text : '$');
    index += expansion ? expansion.length : 1;
  }
  return result;
}

// code-gauge-allow functionParameterCount -- Takes each input of the spec's GetSubstitution, which a template may refer to.
function dollarExpansion(
  template: string,
  index: number,
  matched: string,
  text: string,
  position: number,
  captures: (string | undefined)[],
  group: ((key: string) => string) | undefined
): { text: string; length: number } | undefined {
  const next = template[index + 1];
  if (next === '$') return { text: '$', length: 2 };
  if (next === '&') return { text: matched, length: 2 };
  if (next === '`') return { text: text.slice(0, position), length: 2 };
  if (next === "'") return { text: text.slice(position + matched.length), length: 2 };
  if (next === '<') {
    if (!group) return undefined;
    const close = template.indexOf('>', index + 2);
    if (close === -1) return undefined;
    return { text: group(template.slice(index + 2, close)), length: close - index + 1 };
  }
  if (!/\d/.test(next)) return undefined;
  // Two digits name a capture when there is one of that number, else the first digit does.
  const twoDigits = /^\d\d$/.test(template.slice(index + 1, index + 3))
    ? Number(template.slice(index + 1, index + 3))
    : 0;
  if (twoDigits >= 1 && twoDigits <= captures.length) return { text: captures[twoDigits - 1] ?? '', length: 3 };
  const oneDigit = Number(next);
  if (oneDigit >= 1 && oneDigit <= captures.length) return { text: captures[oneDigit - 1] ?? '', length: 2 };
  return undefined;
}

export function splitWithRegExp(runtime: Runtime, text: string, object: RegExpObject, limitValue: Value): JsArray {
  const constructor = regExpSpeciesConstructor(runtime, object);
  const flags = runtime.toString(runtime.get(object, 'flags'));
  const splitter = cloneRegExp(runtime, object, constructor, flags.includes('y') ? flags : `${flags}y`);
  const limit = limitValue === undefined ? 2 ** 32 - 1 : runtime.toNumber(limitValue) >>> 0;
  const array = runtime.newArray([]);
  const matchAt = splitMatcher(runtime, splitter, text);
  const unicode = flags.includes('u') || flags.includes('v');
  return runtime.hold(array, () => splitMatches(runtime, text, array, { limit, matchAt, unicode }));
}

interface SplitMatch {
  end: number;
  captures: Iterable<Value>;
}
type SplitMatcher = (position: number) => SplitMatch | undefined;

function splitMatcher(runtime: Runtime, { matcher: splitter, isPrivate }: RegExpClone, text: string): SplitMatcher {
  const regexp = isPrivate ? asRegExp(splitter) : undefined;
  if (regexp && usesBuiltinExec(runtime, regexp)) {
    const matcher = new RegExp(regexp.regexp.source, regexp.regexp.flags);
    return (position) => {
      matcher.lastIndex = position;
      const match = matcher.exec(text);
      if (!match) return;
      return { end: Math.min(matcher.lastIndex, text.length), captures: match.slice(1) };
    };
  }
  return (position) => {
    runtime.spend();
    runtime.set(splitter, 'lastIndex', position);
    const match = regExpExec(runtime, splitter, text, true);
    if (!match) return;
    return { end: matchIndex(runtime, splitter, 'lastIndex', text.length), captures: splitCaptures(runtime, match) };
  };
}

/** A data-only lookup proves native matching cannot execute learner code between positions. */
function usesBuiltinExec(runtime: Runtime, object: JsObject): boolean {
  for (let current: JsObject | null = object; current; current = current.proto) {
    const property = runtime.getOwnProperty(current, 'exec');
    if (property) return !isAccessor(property) && property.value === runtime.realm.regExpExec;
  }
  return false;
}

function* splitCaptures(runtime: Runtime, match: JsObject): Generator<Value> {
  const captures = new ArrayOps(runtime, match);
  const count = captures.length;
  for (let index = 1; index < count; index++) yield captures.get(index);
}

function splitMatches(
  runtime: Runtime,
  text: string,
  array: JsArray,
  { limit, matchAt, unicode }: { limit: number; matchAt: SplitMatcher; unicode: boolean }
): JsArray {
  const push = (part: Value): boolean => {
    runtime.allocate(1);
    array.elements.push(part);
    return array.elements.length >= limit;
  };
  if (limit === 0) return array;
  if (text.length === 0) {
    if (!matchAt(0)) push(text);
    return array;
  }
  let start = 0;
  let position = 0;
  runtime.scan(text.length);
  while (position < text.length) {
    const match = matchAt(position);
    if (!match || match.end === start) {
      position = advanceIndex(text, position, unicode);
      continue;
    }
    if (push(text.slice(start, position))) return array;
    for (const capture of match.captures) if (push(capture)) return array;
    start = match.end;
    position = start;
  }
  push(text.slice(start));
  return array;
}

function matchIndex(runtime: Runtime, object: JsObject, key: string, max = Number.MAX_SAFE_INTEGER): number {
  return Math.max(0, Math.min(Math.trunc(runtime.toNumber(runtime.get(object, key))) || 0, max));
}

/** The spec's AdvanceStringIndex, which steps over a whole surrogate pair in a Unicode-aware expression. */
function advanceIndex(text: string, index: number, unicode: boolean): number {
  if (!unicode) return index + 1;
  return index + ((text.codePointAt(index) ?? 0) > 0xff_ff ? 2 : 1);
}

/** The regular expression object a value is, if it is one. */
export function asRegExp(value: Value): RegExpObject | undefined {
  return value instanceof JsObject && value.regexp ? (value as RegExpObject) : undefined;
}
