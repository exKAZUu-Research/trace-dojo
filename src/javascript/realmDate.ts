import type { RealmBuilder } from './realm';
import { receiverText } from './realmCollections';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { isCallable, isObject, JsObject, type NativeCall, throwingHostErrors, type Value } from './values';

/** The spec's `[[DateValue]]` of each Date object, the milliseconds since the epoch or NaN. */
const timeValues = new WeakMap<JsObject, number>();

/** The time value of a Date object, or undefined for any other value. */
export function dateValueOf(value: Value): number | undefined {
  return value instanceof JsObject ? timeValues.get(value) : undefined;
}

/** The text `util.inspect` shows for a Date: its ISO string, or `Invalid Date`. */
export function inspectDate(time: number): string {
  return Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString();
}

/** Creates a Date object with the given time value, as `structuredClone` does. */
export function newDate(runtime: Runtime, time: number, prototype: JsObject): JsObject {
  const date = runtime.newObject(prototype);
  timeValues.set(date, time);
  return date;
}

/**
 * Defines Date, whose calendar arithmetic, parsing, and formatting the host's Date performs on the time value. Local
 * time is the host's time zone, as it is Node.js's, and `Date.now()` reads the event loop's simulated clock.
 */
export function defineDateBuiltins(builder: RealmBuilder): void {
  const prototype = builder.realm.datePrototype;
  const startTime = Date.now();
  const now = (runtime: Runtime): number => startTime + runtime.eventLoop.readClock();
  const dateConstructor = builder.defineClass('Date', 7, prototype, (call) => {
    const { runtime, newTarget } = call;
    if (!newTarget) return new Date(now(runtime)).toString();
    // Only `new Date()` reads the clock, which moves it.
    const time = call.args.length === 0 ? now(runtime) : constructedTime(call);
    return newDate(runtime, time, runtime.prototypeFor(newTarget, prototype));
  });
  builder.method(dateConstructor, 'now', 0, ({ runtime }) => now(runtime));
  builder.method(dateConstructor, 'parse', 1, ({ runtime, args }) => Date.parse(runtime.toString(args[0])));
  builder.method(dateConstructor, 'UTC', 7, ({ runtime, args }) => {
    const numbers = args.slice(0, 7).map((value) => runtime.toNumber(value));
    return numbers.length === 0 ? Number.NaN : Date.UTC(numbers[0], ...numbers.slice(1));
  });
  defineGetters(builder, prototype);
  defineSetters(builder, prototype);
  defineConversions(builder, prototype);
}

/** The time value `new Date(...args)` gives for at least one argument. */
function constructedTime({ runtime, args }: NativeCall): number {
  if (args.length === 1) {
    const [value] = args;
    const time = dateValueOf(value);
    if (time !== undefined) return time;
    const primitive = runtime.toPrimitive(value, 'default');
    if (typeof primitive === 'string') return Date.parse(primitive);
    return new Date(runtime.toNumber(primitive)).getTime();
  }
  const numbers = args.slice(0, 7).map((value) => runtime.toNumber(value));
  return new Date(numbers[0], numbers[1], ...numbers.slice(2)).getTime();
}

function thisTime(runtime: Runtime, value: Value): number {
  const time = dateValueOf(value);
  return time ?? runtime.throwError('TypeError', 'this is not a Date object.');
}

const GETTERS = [
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'getTimezoneOffset',
  'getUTCFullYear',
  'getUTCMonth',
  'getUTCDate',
  'getUTCDay',
  'getUTCHours',
  'getUTCMinutes',
  'getUTCSeconds',
  'getUTCMilliseconds',
] as const;

function defineGetters(builder: RealmBuilder, prototype: JsObject): void {
  for (const name of ['getTime', 'valueOf'] as const) {
    builder.method(prototype, name, 0, ({ runtime, thisValue }) => thisTime(runtime, thisValue));
  }
  for (const name of GETTERS) {
    builder.method(prototype, name, 0, ({ runtime, thisValue }) => new Date(thisTime(runtime, thisValue))[name]());
  }
}

const SETTERS = [
  ['setMilliseconds', 1],
  ['setSeconds', 2],
  ['setMinutes', 3],
  ['setHours', 4],
  ['setDate', 1],
  ['setMonth', 2],
  ['setFullYear', 3],
  ['setUTCMilliseconds', 1],
  ['setUTCSeconds', 2],
  ['setUTCMinutes', 3],
  ['setUTCHours', 4],
  ['setUTCDate', 1],
  ['setUTCMonth', 2],
  ['setUTCFullYear', 3],
] as const;

