import { DONE } from './iteration';
import type { RealmBuilder } from './realm';
import { defineHostIteratorPrototype, newHostIterator } from './realmIterators';
import type { Runtime } from './runtime';
import { isCallable, type JsArray, JsObject, type NativeCall, throwingHostErrors, type Value } from './values';

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

/**
 * Defines RegExp and the String methods that take one. Each runs on a copy of the host's `RegExp` that starts at the
 * object's `lastIndex` and writes back where the host left it, so the host's matching decides every result.
 */
export function defineRegExpBuiltins(builder: RealmBuilder): void {
  const { regExpPrototype } = builder.realm;
  builder.defineClass('RegExp', 2, regExpPrototype, ({ runtime, args, newTarget }) => {
    const [pattern, flags] = args;
    const regexp = pattern instanceof JsObject ? pattern.regexp : undefined;
    if (regexp && !newTarget && flags === undefined) return pattern;
    const source = regexp ? regexp.source : pattern === undefined ? '' : runtime.toString(pattern);
    const flagText = flags === undefined ? (regexp?.flags ?? '') : runtime.toString(flags);
    const object = newRegExp(runtime, source, flagText);
    object.proto = runtime.prototypeFor(newTarget, regExpPrototype);
    return object;
  });
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
  builder.method(regExpPrototype, 'exec', 1, ({ runtime, thisValue, args }) => {
    const object = thisRegExp(runtime, thisValue, 'exec');
    return exec(runtime, object, runtime.toString(args[0]));
  });
  builder.method(regExpPrototype, 'test', 1, ({ runtime, thisValue, args }) => {
    const object = thisRegExp(runtime, thisValue, 'test');
    return exec(runtime, object, runtime.toString(args[0])) !== null;
  });
  builder.method(regExpPrototype, 'toString', 0, ({ runtime, thisValue }) => {
    const object = runtime.toObject(thisValue);
    return `/${runtime.toString(runtime.get(object, 'source'))}/${runtime.toString(runtime.get(object, 'flags'))}`;
  });
  builder.getter(regExpPrototype, 'source', ({ runtime, thisValue }) =>
    thisValue === regExpPrototype ? '(?:)' : thisRegExp(runtime, thisValue, 'source').regexp.source
  );
  builder.getter(regExpPrototype, 'flags', ({ runtime, thisValue }) => {
    const object = runtime.toObject(thisValue);
    return FLAG_GETTERS.filter(([name]) => runtime.get(object, name))
      .map(([, flag]) => flag)
      .join('');
  });
  for (const [name, flag] of FLAG_GETTERS) {
    builder.getter(regExpPrototype, name, ({ runtime, thisValue }) => {
      if (thisValue === regExpPrototype) return;
      return thisRegExp(runtime, thisValue, name).regexp.flags.includes(flag);
    });
  }
}

export type RegExpObject = JsObject & { regexp: RegExp };

