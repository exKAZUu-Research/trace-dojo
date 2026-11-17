// code-gauge-allow-file fileNcss 518 -- One port of Node.js's util.inspect, whose formatters share its context.
import { eastAsianWidthType } from 'get-east-asian-width';

import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { PromiseState } from './promises';
import { type CollectionEntry, CollectionIterator } from './realmCollections';
import { dateValueOf, inspectDate } from './realmDate';
import { objectToString } from './realmGlobals';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  type AccessorProperty,
  HOLE,
  isAccessor,
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
  /** As `util.inspect`'s options of the same names. */
  sorted: boolean;
  getters: boolean | 'get' | 'set';
  numericSeparator: boolean;
  maxStringLength: number;
}

/** The `util.inspect` options `console.dir` takes. */
export interface InspectOptions {
  depth?: number;
  breakLength?: number;
  compact?: number | boolean;
  maxArrayLength?: number;
  showHidden?: boolean;
  sorted?: boolean;
  getters?: boolean | 'get' | 'set';
  numericSeparator?: boolean;
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
    maxStringLength: Math.max(0, options.maxStringLength ?? MAX_STRING_LENGTH),
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
  if (typeof value === 'string') return formatString(ctx, value);
  if (typeof value === 'number')
    return ctx.numericSeparator ? separateDigits(formatNumber(value)) : formatNumber(value);
  if (typeof value === 'bigint') return `${ctx.numericSeparator ? separateDigits(String(value)) : value}n`;
  if (!(value instanceof JsObject)) return String(value);
  if (ctx.seen.has(value)) {
    let index = ctx.circular.get(value);
    if (index === undefined) {
      index = ctx.circular.size + 1;
      ctx.circular.set(value, index);
    }
    return `[Circular *${index}]`;
  }
  return formatRaw(ctx, value, recurseTimes);
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
        .map((line) => quote(line))
        .join(` +\n${' '.repeat(ctx.indentationLvl + 2)}`) + trailer
    );
  }
  return quote(value) + trailer;
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

interface Frame {
  /** The text before the braces, such as a function's name. */
  base: string;
  braces: [string, string];
}

// code-gauge-allow functionCognitiveComplexity 21 -- Ports Node.js's util.inspect, so the two stay comparable.
// code-gauge-allow functionNcss 37 -- Ports Node.js's util.inspect, so the two stay comparable.
function formatRaw(ctx: Context, value: JsObject, recurseTimes: number): string {
  const { runtime } = ctx;
  const constructor = constructorName(runtime, value);
  if (value.isError && constructor !== 'Object') noteErrorStack(ctx, value);
  const keys = enumerableKeys(runtime, value, ctx.showHidden, ctx.errorStacks.get(value));
  const showsLength = ctx.showHidden && value instanceof JsArray;
  const inherited = ctx.showHidden ? inheritedKeys(value) : [];
  const frame = frameOf(
    ctx,
    value,
    constructor,
    keys.length > 0 || inherited.length > 0 || value.promise !== undefined || showsLength
  );
  if (typeof frame === 'string') return frame;
  if (recurseTimes > ctx.depth) {
    const name = prefixOf(constructor, value instanceof JsArray ? 'Array' : 'Object').slice(0, -1);
    return constructor === undefined ? name : `[${name}]`;
  }
  recurseTimes++;
  ctx.seen.add(value);
  ctx.currentDepth = recurseTimes;
  const output =
    value instanceof JsArray ? formatArray(ctx, value, recurseTimes) : formatCollection(ctx, value, recurseTimes);
  if (value.promise) output.push(promiseEntry(ctx, value.promise, recurseTimes));
  if (showsLength) output.push(`[length]: ${formatNumber((value as JsArray).elements.length)}`);
  const properties = keys.map((key) => formatProperty(ctx, value, recurseTimes, key));
  for (const [owner, key] of inherited) properties.push(formatProperty(ctx, owner, recurseTimes, key));
  // `sorted` orders the properties as text, after an array's elements, and a collection's entries with them.
  if (ctx.sorted && value.collection) {
    output.push(...properties);
    output.sort();
  } else {
    if (ctx.sorted) properties.sort();
    output.push(...properties);
  }
  runtime.scan(output.length);
  const reference = ctx.circular.get(value);
  let { base } = frame;
  const braces = [...frame.braces];
  if (reference !== undefined) {
    // The compact layout puts its base after the opening brace, so the reference goes before the brace instead.
    const label = `<ref *${reference}>`;
    if (ctx.compact === true) braces[0] = `${label} ${braces[0]}`;
    else base = base === '' ? label : `${label} ${base}`;
  }
  ctx.seen.delete(value);
  return reduceToSingleString(ctx, output, base, braces, recurseTimes, value);
}

