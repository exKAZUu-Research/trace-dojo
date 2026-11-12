import { DONE } from './iteration';
import type { RealmBuilder } from './realm';
import { defineHostIteratorPrototype, newHostIterator } from './realmIterators';
import type { Runtime } from './runtime';
import { isCallable, JsObject, type NativeCall, type Value } from './values';

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
  let regexp: RegExp;
  try {
    regexp = new RegExp(source, flags);
  } catch (error) {
    if (error instanceof SyntaxError) return runtime.throwError('SyntaxError', error.message);
    throw error;
  }
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
    const indices = runtime.newArray(
      match.indices.map((pair) => (pair ? runtime.newArray([pair[0], pair[1]]) : undefined))
    );
    const { groups } = match.indices;
    runtime.createDataProperty(
      indices,
      'groups',
      groupsObject(
        runtime,
        groups &&
          Object.fromEntries(Object.entries(groups).map(([name, pair]) => [name, pair && runtime.newArray([...pair])]))
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

/** Replaces the matches of a regular expression, calling `replacement` for each when it is a function. */
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
  const replaceValue = isCallable(replacement) ? undefined : runtime.toString(replacement);
  return withHostRegExp(runtime, object, (regexp) => {
    const result =
      replaceValue === undefined
        ? text.replace(regexp, (...parts: unknown[]) => {
            // The host passes the groups object last only when the expression names a group.
            const hasGroups = typeof parts.at(-1) === 'object';
            const args = (hasGroups ? parts.slice(0, -1) : parts) as Value[];
            if (hasGroups) args.push(groupsObject(runtime, parts.at(-1) as Record<string, Value>));
            return runtime.toString(runtime.call(replacement, undefined, args, callRow));
          })
        : text.replace(regexp, replaceValue);
    runtime.buildString(result.length);
    return result;
  });
}

/** The regular expression object a value is, if it is one. */
export function asRegExp(value: Value): RegExpObject | undefined {
  return value instanceof JsObject && value.regexp ? (value as RegExpObject) : undefined;
}