function thisRegExp(runtime: Runtime, value: Value, name: string): RegExpObject {
  if (value instanceof JsObject && value.regexp) return value as RegExpObject;
  return runtime.throwError(
    'TypeError',
    `Method RegExp.prototype.${name} called on incompatible receiver ${runtime.describe(value)}`
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

function exec(runtime: Runtime, object: RegExpObject, text: string): JsObject | null {
  runtime.scan(text.length);
  const match = withHostRegExp(runtime, object, (regexp) => regexp.exec(text));
  // oxlint-disable-next-line unicorn/no-null -- exec returns null when nothing matches, as in JavaScript.
  return match ? matchArray(runtime, match) : null;
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

// code-gauge-allow functionNcss 31 -- Lists the String methods that take a regular expression, each a small closure of its own.
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
  method('match', ({ runtime, args }, text) => {
    const object = regExpArgument(runtime, args[0], '');
    if (!object.regexp.global) return exec(runtime, object, text);
    const matches = withHostRegExp(runtime, object, (regexp) => text.match(regexp));
    // oxlint-disable-next-line unicorn/no-null -- match returns null when nothing matches, as in JavaScript.
    return matches ? runtime.newArray([...matches]) : null;
  });
  method('search', ({ runtime, args }, text) => {
    const object = regExpArgument(runtime, args[0], '');
    return text.search(new RegExp(object.regexp.source, object.regexp.flags));
  });
  const regExpStringIteratorPrototype = defineHostIteratorPrototype(builder, 'RegExp String Iterator');
  method('matchAll', ({ runtime, args }, text) => {
    const pattern = args[0];
    if (pattern instanceof JsObject && pattern.regexp && !pattern.regexp.global) {
      return runtime.throwError('TypeError', 'String.prototype.matchAll called with a non-global RegExp argument');
    }
    const object = regExpArgument(runtime, pattern, 'g');
    const regexp = new RegExp(object.regexp.source, object.regexp.flags);
    regexp.lastIndex = runtime.toNumber(runtime.get(object, 'lastIndex'));
    const matches = text.matchAll(regexp);
    return newHostIterator(runtime, regExpStringIteratorPrototype, {
      next: () => {
        const next = matches.next();
        return next.done ? DONE : matchArray(runtime, next.value);
      },
    });
  });
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
  if (all && !object.regexp.global) {
    return runtime.throwError('TypeError', 'String.prototype.replaceAll called with a non-global RegExp argument');
  }
  const template = isCallable(replacement) ? undefined : runtime.toString(replacement);
  runtime.scan(text.length);
  const matches = withHostRegExp(runtime, object, (regexp) => matchesToReplace(runtime, regexp, text));
  let result = '';
  let position = 0;
  for (const match of matches) {
    runtime.spend();
    const [matched] = match;
    const captures = match.slice(1);
    const inserted =
      template === undefined
        ? runtime.toString(
            runtime.call(
              replacement,
              undefined,
              [matched, ...captures, match.index, text, ...(match.groups ? [groupsObject(runtime, match.groups)] : [])],
              callRow
            )
          )
        : substitution(runtime, template, matched, text, match.index, captures, match.groups);
    const part = text.slice(position, match.index) + inserted;
    runtime.extendString(result.length + part.length, part.length);
    result += part;
    position = match.index + matched.length;
  }
  const suffix = text.slice(position);
  runtime.extendString(result.length + suffix.length, suffix.length);
  return result + suffix;
}

function matchesToReplace(runtime: Runtime, regexp: RegExp, text: string): RegExpExecArray[] {
  if (!regexp.global) {
    const match = regexp.exec(text);
    return match ? [match] : [];
  }
  regexp.lastIndex = 0;
  // The host's matchAll steps over empty matches as JavaScript's replace does, and leaves lastIndex at 0.
  const matches: RegExpExecArray[] = [];
  for (const match of text.matchAll(regexp)) {
    // Charged as the match arrays JavaScript keeps until the replacements run, captures included.
    runtime.allocate(match.length + 1);
    matches.push(match);
  }
  return matches;
}

/** Expands a replacement template for one match as the spec's GetSubstitution does: `$&`, `$1`, `$<name>`, and so on. */
// code-gauge-allow functionParameterCount 7 -- Takes each input of the spec's GetSubstitution, which a template may refer to.
function substitution(
  runtime: Runtime,
  template: string,
  matched: string,
  text: string,
  position: number,
  captures: (string | undefined)[],
  groups: Record<string, string | undefined> | undefined
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
    const expansion = dollarExpansion(template, index, matched, text, position, captures, groups);
    append(expansion ? expansion.text : '$');
    index += expansion ? expansion.length : 1;
  }
  return result;
}

// code-gauge-allow functionParameterCount 7 -- Takes each input of the spec's GetSubstitution, which a template may refer to.
function dollarExpansion(
  template: string,
  index: number,
  matched: string,
  text: string,
  position: number,
  captures: (string | undefined)[],
  groups: Record<string, string | undefined> | undefined
): { text: string; length: number } | undefined {
  const next = template[index + 1];
  if (next === '$') return { text: '$', length: 2 };
  if (next === '&') return { text: matched, length: 2 };
  if (next === '`') return { text: text.slice(0, position), length: 2 };
  if (next === "'") return { text: text.slice(position + matched.length), length: 2 };
  if (next === '<') {
    if (groups === undefined) return undefined;
    const close = template.indexOf('>', index + 2);
    if (close === -1) return undefined;
    return { text: groups[template.slice(index + 2, close)] ?? '', length: close - index + 1 };
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

/** The regular expression object a value is, if it is one. */
// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
// code-gauge-allow functionNcss 33 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
/**
 * The spec's RegExp.prototype[Symbol.split], which matches at each position with a sticky copy of the expression and
 * charges each part before it is kept.
 */
export function splitWithRegExp(runtime: Runtime, text: string, object: RegExpObject, limit: number): JsArray {
  const { flags } = object.regexp;
  const splitter = new RegExp(object.regexp.source, flags.includes('y') ? flags : `${flags}y`);
  const array = runtime.newArray([]);
  const push = (part: string | undefined): boolean => {
    runtime.allocate(1);
    array.elements.push(part);
    return array.elements.length >= limit;
  };
  if (limit === 0) return array;
  if (text.length === 0) {
    if (!splitter.test(text)) push(text);
    return array;
  }
  let start = 0;
  let position = 0;
  while (position < text.length) {
    runtime.spend();
    splitter.lastIndex = position;
    const match = splitter.exec(text);
    const end = match ? Math.min(splitter.lastIndex, text.length) : start;
    if (!match || end === start) {
      position = advanceIndex(text, position, splitter.unicode || splitter.unicodeSets);
      continue;
    }
    if (push(text.slice(start, position))) return array;
    for (const capture of match.slice(1)) if (push(capture)) return array;
    start = end;
    position = end;
  }
  push(text.slice(start));
  return array;
}

/** The spec's AdvanceStringIndex, which steps over a whole surrogate pair in a Unicode-aware expression. */
function advanceIndex(text: string, index: number, unicode: boolean): number {
  if (!unicode) return index + 1;
  return index + ((text.codePointAt(index) ?? 0) > 0xff_ff ? 2 : 1);
}

export function asRegExp(value: Value): RegExpObject | undefined {
  return value instanceof JsObject && value.regexp ? (value as RegExpObject) : undefined;
}
