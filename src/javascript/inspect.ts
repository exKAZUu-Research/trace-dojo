// code-gauge-allow-file fileNcss 746 -- Ports Node.js's inspection and error formatting around shared object and stack metadata.
import { inspect as hostInspect, type InspectStyle, stripVTControlCharacters } from 'node:util';

import { eastAsianWidthType } from 'get-east-asian-width';

import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { closingOnThrow, DONE } from './iteration';
import type { PromiseState } from './promises';
import type { Realm } from './realm';
import { type CollectionEntry, CollectionIterator } from './realmCollections';
import { dateValueOf, inspectDate } from './realmDate';
import { objectToString } from './realmGlobals';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  type AccessorProperty,
  arrayIndexOf,
  isAccessor,
  isCallable,
  isObject,
  JsArray,
  JsFunction,
  JsObject,
  JsThrow,
  type Key,
  type Property,
  type Value,
} from './values';

// The defaults of Node.js's `util.inspect`, which this module ports from `lib/internal/util/inspect.js`.
const DEFAULT_DEPTH = 2;
const BREAK_LENGTH = 80;
const COMPACT = 3;
const MAX_ARRAY_LENGTH = 100;
const MAX_STRING_LENGTH = 10_000;
const MIN_LINE_LENGTH = 16;

// Names Node.js 26.13.0's util.inspect takes from its original globals before it runs the program.
const NODE_BUILTIN_NAMES = new Set([
  'AbortController',
  'AbortSignal',
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'AsyncDisposableStack',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Blob',
  'Boolean',
  'BroadcastChannel',
  'Buffer',
  'ByteLengthQueuingStrategy',
  'CloseEvent',
  'CompressionStream',
  'CountQueuingStrategy',
  'Crypto',
  'CryptoKey',
  'CustomEvent',
  'DOMException',
  'DataView',
  'Date',
  'DecompressionStream',
  'DisposableStack',
  'Error',
  'ErrorEvent',
  'EvalError',
  'Event',
  'EventTarget',
  'File',
  'FinalizationRegistry',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'FormData',
  'Function',
  'Headers',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Intl',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'MessageChannel',
  'MessageEvent',
  'MessagePort',
  'NaN',
  'Navigator',
  'Number',
  'Object',
  'Performance',
  'PerformanceEntry',
  'PerformanceMark',
  'PerformanceMeasure',
  'PerformanceObserver',
  'PerformanceObserverEntryList',
  'PerformanceResourceTiming',
  'Promise',
  'Proxy',
  'QuotaExceededError',
  'RangeError',
  'ReadableByteStreamController',
  'ReadableStream',
  'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest',
  'ReadableStreamDefaultController',
  'ReadableStreamDefaultReader',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'SharedArrayBuffer',
  'Storage',
  'String',
  'SubtleCrypto',
  'SuppressedError',
  'Symbol',
  'SyntaxError',
  'Temporal',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoder',
  'TextEncoderStream',
  'TransformStream',
  'TransformStreamDefaultController',
  'TypeError',
  'URIError',
  'URL',
  'URLPattern',
  'URLSearchParams',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'WebAssembly',
  'WebSocket',
  'WritableStream',
  'WritableStreamDefaultController',
  'WritableStreamDefaultWriter',
]);
const knownConstructorsByRealm = new WeakMap<Realm, Map<JsObject, string>>();