/**
 * The data properties and accessors an object inherits from the prototypes its own class adds, with the prototype
 * holding each, which Node.js's `showHidden` lists after its own: up to three prototypes, stopping at a builtin one,
 * without methods, `constructor`, or keys a nearer object has.
 */
function inheritedKeys(value: JsObject): [JsObject, Key][] {
  const seen = new Set<Key>(value.properties.keys());
  const found: [JsObject, Key][] = [];
  let current: JsObject | undefined = firstOwnPrototype(value);
  for (let depth = 0; depth < 3 && current && !isBuiltinPrototype(current); depth++) {
    const keys = [...current.properties.keys()];
    for (const key of keys) {
      const property = current.properties.get(key) as Property;
      if (key === 'constructor' || seen.has(key)) continue;
      if (!isAccessor(property) && property.value instanceof JsFunction) continue;
      found.push([current, key]);
    }
    for (const key of keys) seen.add(key);
    current = current.proto ?? undefined;
  }
  return found;
}

/** The prototype Node.js starts listing inherited properties from: the object's own one, unless that is a builtin's. */
function firstOwnPrototype(value: JsObject): JsObject | undefined {
  const first = value.proto;
  return first && !isBuiltinPrototype(first) ? first : undefined;
}

function isBuiltinPrototype(object: JsObject): boolean {
  const constructor = object.properties.get('constructor');
  return (
    constructor !== undefined &&
    !isAccessor(constructor) &&
    constructor.value instanceof JsFunction &&
    constructor.value.behavior.kind === 'native'
  );
}