function defineSetters(builder: RealmBuilder, prototype: JsObject): void {
  builder.method(prototype, 'setTime', 1, ({ runtime, thisValue, args }) => {
    thisTime(runtime, thisValue);
    const time = new Date(runtime.toNumber(args[0])).getTime();
    timeValues.set(thisValue as JsObject, time);
    return time;
  });
  for (const [name, length] of SETTERS) {
    builder.method(prototype, name, length, ({ runtime, thisValue, args }) => {
      const host = new Date(thisTime(runtime, thisValue));
      // The host's setter, like the spec's, treats a missing argument apart from an undefined one.
      const numbers = (args.length === 0 ? [undefined] : args.slice(0, length)).map((value) => runtime.toNumber(value));
      const setter = host[name] as (...values: number[]) => number;
      const time = setter.apply(host, numbers);
      timeValues.set(thisValue as JsObject, time);
      return time;
    });
  }
}

/** A host value for the locales argument of a `toLocale...String` method: a tag, or a list of them. */
export function hostLocales(runtime: Runtime, value: Value): unknown {
  // CanonicalizeLocaleList converts a null locale list to an object, which the host reports in its own words.
  if (value === null) runtime.throwError('TypeError', 'Cannot convert undefined or null to object');
  if (!(value instanceof JsObject)) return value;
  const length = Math.trunc(runtime.toNumber(runtime.get(value, 'length'))) || 0;
  runtime.scan(length);
  // Absent entries are skipped, as CanonicalizeLocaleList checks each index before reading it.
  const locales: unknown[] = [];
  for (let index = 0; index < length; index++) {
    if (!runtime.hasProperty(value, String(index))) continue;
    const locale = runtime.get(value, String(index));
    locales.push(isObject(locale) ? runtime.toString(locale) : locale);
  }
  return locales;
}

/**
 * A host value for the options argument of a `toLocale...String` method, whose every option the host formatter reads
 * through the program's own property lookup, inherited options and getters included, in the formatter's order.
 */
export function hostOptions(runtime: Runtime, value: Value): unknown {
  if (!(value instanceof JsObject)) return value;
  return new Proxy(
    {},
    {
      get: (_, key) => {
        if (typeof key !== 'string') return;
        const option = runtime.get(value, key);
        return isObject(option) ? runtime.toString(option) : option;
      },
    }
  );
}

function defineConversions(builder: RealmBuilder, prototype: JsObject): void {
  for (const name of ['toString', 'toDateString', 'toTimeString', 'toUTCString'] as const) {
    builder.method(prototype, name, 0, ({ runtime, thisValue }) => new Date(thisTime(runtime, thisValue))[name]());
  }
  const toUtcString = prototype.properties.get('toUTCString');
  if (toUtcString) prototype.properties.set('toGMTString', { ...toUtcString });
  builder.method(prototype, 'toISOString', 0, ({ runtime, thisValue }) => {
    const time = thisTime(runtime, thisValue);
    if (Number.isNaN(time)) runtime.throwError('RangeError', 'Invalid time value');
    return new Date(time).toISOString();
  });
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
    builder.method(prototype, name, 0, ({ runtime, thisValue, args }) => {
      const time = thisTime(runtime, thisValue);
      // As in Node.js, an invalid date formats before its locales and options are looked at.
      if (Number.isNaN(time)) return 'Invalid Date';
      const date = new Date(time);
      const locales = hostLocales(runtime, args[0]) as Intl.LocalesArgument;
      const options = hostOptions(runtime, args[1]) as Intl.DateTimeFormatOptions;
      return throwingHostErrors(runtime, () => date[name](locales, options));
    });
  }
  builder.method(prototype, 'toJSON', 1, ({ runtime, thisValue }) => {
    const object = runtime.toObject(thisValue);
    const primitive = runtime.toPrimitive(object, 'number');
    // oxlint-disable-next-line unicorn/no-null -- JSON.stringify writes a Date without a time as null.
    if (typeof primitive === 'number' && !Number.isFinite(primitive)) return null;
    const toIsoString = runtime.get(object, 'toISOString');
    return runtime.call(toIsoString, object, [], runtime.currentRow);
  });
  builder.method(prototype, WELL_KNOWN_SYMBOLS.toPrimitive, 1, ({ runtime, thisValue, args }) => {
    if (!isObject(thisValue)) {
      return runtime.throwError('TypeError', 'Date.prototype [ @@toPrimitive ] called on non-object');
    }
    const [hint] = args;
    if (hint !== 'string' && hint !== 'default' && hint !== 'number') {
      return runtime.throwError('TypeError', `Invalid hint: ${receiverText(runtime, hint)}`);
    }
    return ordinaryToPrimitive(
      runtime,
      thisValue,
      hint === 'number' ? ['valueOf', 'toString'] : ['toString', 'valueOf']
    );
  });
}

/** The spec's OrdinaryToPrimitive, which a Date's `Symbol.toPrimitive` uses with the string order for `default`. */
function ordinaryToPrimitive(runtime: Runtime, object: JsObject, order: string[]): Value {
  for (const name of order) {
    const method = runtime.get(object, name);
    if (!isCallable(method)) continue;
    const result = runtime.call(method, object, [], runtime.currentRow);
    if (!isObject(result)) return result;
  }
  return runtime.throwError('TypeError', 'Cannot convert object to primitive value');
}