const KEY_PATTERN = /^[A-Z_a-z]\w*$/;
const ESCAPED_CHARACTER =
  // oxlint-disable-next-line no-control-regex -- Node.js escapes these control characters.
  /[\u0000-\u001F\\\u007F-\u009F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NAMED_ESCAPES: Record<string, string> = {
  '\b': String.raw`\b`,
  '\t': String.raw`\t`,
  '\n': String.raw`\n`,
  '\f': String.raw`\f`,
  '\r': String.raw`\r`,
  '\\': String.raw`\\`,
};

/** Bounds the text one console call formats before it is joined, since repeated large values multiply its length. */
export class OutputBudget {
  /** The characters charged so far. */
  used = 0;

  charge(length: number): void {
    this.used += length;
    if (this.used > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  }
}

interface Context {
  runtime: Runtime;
  budget: OutputBudget;
  depth: number;
  indentationLvl: number;
  /** The depth of the object formatted last, which decides whether its parents may share a line. */
  currentDepth: number;
  seen: Set<JsObject>;
  /** The stack text of each error this inspection prints, which Node.js works out once per print. */
  errorStacks: Map<JsObject, ErrorStack>;
  /** The reference numbers of the objects printed as `[Circular *n]`. */
  circular: Map<JsObject, number>;
  breakLength: number;
  /** As `util.inspect`'s option: how many inner levels may share a line, or `false` for one entry per line. */
  compact: number | boolean;
  maxArrayLength: number;
  /** As `util.inspect`'s option, which `%o` sets: an array also shows its `[length]`. */
  showHidden: boolean;
  /** As `util.inspect`'s options of the same names; `sorted` is `true`, `false`, or the comparator the program gave. */
  sorted: Value;
  getters: boolean | 'get' | 'set';
  numericSeparator: boolean;
  colors: boolean;
  maxStringLength: number;
}

/** The `util.inspect` options `console.dir` takes. */
export interface InspectOptions {
  depth?: number;
  breakLength?: number;
  compact?: number | boolean;
  maxArrayLength?: number;
  showHidden?: boolean;
  sorted?: Value;
  getters?: boolean | 'get' | 'set';
  numericSeparator?: boolean;
  colors?: boolean;
  maxStringLength?: number;
}

/**
 * Formats a value as `console.log` formats each argument, without running the program's own code: a string as it is,
 * anything else as `util.inspect` does.
 */
export function inspect(runtime: Runtime, value: Value, budget = new OutputBudget(), depth = DEFAULT_DEPTH): string {
  if (typeof value === 'string') {
    budget.charge(value.length);
    return value;
  }
  return inspectValue(runtime, value, budget, depth);
}

/** Formats a value as `util.inspect` does, quoting a string, as `console.dir` prints it. */
export function inspectValue(
  runtime: Runtime,
  value: Value,
  budget = new OutputBudget(),
  depth = DEFAULT_DEPTH,
  options: Omit<InspectOptions, 'depth'> = {}
): string {
  const ctx: Context = {
    runtime,
    budget,
    depth,
    indentationLvl: 0,
    currentDepth: 0,
    seen: new Set(),
    errorStacks: new Map(),
    circular: new Map(),
    breakLength: options.breakLength ?? BREAK_LENGTH,
    compact: options.compact ?? COMPACT,
    maxArrayLength: Math.max(0, options.maxArrayLength ?? MAX_ARRAY_LENGTH),
    showHidden: options.showHidden ?? false,
    sorted: options.sorted ?? false,
    getters: options.getters ?? false,
    numericSeparator: options.numericSeparator ?? false,
    colors: options.colors ?? false,
    maxStringLength: options.maxStringLength ?? MAX_STRING_LENGTH,
  };
  return formatCharged(ctx, value, 0);
}

function formatCharged(ctx: Context, value: Value, recurseTimes: number): string {
  const usedBefore = ctx.budget.used;
  const text = formatValue(ctx, value, recurseTimes);
  // The values nested in an array or object charged their own text, so only the rest of this text is new.
  ctx.budget.charge(text.length - (ctx.budget.used - usedBefore));
  return text;
}

function formatValue(ctx: Context, value: Value, recurseTimes: number): string {
  if (!(value instanceof JsObject)) return formatPrimitive(ctx, value);
  if (ctx.seen.has(value)) {
    let index = ctx.circular.get(value);
    if (index === undefined) {
      index = ctx.circular.size + 1;
      ctx.circular.set(value, index);
    }
    return stylize(ctx, `[Circular *${index}]`, 'special');
  }
  return formatRaw(ctx, value, recurseTimes);
}

function formatPrimitive(ctx: Context, value: Exclude<Value, JsObject>): string {
  if (typeof value === 'string') return formatString(ctx, value);
  if (typeof value === 'number' || typeof value === 'bigint') {
    const digits = typeof value === 'number' ? formatNumber(value) : String(value);
    return stylize(
      ctx,
      (ctx.numericSeparator ? separateDigits(digits) : digits) + (typeof value === 'bigint' ? 'n' : ''),
      typeof value
    );
  }
  return stylize(ctx, String(value), value === null ? 'null' : typeof value);
}

function stylize(ctx: Context, text: string, type: string): string {
  const style = ctx.colors && hostInspect.styles[type as InspectStyle];
  if (typeof style === 'function') return style(text);
  const color = style ? hostInspect.colors[style] : undefined;
  return color ? `\u001B[${color[0]}m${text}\u001B[${color[1]}m` : text;
}

function unstyled(ctx: Context, text: string): string {
  return ctx.colors ? stripVTControlCharacters(text) : text;
}

/** Formats `-0` as `-0`, which `String` does not. */
export function formatNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}

/**
 * Node.js's numericSeparator: `_` between each three digits of an integer part from its end and of a fractional part
 * from its start, as `1_234_567.891_2`.
 */
function separateDigits(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return text;
  const [, sign, integer, fraction] = match;
  const separatedFraction = fraction === undefined ? '' : `.${fraction.replaceAll(/(\d{3})(?=\d)/g, '$1_')}`;
  return `${sign}${integer.replaceAll(/\B(?=(\d{3})+$)/g, '_')}${separatedFraction}`;
}

function formatString(ctx: Context, text: string): string {
  let value = text;
  let trailer = '';
  if (value.length > ctx.maxStringLength) {
    const remaining = value.length - ctx.maxStringLength;
    value = value.slice(0, ctx.maxStringLength);
    trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
  }
  if (
    ctx.compact !== true &&
    value.length > MIN_LINE_LENGTH &&
    value.length > ctx.breakLength - ctx.indentationLvl - 4
  ) {
    return (
      value
        .split(/(?<=\n)/)
        .map((line) => stylize(ctx, quote(line), 'string'))
        .join(` +\n${' '.repeat(ctx.indentationLvl + 2)}`) + trailer
    );
  }
  return stylize(ctx, quote(value), 'string') + trailer;
}

/** Quotes a string with the first of `'`, `"`, and `` ` `` it does not contain, escaping what it must. */
function quote(text: string): string {
  let mark = "'";
  if (text.includes("'")) {
    if (!text.includes('"')) mark = '"';
    else if (!text.includes('`') && !text.includes('${')) mark = '`';
  }
  const escaped = escapeControls(text);
  return mark === "'" ? `'${escaped.replaceAll("'", String.raw`\'`)}'` : `${mark}${escaped}${mark}`;
}

/** Node.js's strEscape replacements: control characters and lone surrogates as escapes. */
function escapeControls(text: string): string {
  return text.replaceAll(ESCAPED_CHARACTER, (character) => {
    const named = NAMED_ESCAPES[character];
    if (named) return named;
    const code = character.codePointAt(0) ?? 0;
    return code >= 0xd8_00 ? `\\u${code.toString(16)}` : `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

type EntryFormat = 'array' | 'collection' | 'intrinsicCollection' | undefined;

interface Frame {
  /** The text before the braces, such as a function's name. */
  base: string;
  braces: [string, string];
}

// code-gauge-allow functionCognitiveComplexity 21 -- Ports Node.js's util.inspect, so the two stay comparable.
// code-gauge-allow functionNcss 37 -- Ports Node.js's util.inspect, so the two stay comparable.
function formatRaw(ctx: Context, value: JsObject, recurseTimes: number): string {
  const { runtime } = ctx;
  const showsPrototype = ctx.showHidden && recurseTimes <= ctx.depth;
  const constructor = inspectedConstructor(runtime, value, showsPrototype);
  const inherited = showsPrototype && constructor.name ? inspectPrototype(ctx, value, constructor, recurseTimes) : [];
  const name = inspectedName(ctx, value, constructor, recurseTimes);
  const entries = entryFormat(runtime, value, name);
  const display = {
    name,
    entries,
    nullPrototypeName: name === undefined ? runtime.internalConstructorName(value) : undefined,
  };
  if (value.isError && name !== 'Object') noteErrorStack(ctx, value);
  const keys = enumerableKeys(ctx, value, entries === 'array');
  const showsLength = ctx.showHidden && entries === 'array';
  const frame = frameOf(
    ctx,
    value,
    display,
    keys.length > 0 || inherited.length > 0 || value.promise !== undefined || showsLength
  );
  if (typeof frame === 'string') return frame;
  if (recurseTimes > ctx.depth) {
    const prefix = entries === 'array' ? prefixOf(name, 'Array') : objectPrefix(display, toStringTagOf(value));
    const label = prefix.slice(0, -1);
    return name === undefined ? label : stylize(ctx, `[${label}]`, 'special');
  }
  ctx.currentDepth = recurseTimes + 1;
  ctx.seen.add(value);
  try {
    return formatBody(ctx, value, recurseTimes + 1, { frame, keys, inherited, entries });
  } finally {
    ctx.seen.delete(value);
  }
}

function entryFormat(runtime: Runtime, value: JsObject, name: string | undefined): EntryFormat {
  if (value.collection?.isWeak) return 'intrinsicCollection';
  const array = value instanceof JsArray;
  if (!array && !value.collection && !(value.hostIterator instanceof CollectionIterator)) return undefined;
  if (name !== undefined && !runtime.hasProperty(value, WELL_KNOWN_SYMBOLS.iterator)) return undefined;
  if (array) return 'array';
  return name === undefined ? 'intrinsicCollection' : 'collection';
}

interface Body {
  frame: Frame;
  keys: Key[];
  inherited: string[];
  entries: EntryFormat;
}

function formatBody(ctx: Context, value: JsObject, recurseTimes: number, body: Body): string {
  const { frame, keys, inherited, entries } = body;
  const array = entries === 'array' && value instanceof JsArray ? value : undefined;
  let output: string[] = [];
  if (array) output = formatArray(ctx, array, recurseTimes);
  else if (entries) output = formatCollection(ctx, value, recurseTimes, entries === 'collection');
  if (value.promise) output.push(promiseEntry(ctx, value.promise, recurseTimes));
  if (ctx.showHidden && array) output.push(`[length]: ${formatPrimitive(ctx, array.elements.length)}`);
  const properties = keys.map((key) => formatProperty(ctx, value, recurseTimes, key, { arrayExtras: !!array }));
  appendProperties(ctx, value, output, [...properties, ...inherited]);
  ctx.runtime.scan(output.length);
  const reference = ctx.circular.get(value);
  let { base } = frame;
  const braces = [...frame.braces];
  if (reference !== undefined) {
    // The compact layout puts its base after the opening brace, so the reference goes before the brace instead.
    const label = stylize(ctx, `<ref *${reference}>`, 'special');
    if (ctx.compact === true) braces[0] = `${label} ${braces[0]}`;
    else base = base === '' ? label : `${label} ${base}`;
  }
  return reduceToSingleString(ctx, output, base, braces, recurseTimes, array);
}

/**
 * Adds an object's properties after its elements or entries, its own and then the inherited ones `showHidden` lists;
 * `sorted` orders them as text, and a collection's entries with them.
 */
function appendProperties(ctx: Context, value: JsObject, output: string[], properties: string[]): void {
  if (ctx.sorted && value.collection) {
    output.push(...properties);
    sortOutput(ctx, output);
    return;
  }
  if (ctx.sorted) sortOutput(ctx, properties);
  output.push(...properties);
}

/** Sorts entries as Node.js does: by text for `sorted: true`, or with the comparator the program gave. */
function sortOutput(ctx: Context, entries: string[]): void {
  const { runtime, sorted } = ctx;
  if (sorted === true) {
    entries.sort();
    return;
  }
  if (!isCallable(sorted))
    runtime.throwError(
      'TypeError',
      `The comparison function must be either a function or undefined: ${runtime.describePlain(sorted)}`
    );
  entries.sort((a, b) => {
    const order = runtime.toNumber(runtime.call(sorted, undefined, [a, b]));
    return Number.isNaN(order) ? 0 : order;
  });
}

/**
 * Node reads inherited descriptors before collecting the object's own keys, but prints them after its own properties.
 */
// code-gauge-allow functionCognitiveComplexity 17 -- Visits each prototype and reads its eligible descriptors in order.
function inspectPrototype(
  ctx: Context,
  value: JsObject,
  constructor: InspectedConstructor,
  recurseTimes: number
): string[] {
  const { runtime } = ctx;
  const seen = new Set<Key>();
  const output: string[] = [];
  ctx.seen.add(value);
  try {
    for (const current of inspectionPrototypes(runtime, value, constructor)) {
      const keys = inspectionKeys(runtime, current);
      for (const key of keys) {
        if (key === 'constructor' || seen.has(key) || runtime.getOwnProperty(value, key)) continue;
        const property = inspectedProperty(runtime, current, key);
        if (!isAccessor(property) && property.value instanceof JsFunction) continue;
        const text = formatProperty(ctx, current, recurseTimes, key, { receiver: value, property });
        output.push(ctx.colors ? `\u001B[2m${text}\u001B[22m` : text);
      }
      for (const key of keys) seen.add(key);
    }
    return output;
  } finally {
    ctx.seen.delete(value);
  }
}

function* inspectionPrototypes(
  runtime: Runtime,
  value: JsObject,
  constructor: InspectedConstructor
): Iterable<JsObject> {
  const first = constructor.firstPrototype === undefined ? value.proto : constructor.firstPrototype;
  if (!first || constructor.skipPrototype) return;
  let current: JsObject | null = first;
  for (let depth = 0; depth < 3 && current; depth++, current = current.proto) {
    if ((depth > 0 || constructor.owner === value) && hasBuiltinConstructor(runtime, current)) return;
    yield current;
  }
}

function inspectionKeys(runtime: Runtime, object: JsObject): Key[] {
  const strings =
    object instanceof JsArray || typeof object.primitive === 'string'
      ? runtime.ownPropertyNames(object)
      : runtime.ownKeys(object);
  return [...strings, ...runtime.ownSymbols(object)];
}

function hasBuiltinConstructor(runtime: Runtime, object: JsObject): boolean {
  const constructor = constructorProperty(object);
  return constructor !== undefined && isBuiltinConstructorName(runtime.get(constructor, 'name'));
}

function isBuiltinConstructorName(name: Value): boolean {
  return typeof name === 'string' && NODE_BUILTIN_NAMES.has(name);
}

interface DisplayConstructor {
  entries: EntryFormat;
  name: string | undefined;
  nullPrototypeName: string | undefined;
}

/** What surrounds the entries of an object, or its whole text when it has no entries to list. */
// code-gauge-allow functionCognitiveComplexity 28 -- Ports Node.js's util.inspect, so the two stay comparable.
// code-gauge-allow functionNcss 43 -- Ports Node.js's util.inspect, so the two stay comparable.
function frameOf(ctx: Context, value: JsObject, display: DisplayConstructor, hasKeys: boolean): Frame | string {
  const { runtime } = ctx;
  const { name: constructor } = display;
  if (display.entries === 'array' && value instanceof JsArray) {
    const prefix = constructor === 'Array' ? '' : prefixOf(constructor, 'Array', `(${value.elements.length})`);
    return value.elements.length === 0 && !hasKeys ? `${prefix}[]` : { base: '', braces: [`${prefix}[`, ']'] };
  }
  if (display.entries) {
    return collectionFrameOf(value, constructor, hasKeys);
  }
  if (value.turtle) return `Turtle { x: ${value.turtle.x}, y: ${value.turtle.y} }`;
  let base = '';
  let open = '{';
  if (value instanceof JsFunction) base = functionBase(runtime, value, constructor);
  else if (value.regexp) base = stylize(ctx, String(value.regexp), 'regexp');
  else if (dateValueOf(value) !== undefined) base = dateBase(value, constructor);
  else if (value.isError && constructor !== 'Object')
    base = errorText(runtime, value, constructor, ctx.errorStacks.get(value));
  else if (value.primitive !== undefined && !isPrimitivePrototype(runtime, value))
    base = boxedBase(ctx, value.primitive, constructor, toStringTagOf(value), hasKeys);
  else if (value.isArguments) open = '[Arguments] {';
  else {
    const tag = toStringTagOf(value);
    if (tag && tag !== constructor) open = `${objectPrefix(display, tag)}[${tag}] {`;
    else if (constructor !== 'Object') open = `${objectPrefix(display, tag)}{`;
  }
  if (!hasKeys) {
    if (value instanceof JsFunction) return stylize(ctx, base, 'special');
    if (dateValueOf(value) !== undefined) return stylize(ctx, base, 'date');
    return base || `${open}}`;
  }
  return { base, braces: [open, '}'] };
}

function objectPrefix(display: DisplayConstructor, tag: string | undefined): string {
  const fallback = display.nullPrototypeName;
  return prefixOf(display.name, fallback && fallback !== tag ? fallback : 'Object');
}

function isPrimitivePrototype(runtime: Runtime, object: JsObject): boolean {
  const { stringPrototype, numberPrototype, booleanPrototype } = runtime.realm;
  return object === stringPrototype || object === numberPrototype || object === booleanPrototype;
}

/** Reads an error's tag and works out its stack, as Node.js does before checking the error's own keys against it. */
function noteErrorStack(ctx: Context, error: JsObject): void {
  // Node.js ignores what this first read of the tag throws.
  const tag = tryOrUndefined(() => ctx.runtime.get(error, WELL_KNOWN_SYMBOLS.toStringTag));
  const own = error.properties.get(WELL_KNOWN_SYMBOLS.toStringTag);
  ctx.errorStacks.set(error, {
    ...errorStackOf(ctx.runtime, error),
    tag: typeof tag === 'string' && !(tag !== '' && own?.enumerable) ? tag : '',
  });
}

/** Node.js's getBoxedBase, such as `[Number: 3]`, `[BigInt (Big): 1n]`, or `[Symbol: Symbol(a)]`. */
function boxedBase(
  ctx: Context,
  primitive: string | number | boolean | bigint | symbol,
  constructor: string | undefined,
  tag: string | undefined,
  hasKeys: boolean
): string {
  const type = BOXED_TYPES[typeof primitive as keyof typeof BOXED_TYPES];
  let base = `[${type}`;
  if (type !== constructor) base += constructor === undefined ? ' (null prototype)' : ` (${constructor})`;
  base += `: ${formatPrimitive({ ...ctx, colors: false }, primitive)}]`;
  if (tag && tag !== constructor) base += ` [${tag}]`;
  return hasKeys ? base : stylize(ctx, base, typeof primitive);
}

const BOXED_TYPES = {
  string: 'String',
  number: 'Number',
  boolean: 'Boolean',
  bigint: 'BigInt',
  symbol: 'Symbol',
} as const;

/**
 * The `Symbol.toStringTag` an object inherits as a data property, such as a generator's `Generator`, which Node.js
 * shows in brackets; an own enumerable one is listed as a key instead.
 */
function toStringTagOf(object: JsObject): string | undefined {
  const own = object.properties.get(WELL_KNOWN_SYMBOLS.toStringTag);
  if (own?.enumerable) return undefined;
  for (let current: JsObject | null = object; current; current = current.proto) {
    const property = current.properties.get(WELL_KNOWN_SYMBOLS.toStringTag);
    if (property) return !isAccessor(property) && typeof property.value === 'string' ? property.value : undefined;
  }
  return undefined;
}

interface InspectedConstructor {
  name?: () => string;
  owner?: JsObject;
  firstPrototype?: JsObject | null;
  skipPrototype?: boolean;
}

function inspectedName(
  ctx: Context,
  value: JsObject,
  constructor: InspectedConstructor,
  depth: number
): string | undefined {
  if (constructor.name || !constructor.firstPrototype) return constructor.name?.();
  return constructorChainName(ctx, value, constructor.firstPrototype, depth);
}

function constructorChainName(ctx: Context, value: JsObject, prototype: JsObject, depth: number): string {
  const names: string[] = [];
  let length = ctx.budget.used;
  while (true) {
    const name = ctx.runtime.internalConstructorName(value);
    if (depth > ctx.depth) return formatPrototypeNames(names, `${name} <Complex prototype>`);
    length += name.length + 3;
    if (length > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
    names.push(name);
    const next = inspectedConstructor(ctx.runtime, prototype);
    if (next.name) return formatPrototypeNames(names, next.name());
    if (!next.firstPrototype) {
      const preview = inspectValue(ctx.runtime, prototype, ctx.budget, -1, ctx);
      return formatPrototypeNames(names, preview);
    }
    value = prototype;
    prototype = next.firstPrototype;
    depth++;
  }
}

function formatPrototypeNames(names: string[], tail: string): string {
  return [...names, tail].join(' <') + '>'.repeat(names.length);
}

function inspectedConstructor(runtime: Runtime, object: JsObject, showsPrototype = false): InspectedConstructor {
  const known = knownConstructors(runtime.realm);
  let firstPrototype: JsObject | null | undefined;
  for (let current: JsObject | null = object; current; current = current.proto) {
    runtime.spend();
    const knownName = current === object ? undefined : known.get(current);
    if (knownName)
      return { name: () => knownName, owner: current, firstPrototype, skipPrototype: current === firstPrototype };
    const constructor = constructorProperty(current);
    if (
      constructor &&
      runtime.get(constructor, 'name') !== '' &&
      tryOrUndefined(() => runtime.instanceOf(object, constructor))
    )
      return {
        name: () => constructorDisplayName(runtime, constructor),
        owner: current,
        firstPrototype,
        skipPrototype:
          showsPrototype && current === firstPrototype && isBuiltinConstructorName(runtime.get(constructor, 'name')),
      };
    if (current === object) firstPrototype = current.proto;
  }
  return { firstPrototype };
}

function constructorDisplayName(runtime: Runtime, constructor: JsFunction): string {
  const name = runtime.get(constructor, 'name');
  return typeof name === 'symbol' ? name.toString() : runtime.toString(name);
}

function constructorProperty(object: JsObject): JsFunction | undefined {
  const property = object.properties.get('constructor');
  return property && !isAccessor(property) && property.value instanceof JsFunction ? property.value : undefined;
}

function knownConstructors(realm: Realm): Map<JsObject, string> {
  let known = knownConstructorsByRealm.get(realm);
  if (!known) {
    known = new Map([
      [realm.arrayPrototype, 'Array'],
      [realm.booleanPrototype, 'Boolean'],
      [realm.datePrototype, 'Date'],
      [realm.errorPrototypes.AggregateError, 'AggregateError'],
      [realm.errorPrototypes.Error, 'Error'],
      [realm.errorPrototypes.RangeError, 'RangeError'],
      [realm.errorPrototypes.TypeError, 'TypeError'],
      [realm.functionPrototype, 'Function'],
      [realm.mapPrototype, 'Map'],
      [realm.numberPrototype, 'Number'],
      [realm.objectPrototype, 'Object'],
      [realm.promisePrototype, 'Promise'],
      [realm.regExpPrototype, 'RegExp'],
      [realm.setPrototype, 'Set'],
      [realm.stringPrototype, 'String'],
    ]);
    knownConstructorsByRealm.set(realm, known);
  }
  return known;
}

function prefixOf(constructor: string | undefined, fallback: string, size = ''): string {
  return constructor === undefined ? `[${fallback}${size}: null prototype] ` : `${constructor}${size} `;
}

/** The keys an object shows: its enumerable ones, or with `showHidden` all of its own, as `%o` shows them. */
const ERROR_KEYS = new Set<Key>(['name', 'message', 'stack']);

// code-gauge-allow functionCognitiveComplexity 17 -- Lists the own keys exposed by each inspected value, including hidden string lengths and error causes.
function enumerableKeys(ctx: Context, object: JsObject, arrayExtras: boolean): Key[] {
  const { runtime, showHidden } = ctx;
  const stack = ctx.errorStacks.get(object);
  const own = arrayExtras
    ? [...object.properties.keys()].filter((key) => typeof key === 'string')
    : showHidden
      ? runtime.ownPropertyNames(object)
      : runtime.ownKeys(object);
  // A String object's indices, which come first, show as its text instead.
  const strings = typeof object.primitive === 'string' ? own.slice(object.primitive.length) : own;
  const keys: Key[] = [...strings, ...runtime.ownSymbols(object)];
  const listed = keys.filter((key) => {
    if (object.isError && ERROR_KEYS.has(key) && (showHidden || !stack || isInStack(object, key, stack))) return false;
    return showHidden || runtime.getOwnProperty(object, key)?.enumerable;
  });
  // An error also shows its own hidden reasons, bracketed, as Node.js does.
  if (object.isError) {
    for (const key of ['error', 'suppressed', 'cause', 'errors']) {
      if (object.properties.has(key) && !listed.includes(key)) listed.push(key);
    }
  }
  return listed;
}

/**
 * How Node.js names a function: its kind and name, with `(null prototype)` without a constructor and the constructor's
 * name after it when that is not a function's, as for `Function.prototype`, whose constructor is `Object`.
 */
function functionBase(runtime: Runtime, fn: JsFunction, constructor: string | undefined): string {
  const name = runtime.functionName(fn);
  if (fn.behavior.kind !== 'class') return plainFunctionBase(fn, name, constructor);
  const superName = fn.proto instanceof JsFunction ? runtime.functionName(fn.proto) : '';
  return `[class ${name || '(anonymous)'}${superName ? ` extends ${superName}` : ''}]`;
}

function plainFunctionBase(fn: JsFunction, name: string, constructor: string | undefined): string {
  const node = fn.behavior.kind === 'user' ? fn.behavior.node : undefined;
  const kind = `${node?.isAsync ? 'Async' : ''}${node?.isGenerator ? 'Generator' : ''}Function`;
  const prototype = constructor === undefined ? ' (null prototype)' : '';
  const base = name ? `[${kind}${prototype}: ${name}]` : `[${kind}${prototype} (anonymous)]`;
  return constructor === undefined || constructor === kind || constructor === 'Function'
    ? base
    : `${base} ${constructor}`;
}

/** Node.js formats uncaught errors from the saved stack using the same name rules as util.inspect. */
export function uncaughtErrorHeadline(runtime: Runtime, error: JsObject): string {
  const { name, firstPrototype } = inspectedConstructor(runtime, error);
  const constructor = name?.();
  return constructor === 'Object' || (!name && firstPrototype)
    ? inspect(runtime, error)
    : errorText(runtime, error, constructor);
}

/**
 * The first line of an error's stack, which V8 formats from its `name` and `message` when first read, and which
 * Node.js then improves with the `name` it reads again.
 */
function errorText(
  runtime: Runtime,
  error: JsObject,
  constructor: string | undefined,
  stack = errorStackOf(runtime, error)
): string {
  if (stack.kind === 'tag') return stack.text;
  const improvedName = readIgnoringThrows(runtime, error, 'name');
  // Node.js also reads the message on each print, which a getter observes.
  readIgnoringThrows(runtime, error, 'message');
  if (stack.kind === 'string') return stack.text;
  const text = stack.text;
  if (improvedName === undefined || improvedName === null)
    return improveErrorName(text, 'Error', constructor, stack.tag);
  if (typeof improvedName === 'string') return improveErrorName(text, improvedName, constructor, stack.tag);
  // Node.js marks a name that is not a string with the error's class, as `42 [Error]: bad`.
  const shown = runtime.toString(improvedName);
  return text.replace(shown, `${shown} [${constructor ?? 'Error'}]`);
}

/**
 * Whether Node.js leaves out an error's own `name`, `message`, or `stack`: a hidden one, or a data property that is not
 * a string or that the stack's first line already shows, which a change after the error was first printed does not
 * reach; an accessor stays listed without being called.
 */
function isInStack(error: JsObject, key: Key, stack: ErrorStack): boolean {
  const property = error.properties.get(key);
  if (!property?.enumerable) return true;
  if (isAccessor(property)) return false;
  return typeof property.value !== 'string' || stack.text.includes(property.value);
}

/**
 * What Node.js prints for an error's stack: the first line V8 formats, or without one `Error.prototype.toString`'s
 * text bracketed, or failing that `Object.prototype.toString`'s tag.
 */
interface ErrorStack {
  kind: 'stack' | 'string' | 'tag';
  text: string;
  /** The `Symbol.toStringTag` Node.js shows beside the class, unless an own enumerable one lists it as a key. */
  tag?: string;
}

function errorStackOf(runtime: Runtime, error: JsObject): ErrorStack {
  const headline = headlineOf(runtime, error);
  if (headline !== undefined) return { kind: 'stack', text: headline };
  const text = tryOrUndefined(() => v8Headline(runtime, error));
  return text === undefined
    ? { kind: 'tag', text: objectToString(runtime, error) }
    : { kind: 'string', text: `[${text}]` };
}

/**
 * An error's first stack line, formatted when first needed and kept, or undefined while its `name` or `message`
 * throws, which V8 tries again on the next print.
 */
function headlineOf(runtime: Runtime, error: JsObject): string | undefined {
  try {
    error.stackHeadline ??= v8Headline(runtime, error);
  } catch (formatError) {
    if (!(formatError instanceof JsThrow)) throw formatError;
  }
  return error.stackHeadline;
}

function readIgnoringThrows(runtime: Runtime, object: JsObject, key: Key): Value {
  return tryOrUndefined(() => runtime.get(object, key));
}

/** What `run` returns, or undefined when the program's code it runs throws. */
function tryOrUndefined<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    return undefined;
  }
}

function v8Headline(runtime: Runtime, error: JsObject): string {
  const coded = runtime.nodeErrorHeadline(error);
  if (coded !== undefined) return coded;
  const name = runtime.get(error, 'name');
  const message = runtime.get(error, 'message');
  const nameText = name === undefined ? 'Error' : runtime.toString(name);
  const messageText = message === undefined ? '' : runtime.toString(message);
  return nameText === '' ? messageText : messageText === '' ? nameText : `${nameText}: ${messageText}`;
}

/**
 * Node.js's improveStack: an error whose class differs from its `name`, such as `class NotFound extends Error {}`,
 * shows its class, as `NotFound [Error]: missing`, or only its class when that contains the name, as
 * `MyError: missing`.
 */
function improveErrorName(text: string, name: string, constructor: string | undefined, tag = ''): string {
  if (constructor === undefined) return nullPrototypeErrorName(text, name, tag);
  const looksNormal =
    name.endsWith('Error') && text.startsWith(name) && (text.length === name.length || text[name.length] === ':');
  const prototype = tag !== '' && tag !== constructor ? `${constructor} [${tag}]` : constructor;
  if (!looksNormal || name === prototype) return text;
  return prototype.includes(name)
    ? `${prototype}${text.slice(name.length)}`
    : `${prototype} [${name}]${text.slice(name.length)}`;
}

/**
 * Node.js's improveStack for an error without a prototype: the name its stack starts with, as `TypeError`, becomes
 * `[TypeError: null prototype]`, which leads the text when the stack names none.
 */
function nullPrototypeErrorName(text: string, name: string, tag: string): string {
  const start = /^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n\s+at)/.exec(text) ?? /^([a-z_A-Z0-9-]*Error)$/.exec(text);
  const fallback = start?.[1] ?? '';
  const prototype = `[${fallback || 'Error'}: null prototype]${tag === '' ? '' : ` [${tag}]`}`;
  if (name === prototype) return text;
  if (!prototype.includes(name)) return `${prototype} [${name}]${text.slice(fallback.length)}`;
  return fallback === '' ? `${prototype}: ${text}` : `${prototype}${text.slice(fallback.length)}`;
}