/** What surrounds the entries of an object, or its whole text when it has no entries to list. */
// code-gauge-allow functionCognitiveComplexity 23 -- Ports Node.js's util.inspect, so the two stay comparable.
// code-gauge-allow functionNcss 39 -- Ports Node.js's util.inspect, so the two stay comparable.
function frameOf(ctx: Context, value: JsObject, constructor: string | undefined, hasKeys: boolean): Frame | string {
  const { runtime } = ctx;
  if (value instanceof JsArray) {
    const prefix = constructor === 'Array' ? '' : prefixOf(constructor, 'Array', `(${value.elements.length})`);
    return value.elements.length === 0 && !hasKeys ? `${prefix}[]` : { base: '', braces: [`${prefix}[`, ']'] };
  }
  if (value.collection || value.hostIterator instanceof CollectionIterator) {
    return collectionFrameOf(value, constructor, hasKeys);
  }
  if (value.turtle) return `Turtle { x: ${value.turtle.x}, y: ${value.turtle.y} }`;
  let base = '';
  let open = '{';
  if (value instanceof JsFunction) base = functionBase(runtime, value, constructor);
  else if (value.regexp) base = String(value.regexp);
  else if (dateValueOf(value) !== undefined) base = dateBase(value, constructor);
  else if (value.isError && constructor !== 'Object')
    base = errorText(runtime, value, constructor, ctx.errorStacks.get(value));
  else if (value.primitive !== undefined) base = boxedBase(ctx, value.primitive, constructor, toStringTagOf(value));
  else if (value.isArguments) open = '[Arguments] {';
  else {
    const tag = toStringTagOf(value);
    const fallback = value.className ?? 'Object';
    if (tag && tag !== constructor) open = `${prefixOf(constructor, fallback)}[${tag}] {`;
    else if (constructor !== 'Object') open = `${prefixOf(constructor, fallback)}{`;
  }
  if (!hasKeys) return base || `${open}}`;
  return { base, braces: [open, '}'] };
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
  tag: string | undefined
): string {
  const type = BOXED_TYPES[typeof primitive as keyof typeof BOXED_TYPES];
  let base = `[${type}`;
  if (type !== constructor) base += constructor === undefined ? ' (null prototype)' : ` (${constructor})`;
  base += `: ${typeof primitive === 'string' ? formatString(ctx, primitive) : formatValue(ctx, primitive, 0)}]`;
  if (tag && tag !== constructor) base += ` [${tag}]`;
  return base;
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

/** The name of the nearest constructor whose prototype the object inherits, or undefined for a null prototype. */
function constructorName(runtime: Runtime, object: JsObject): string | undefined {
  for (let current: JsObject | null = object; current; current = current.proto) {
    const property = current.properties.get('constructor');
    if (!property || isAccessor(property) || !(property.value instanceof JsFunction)) continue;
    const name = runtime.functionName(property.value);
    if (name && inheritsPrototypeOf(object, property.value)) return name;
  }
  return object.proto ? 'Object' : undefined;
}

function inheritsPrototypeOf(object: JsObject, fn: JsFunction): boolean {
  const prototype = fn.properties.get('prototype');
  if (!prototype || isAccessor(prototype)) return false;
  for (let current = object.proto; current; current = current.proto) if (current === prototype.value) return true;
  return false;
}

function prefixOf(constructor: string | undefined, fallback: string, size = ''): string {
  return constructor === undefined ? `[${fallback}${size}: null prototype] ` : `${constructor}${size} `;
}

/** The keys an object shows: its enumerable ones, or with `showHidden` all of its own, as `%o` shows them. */
const ERROR_KEYS = new Set<Key>(['name', 'message', 'stack']);

function enumerableKeys(runtime: Runtime, object: JsObject, showHidden: boolean, stack?: ErrorStack): Key[] {
  // An array keeps its elements apart from its other properties.
  const own =
    object instanceof JsArray
      ? [...object.properties.keys()].filter((key) => typeof key === 'string')
      : runtime.ownKeys(object);
  // A String object's indices, which come first, show as its text instead.
  const strings = typeof object.primitive === 'string' ? own.slice(object.primitive.length) : own;
  const keys: Key[] = [...strings, ...runtime.ownSymbols(object)];
  const listed = keys.filter((key) => {
    if (object.isError && ERROR_KEYS.has(key) && (showHidden || !stack || isInStack(object, key, stack))) return false;
    return showHidden || object.properties.get(key)?.enumerable;
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

/**
 * The first line Node.js prints for an error, such as `MyError: missing`; the stack lines that follow it, with the
 * error's own properties, name places on the host, which a program here does not have.
 */
export function errorHeadline(runtime: Runtime, error: JsObject): string {
  return errorText(runtime, error, constructorName(runtime, error));
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
  const looksNormal =
    constructor === undefined ||
    (name.endsWith('Error') && text.startsWith(name) && (text.length === name.length || text[name.length] === ':'));
  const base = constructor ?? 'Error';
  const prototype = tag !== '' && tag !== base ? `${base} [${tag}]` : base;
  if (!looksNormal || name === prototype) return text;
  return prototype.includes(name)
    ? `${prototype}${text.slice(name.length)}`
    : `${prototype} [${name}]${text.slice(name.length)}`;
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
    if (isObject(value)) return `[${label}] ${formatIndented(ctx, value, recurseTimes)}`;
    return `[${label}: ${formatIndented(ctx, value, recurseTimes)}]`;
  } catch (error) {
    if (!(error instanceof JsThrow)) throw error;
    return `[${label}: <Inspection threw (${formatIndented(ctx, error.value, recurseTimes)})>]`;
  }
}

function accessorText(property: AccessorProperty): string {
  if (property.get) return property.set ? '[Getter/Setter]' : '[Getter]';
  return property.set ? '[Setter]' : 'undefined';
}

// code-gauge-allow functionCognitiveComplexity 21 -- Ports Node.js's util.inspect, so the two stay comparable.
function formatArray(ctx: Context, array: JsArray, recurseTimes: number): string[] {
  const { elements } = array;
  const output: string[] = [];
  let index = 0;
  while (index < elements.length && output.length < ctx.maxArrayLength) {
    if (elements[index] === HOLE) {
      const start = index;
      while (index < elements.length && elements[index] === HOLE) index++;
      const count = index - start;
      output.push(`<${count} empty item${count > 1 ? 's' : ''}>`);
    } else {
      const defined = array.definedElements?.get(index);
      output.push(
        defined && isAccessor(defined)
          ? formatAccessor(ctx, array, defined, recurseTimes)
          : formatIndented(ctx, elements[index] as Value, recurseTimes)
      );
      index++;
    }
  }
  const remaining = elements.length - index;
  if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
  return output;
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

/** The entries of a Map, Set, or an iterator over one, which an iterator shows from where it has reached on. */
// code-gauge-allow functionCognitiveComplexity 21 -- Ports Node.js's util.inspect, so the two stay comparable.
function formatCollection(ctx: Context, value: JsObject, recurseTimes: number): string[] {
  const iterator = value.hostIterator instanceof CollectionIterator ? value.hostIterator : undefined;
  const state = iterator ? iterator.state : value.collection;
  if (!state) return [];
  if (state.isWeak) return ['<items unknown>'];
  const entries = iterator ? iterator.remainingEntries() : state.liveEntries(ctx.runtime);
  const formatEntry = (entry: CollectionEntry): string => {
    if (!iterator) {
      const key = formatCharged(ctx, entry.key, recurseTimes);
      return state.kind === 'Map' ? `${key} => ${formatCharged(ctx, entry.value, recurseTimes)}` : key;
    }
    if (iterator.kind !== 'entries') {
      return formatCharged(ctx, iterator.kind === 'keys' ? entry.key : entry.value, recurseTimes);
    }
    const pair = [formatCharged(ctx, entry.key, recurseTimes), formatCharged(ctx, entry.value, recurseTimes)];
    return reduceToSingleString(ctx, pair, '', ['[', ']'], recurseTimes, value);
  };
  ctx.indentationLvl += 2;
  const output = entries.slice(0, ctx.maxArrayLength).map((entry) => formatEntry(entry));
  ctx.indentationLvl -= 2;
  const remaining = entries.length - output.length;
  if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
  return output;
}

/** What a promise shows before its properties: `<pending>`, its value, or `<rejected>` and its reason. */
function promiseEntry(ctx: Context, state: PromiseState, recurseTimes: number): string {
  if (state.status === 'pending') return '<pending>';
  const result = formatIndented(ctx, state.result, recurseTimes);
  return state.status === 'rejected' ? `<rejected> ${result}` : result;
}

// code-gauge-allow functionCognitiveComplexity 20 -- Ports Node.js's util.inspect, so the two stay comparable.
function formatProperty(ctx: Context, object: JsObject, recurseTimes: number, key: Key): string {
  const property = object.properties.get(key);
  let text = 'undefined';
  let separator = ' ';
  if (property && !isAccessor(property)) {
    // The compact layout indents an object's values one more and moves a value too wide for a line to the next.
    const diff = ctx.compact === true && !(object instanceof JsArray) ? 3 : 2;
    text = formatIndented(ctx, property.value, recurseTimes, diff);
    if (diff === 3 && ctx.breakLength < text.length) separator = `\n${' '.repeat(ctx.indentationLvl + diff)}`;
  } else if (property && isAccessor(property)) {
    text = formatAccessor(ctx, object, property, recurseTimes);
  }
  // A symbol key shows its description with control characters escaped, unlike a symbol value.
  const symbolKey = typeof key === 'symbol' ? escapeControls(key.toString()) : undefined;
  if (property && !property.enumerable) return `[${symbolKey ?? String(key)}]:${separator}${text}`;
  if (typeof key === 'symbol') return `${symbolKey}:${separator}${text}`;
  if (KEY_PATTERN.test(key)) return `${key === '__proto__' ? "['__proto__']" : key}:${separator}${text}`;
  return `${quote(key)}:${separator}${text}`;
}

function formatIndented(ctx: Context, value: Value, recurseTimes: number, diff = 2): string {
  ctx.indentationLvl += diff;
  const text = formatCharged(ctx, value, recurseTimes);
  ctx.indentationLvl -= diff;
  return text;
}

// code-gauge-allow functionCognitiveComplexity 29 -- Ports Node.js's util.inspect, so the two stay comparable.
function reduceToSingleString(
  ctx: Context,
  output: string[],
  base: string,
  braces: string[],
  recurseTimes: number,
  value: JsObject
): string {
  const basePrefix = base ? `${base} ` : '';
  const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
  if (ctx.compact !== true) {
    if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
      const entries = output.length;
      if (value instanceof JsArray && entries > 6) output = groupArrayElements(ctx, output, value);
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
    totalLength += entry.length;
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
    const length = stringWidth(output[i]);
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
  return showsGetter(ctx, property) ? gotText(ctx, object, property, recurseTimes) : accessorText(property);
}