function showsGetter(ctx: Context, property: AccessorProperty): boolean {
  if (!property.get || !ctx.getters) return false;
  return ctx.getters === true || (ctx.getters === 'set') === (property.set !== undefined);
}

/** Node.js's `getters` option: the value a getter returns after its label, or the error it threw. */
function gotText(ctx: Context, object: JsObject, property: AccessorProperty, recurseTimes: number): string {
  const label = property.set ? 'Getter/Setter' : 'Getter';
  try {
    const value = ctx.runtime.call(property.get, object, []);
    if (isObject(value)) return `${stylize(ctx, `[${label}]`, 'special')} ${formatIndented(ctx, value, recurseTimes)}`;
    return getterResult(ctx, label, formatIndented(ctx, value, recurseTimes));
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    return getterResult(ctx, label, `<Inspection threw (${formatIndented(ctx, error.value, recurseTimes)})>`);
  }
}

function getterResult(ctx: Context, label: string, text: string): string {
  return `${stylize(ctx, `[${label}:`, 'special')} ${text}${stylize(ctx, ']', 'special')}`;
}

function accessorText(ctx: Context, property: AccessorProperty): string {
  if (property.get) return stylize(ctx, property.set ? '[Getter/Setter]' : '[Getter]', 'special');
  return property.set ? stylize(ctx, '[Setter]', 'special') : stylize(ctx, 'undefined', 'undefined');
}

function formatArray(ctx: Context, array: JsArray, recurseTimes: number): string[] {
  const length = array.elements.length;
  const limit = Math.min(length, ctx.maxArrayLength);
  const output: string[] = [];
  for (let index = 0; index < limit; index++) {
    const property = ctx.runtime.getOwnProperty(array, String(index));
    if (!property) return formatSparseArray(ctx, array, recurseTimes, limit, output, index);
    output.push(formatArrayProperty(ctx, array, property, recurseTimes));
  }
  if (length > limit) output.push(remainingArrayItems(length - limit));
  return output;
}

function formatSparseArray(
  ctx: Context,
  array: JsArray,
  recurseTimes: number,
  limit: number,
  output: string[],
  start: number
): string[] {
  const keys = ctx.runtime.ownEnumerableKeys(array);
  let index = start;
  for (let position = start; position < keys.length && output.length < limit; position++) {
    const key = keys[position];
    const current = arrayIndexOf(key);
    if (current === undefined) break;
    if (current !== index) {
      output.push(emptyArrayItems(ctx, current - index));
      index = current;
      if (output.length === limit) break;
    }
    const property = inspectedProperty(ctx.runtime, array, key);
    output.push(formatArrayProperty(ctx, array, property, recurseTimes));
    index++;
  }
  const remaining = array.elements.length - index;
  if (remaining > 0)
    output.push(output.length === limit ? remainingArrayItems(remaining) : emptyArrayItems(ctx, remaining));
  return output;
}

function formatArrayProperty(ctx: Context, array: JsArray, property: Property, recurseTimes: number): string {
  return isAccessor(property)
    ? formatAccessor(ctx, array, property, recurseTimes)
    : formatIndented(ctx, property.value, recurseTimes);
}

function emptyArrayItems(ctx: Context, count: number): string {
  return stylize(ctx, `<${count} empty item${count > 1 ? 's' : ''}>`, 'undefined');
}

function remainingArrayItems(count: number): string {
  return `... ${count} more item${count > 1 ? 's' : ''}`;
}

/** A Date's ISO string, after the name of its constructor when that is not Date. */
function dateBase(value: JsObject, constructor: string | undefined): string {
  const text = inspectDate(dateValueOf(value) as number);
  const prefix = prefixOf(constructor, 'Date');
  return prefix === 'Date ' ? text : `${prefix}${text}`;
}

/** What surrounds the entries of a Map, Set, WeakMap, WeakSet, or an iterator over a Map or Set. */
function collectionFrameOf(value: JsObject, constructor: string | undefined, hasKeys: boolean): Frame | string {
  const tag = toStringTagOf(value) ?? '';
  const iterator = value.hostIterator;
  if (iterator instanceof CollectionIterator) {
    const type = `${iterator.state.kind} Iterator`;
    const open = tag === type ? `[${tag}] {` : `[${tag ? `${tag}] [` : ''}${type}] {`;
    return {
      base: '',
      braces: [iterator.kind === 'entries' ? open.replace(/ Iterator] \{$/, ' Entries] {') : open, '}'],
    };
  }
  const state = value.collection as NonNullable<JsObject['collection']>;
  let prefix = prefixOf(constructor, state.kind, state.isWeak ? '' : `(${state.size})`);
  if (tag && tag !== (constructor ?? state.kind)) prefix += `[${tag}] `;
  if (!state.isWeak && state.size === 0 && !hasKeys) return `${prefix}{}`;
  return { base: '', braces: [`${prefix}{`, '}'] };
}

function formatCollection(ctx: Context, value: JsObject, depth: number, visible: boolean): string[] {
  const iterator = value.hostIterator;
  const state = value.collection;
  ctx.indentationLvl += 2;
  try {
    if (iterator instanceof CollectionIterator) return previewCollectionIterator(ctx, iterator, depth);
    if (!state) return [];
    if (state.isWeak) return ['<items unknown>'];
    if (visible) return formatVisibleCollection(ctx, value, depth, state.kind === 'Map');
    const cursor = state.cursor();
    const output: string[] = [];
    for (let entry = cursor.next(ctx.runtime); entry; entry = cursor.next(ctx.runtime)) {
      output.push(formatCollectionEntry(ctx, entry, depth, state.kind === 'Map'));
    }
    return output;
  } finally {
    ctx.indentationLvl -= 2;
  }
}

function formatVisibleCollection(ctx: Context, value: JsObject, depth: number, map: boolean): string[] {
  const { runtime } = ctx;
  const size = runtime.get(value, 'size');
  const limit = Math.min(runtime.toNumber(size), ctx.maxArrayLength);
  const remaining = runtime.toNumber(size) - limit;
  const iterator = runtime.iterator(value, undefined, { text: 'value' }, 'forOf');
  return closingOnThrow(iterator, () => {
    const output: string[] = [];
    for (let item = iterator.next(); item !== DONE; item = iterator.next()) {
      const entry = map ? readMapEntry(runtime, item) : undefined;
      if (output.length >= limit) {
        iterator.close();
        break;
      }
      output.push(entry ? formatCollectionEntry(ctx, entry, depth, true) : formatCharged(ctx, item, depth));
    }
    if (remaining > 0) output.push(remainingArrayItems(remaining));
    return output;
  });
}

function readMapEntry(runtime: Runtime, item: Value): CollectionEntry {
  if (item === undefined || item === null)
    runtime.throwError('TypeError', `Cannot destructure property '0' of '.for' as it is ${String(item)}.`);
  return { key: runtime.get(item, '0'), value: runtime.get(item, '1') };
}

function formatCollectionEntry(ctx: Context, entry: CollectionEntry, depth: number, map: boolean): string {
  const key = formatCharged(ctx, entry.key, depth);
  return map ? `${key} => ${formatCharged(ctx, entry.value, depth)}` : key;
}

function previewCollectionIterator(ctx: Context, iterator: CollectionIterator, depth: number): string[] {
  const entries = iterator.remainingEntries();
  const limit = Math.min(entries.length, ctx.maxArrayLength);
  if (!Number.isInteger(limit)) ctx.runtime.throwError('RangeError', 'Invalid array length');
  const output = entries.slice(0, limit).map((entry) => formatIteratorEntry(ctx, entry, iterator.kind, depth));
  if (entries.length > limit) output.push(remainingArrayItems(entries.length - limit));
  return output;
}

function formatIteratorEntry(
  ctx: Context,
  entry: CollectionEntry,
  kind: CollectionIterator['kind'],
  depth: number
): string {
  if (kind !== 'entries') return formatCharged(ctx, kind === 'keys' ? entry.key : entry.value, depth);
  const pair = [formatCharged(ctx, entry.key, depth), formatCharged(ctx, entry.value, depth)];
  return reduceToSingleString(ctx, pair, '', ['[', ']'], depth);
}

/** What a promise shows before its properties: `<pending>`, its value, or `<rejected>` and its reason. */
function promiseEntry(ctx: Context, state: PromiseState, recurseTimes: number): string {
  if (state.status === 'pending') return stylize(ctx, '<pending>', 'special');
  const result = formatIndented(ctx, state.result, recurseTimes);
  return state.status === 'rejected' ? `${stylize(ctx, '<rejected>', 'special')} ${result}` : result;
}

interface PropertyLayout {
  receiver?: JsObject;
  property?: Property;
  arrayExtras?: boolean;
}

function formatProperty(
  ctx: Context,
  object: JsObject,
  recurseTimes: number,
  key: Key,
  { receiver = object, property = inspectedProperty(ctx.runtime, object, key), arrayExtras }: PropertyLayout = {}
): string {
  const name = inspectionPropertyName(ctx, key);
  const label = property.enumerable ? name : `[${name}]`;
  if (isAccessor(property)) return `${label}: ${formatAccessor(ctx, receiver, property, recurseTimes)}`;
  // The compact layout indents an object's values one more and moves a value too wide for a line to the next.
  const diff = ctx.compact === true && !arrayExtras ? 3 : 2;
  const text = formatIndented(ctx, ctx.runtime.readPropertyValue(property), recurseTimes, diff);
  const separator =
    diff === 3 && ctx.breakLength < (ctx.colors ? stringWidth(unstyled(ctx, text)) : text.length)
      ? `\n${' '.repeat(ctx.indentationLvl + diff)}`
      : ' ';
  return `${label}:${separator}${text}`;
}

function inspectedProperty(runtime: Runtime, object: JsObject, key: Key): Property {
  return (
    runtime.getOwnProperty(object, key) ??
    runtime.throwError('TypeError', "Cannot read properties of undefined (reading 'value')")
  );
}

function inspectionPropertyName(ctx: Context, key: Key): string {
  if (typeof key === 'symbol') return stylize(ctx, escapeControls(key.toString()), 'symbol');
  if (!KEY_PATTERN.test(key)) return stylize(ctx, quote(key), 'string');
  return key === '__proto__' ? "['__proto__']" : key;
}

function formatIndented(ctx: Context, value: Value, recurseTimes: number, diff = 2): string {
  ctx.indentationLvl += diff;
  try {
    return formatCharged(ctx, value, recurseTimes);
  } finally {
    ctx.indentationLvl -= diff;
  }
}

// code-gauge-allow functionCognitiveComplexity 29 -- Ports Node.js's util.inspect, so the two stay comparable.
function reduceToSingleString(
  ctx: Context,
  output: string[],
  base: string,
  braces: string[],
  recurseTimes: number,
  array?: JsArray
): string {
  const basePrefix = base ? `${base} ` : '';
  const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
  if (ctx.compact !== true) {
    if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
      const entries = output.length;
      if (array && entries > 6) output = groupArrayElements(ctx, output, array);
      if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
        // Node.js adds 10 to leave room for what may shorten the line in other places.
        const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
        if (isBelowBreakLength(ctx, output, start, base)) {
          const joined = output.join(', ');
          if (!joined.includes('\n')) return `${basePrefix}${braces[0]} ${joined} ${braces[1]}`;
        }
      }
    }
    return `${basePrefix}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
  }
  // `compact: true` puts as much as fits after the opening brace, as Node.js's older layout does.
  if (isBelowBreakLength(ctx, output, 0, base)) {
    return `${braces[0]}${base ? ` ${base}` : ''} ${output.join(', ')} ${braces[1]}`;
  }
  const lead = base === '' && braces[0].length === 1 ? ' ' : `${base ? ` ${base}` : ''}${indentation}  `;
  return `${braces[0]}${lead}${output.join(`,${indentation}  `)} ${braces[1]}`;
}

function isBelowBreakLength(ctx: Context, output: string[], start: number, base: string): boolean {
  let totalLength = output.length + start;
  if (totalLength + output.length > ctx.breakLength) return false;
  for (const entry of output) {
    totalLength += unstyled(ctx, entry).length;
    if (totalLength > ctx.breakLength) return false;
  }
  return !base.includes('\n');
}

/** Lays out the entries of a long array in aligned columns. */
// code-gauge-allow functionCognitiveComplexity 21 -- Ports Node.js's groupArrayElements as it is, so the two stay comparable.
// code-gauge-allow functionNcss 41 -- Ports Node.js's groupArrayElements as it is, so the two stay comparable.
function groupArrayElements(ctx: Context, output: string[], array: JsArray): string[] {
  let totalLength = 0;
  let maxLength = 0;
  const outputLength = output.length > ctx.maxArrayLength ? output.length - 1 : output.length;
  const separatorSpace = 2;
  const dataLength: number[] = [];
  for (let i = 0; i < outputLength; i++) {
    const length = stringWidth(unstyled(ctx, output[i]));
    dataLength.push(length);
    totalLength += length + separatorSpace;
    if (maxLength < length) maxLength = length;
  }
  const actualMax = maxLength + separatorSpace;
  if (actualMax * 3 + ctx.indentationLvl >= ctx.breakLength || (totalLength / actualMax <= 5 && maxLength > 6)) {
    return output;
  }
  const approxCharHeights = 2.5;
  const averageBias = Math.sqrt(actualMax - totalLength / output.length);
  const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
  const columns = Math.min(
    Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
    Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
    (ctx.compact as number) * 4,
    15
  );
  if (columns <= 1) return output;
  const maxLineLength: number[] = [];
  for (let i = 0; i < columns; i++) {
    let lineMaxLength = 0;
    for (let j = i; j < output.length; j += columns) lineMaxLength = Math.max(lineMaxLength, dataLength[j] ?? 0);
    maxLineLength.push(lineMaxLength + separatorSpace);
  }
  const padStart = output.every(
    (_, i) => typeof array.elements[i] === 'number' || typeof array.elements[i] === 'bigint'
  );
  const grouped: string[] = [];
  for (let i = 0; i < outputLength; i += columns) {
    const max = Math.min(i + columns, outputLength);
    let line = '';
    let j = i;
    for (; j < max - 1; j++) {
      const padding = maxLineLength[j - i] + output[j].length - dataLength[j];
      line += padStart ? `${output[j]}, `.padStart(padding) : `${output[j]}, `.padEnd(padding);
    }
    line += padStart
      ? output[j].padStart(maxLineLength[j - i] + output[j].length - dataLength[j] - separatorSpace)
      : output[j];
    grouped.push(line);
  }
  if (output.length > ctx.maxArrayLength) grouped.push(output[outputLength]);
  return grouped;
}

/**
 * The columns a terminal shows the text in, as Node.js counts them with ICU, code point by code point: nothing for
 * control characters and marks, two for East Asian wide and fullwidth characters and emoji shown as emoji, and one
 * otherwise.
 */
export function stringWidth(text: string): number {
  let width = 0;
  for (const character of text.normalize('NFC')) width += columnWidth(character.codePointAt(0) ?? 0, character);
  return width;
}

const ZERO_WIDTH = /^[\p{Cc}\p{Cf}\p{Me}\p{Mn}]$/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;

function columnWidth(code: number, character: string): number {
  if (code !== 0xad && ZERO_WIDTH.test(character)) return 0;
  const type = eastAsianWidthType(code);
  if (type === 'fullwidth' || type === 'wide') return 2;
  if ((type === 'ambiguous' || type === 'neutral') && EMOJI_PRESENTATION.test(character)) return 2;
  return 1;
}

function formatAccessor(ctx: Context, object: JsObject, property: AccessorProperty, recurseTimes: number): string {
  return showsGetter(ctx, property) ? gotText(ctx, object, property, recurseTimes) : accessorText(ctx, property);
}
