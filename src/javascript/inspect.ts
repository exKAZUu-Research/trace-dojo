import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { PromiseState } from './promises';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { HOLE, isAccessor, JsArray, JsFunction, JsObject, type Key, type Value } from './values';

// The defaults of Node.js's `util.inspect`, which this module ports from `lib/internal/util/inspect.js`.
const DEFAULT_DEPTH = 2;
const BREAK_LENGTH = 80;
const COMPACT = 3;
const MAX_ARRAY_LENGTH = 100;
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
  /** The reference numbers of the objects printed as `[Circular *n]`. */
  circular: Map<JsObject, number>;
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
  depth = DEFAULT_DEPTH
): string {
  const ctx: Context = {
    runtime,
    budget,
    depth,
    indentationLvl: 0,
    currentDepth: 0,
    seen: new Set(),
    circular: new Map(),
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
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'bigint') return `${value}n`;
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

function formatString(ctx: Context, value: string): string {
  if (value.length > MIN_LINE_LENGTH && value.length > BREAK_LENGTH - ctx.indentationLvl - 4) {
    return value
      .split(/(?<=\n)/)
      .map((line) => quote(line))
      .join(` +\n${' '.repeat(ctx.indentationLvl + 2)}`);
  }
  return quote(value);
}

/** Quotes a string with the first of `'`, `"`, and `` ` `` it does not contain, escaping what it must. */
function quote(text: string): string {
  let mark = "'";
  if (text.includes("'")) {
    if (!text.includes('"')) mark = '"';
    else if (!text.includes('`') && !text.includes('${')) mark = '`';
  }
  const escaped = text.replaceAll(ESCAPED_CHARACTER, (character) => {
    const named = NAMED_ESCAPES[character];
    if (named) return named;
    const code = character.codePointAt(0) ?? 0;
    return code >= 0xd8_00 ? `\\u${code.toString(16)}` : `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
  });
  return mark === "'" ? `'${escaped.replaceAll("'", String.raw`\'`)}'` : `${mark}${escaped}${mark}`;
}

interface Frame {
  /** The text before the braces, such as a function's name. */
  base: string;
  braces: [string, string];
}

function formatRaw(ctx: Context, value: JsObject, recurseTimes: number): string {
  const { runtime } = ctx;
  const constructor = constructorName(runtime, value);
  const keys = enumerableKeys(runtime, value);
  const frame = frameOf(runtime, value, constructor, keys.length > 0 || value.promise !== undefined);
  if (typeof frame === 'string') return frame;
  if (recurseTimes > ctx.depth) {
    const name = prefixOf(constructor, value instanceof JsArray ? 'Array' : 'Object').slice(0, -1);
    return constructor === undefined ? name : `[${name}]`;
  }
  recurseTimes++;
  ctx.seen.add(value);
  ctx.currentDepth = recurseTimes;
  const output = value instanceof JsArray ? formatArray(ctx, value, recurseTimes) : [];
  if (value.promise) output.push(promiseEntry(ctx, value.promise, recurseTimes));
  for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key));
  runtime.scan(output.length);
  const reference = ctx.circular.get(value);
  let { base } = frame;
  if (reference !== undefined) base = base === '' ? `<ref *${reference}>` : `<ref *${reference}> ${base}`;
  ctx.seen.delete(value);
  return reduceToSingleString(ctx, output, base, frame.braces, recurseTimes, value);
}

/** What surrounds the entries of an object, or its whole text when it has no entries to list. */
function frameOf(runtime: Runtime, value: JsObject, constructor: string | undefined, hasKeys: boolean): Frame | string {
  if (value instanceof JsArray) {
    const prefix = constructor === 'Array' ? '' : prefixOf(constructor, 'Array', `(${value.elements.length})`);
    return value.elements.length === 0 && !hasKeys ? `${prefix}[]` : { base: '', braces: [`${prefix}[`, ']'] };
  }
  if (value.turtle) return `Turtle { x: ${value.turtle.x}, y: ${value.turtle.y} }`;
  let base = '';
  let open = '{';
  if (value instanceof JsFunction) base = functionBase(runtime, value);
  else if (value.regexp) base = String(value.regexp);
  else if (value.isError && constructor !== 'Object') base = errorText(value);
  else {
    const tag = toStringTagOf(value);
    if (tag && tag !== constructor) open = `${prefixOf(constructor, 'Object')}[${tag}] {`;
    else if (constructor !== 'Object') open = `${prefixOf(constructor, 'Object')}{`;
  }
  if (!hasKeys) return base || `${open}}`;
  return { base, braces: [open, '}'] };
}

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

/** The keys an object lists, its strings and then its symbols, as `Object.keys` and then its symbols order them. */
function enumerableKeys(runtime: Runtime, object: JsObject): Key[] {
  // An array keeps its elements apart from its other properties.
  const strings =
    object instanceof JsArray
      ? [...object.properties.keys()].filter((key) => typeof key === 'string')
      : runtime.ownKeys(object);
  const keys: Key[] = [...strings, ...runtime.ownSymbols(object)];
  return keys.filter((key) => {
    if (object.isError && (key === 'message' || key === 'name' || key === 'stack')) return false;
    return object.properties.get(key)?.enumerable;
  });
}

function functionBase(runtime: Runtime, fn: JsFunction): string {
  const name = runtime.functionName(fn);
  if (fn.behavior.kind !== 'class') {
    const node = fn.behavior.kind === 'user' ? fn.behavior.node : undefined;
    const kind = `${node?.isAsync ? 'Async' : ''}${node?.isGenerator ? 'Generator' : ''}Function`;
    return name ? `[${kind}: ${name}]` : `[${kind} (anonymous)]`;
  }
  const superName = fn.proto instanceof JsFunction ? runtime.functionName(fn.proto) : '';
  return `[class ${name || '(anonymous)'}${superName ? ` extends ${superName}` : ''}]`;
}

function errorText(error: JsObject): string {
  const message = dataValue(error, 'message');
  let name: Value;
  for (let current: JsObject | null = error; current && name === undefined; current = current.proto) {
    name = dataValue(current, 'name');
  }
  const nameText = typeof name === 'string' ? name : 'Error';
  return typeof message === 'string' && message ? `${nameText}: ${message}` : nameText;
}

function dataValue(object: JsObject, key: string): Value {
  const property = object.properties.get(key);
  return property && !isAccessor(property) ? property.value : undefined;
}

function formatArray(ctx: Context, array: JsArray, recurseTimes: number): string[] {
  const { elements } = array;
  const output: string[] = [];
  let index = 0;
  while (index < elements.length && output.length < MAX_ARRAY_LENGTH) {
    if (elements[index] === HOLE) {
      const start = index;
      while (index < elements.length && elements[index] === HOLE) index++;
      const count = index - start;
      output.push(`<${count} empty item${count > 1 ? 's' : ''}>`);
    } else {
      output.push(formatIndented(ctx, elements[index] as Value, recurseTimes));
      index++;
    }
  }
  const remaining = elements.length - index;
  if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
  return output;
}

/** What a promise shows before its properties: `<pending>`, its value, or `<rejected>` and its reason. */
function promiseEntry(ctx: Context, state: PromiseState, recurseTimes: number): string {
  if (state.status === 'pending') return '<pending>';
  const result = formatIndented(ctx, state.result, recurseTimes);
  return state.status === 'rejected' ? `<rejected> ${result}` : result;
}

function formatProperty(ctx: Context, object: JsObject, recurseTimes: number, key: Key): string {
  const property = object.properties.get(key);
  let text = 'undefined';
  if (property && !isAccessor(property)) text = formatIndented(ctx, property.value, recurseTimes);
  else if (property?.get) text = property.set ? '[Getter/Setter]' : '[Getter]';
  else if (property?.set) text = '[Setter]';
  if (typeof key === 'symbol') return `${key.toString()}: ${text}`;
  if (KEY_PATTERN.test(key)) return `${key === '__proto__' ? "['__proto__']" : key}: ${text}`;
  return `${quote(key)}: ${text}`;
}

function formatIndented(ctx: Context, value: Value, recurseTimes: number): string {
  ctx.indentationLvl += 2;
  const text = formatCharged(ctx, value, recurseTimes);
  ctx.indentationLvl -= 2;
  return text;
}

function reduceToSingleString(
  ctx: Context,
  output: string[],
  base: string,
  braces: string[],
  recurseTimes: number,
  value: JsObject
): string {
  const entries = output.length;
  if (value instanceof JsArray && entries > 6) output = groupArrayElements(ctx, output, value);
  const basePrefix = base ? `${base} ` : '';
  if (ctx.currentDepth - recurseTimes < COMPACT && entries === output.length) {
    // Node.js adds 10 to leave room for what may shorten the line in other places.
    const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
    if (isBelowBreakLength(output, start, base)) {
      const joined = output.join(', ');
      if (!joined.includes('\n')) return `${basePrefix}${braces[0]} ${joined} ${braces[1]}`;
    }
  }
  const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
  return `${basePrefix}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
}

function isBelowBreakLength(output: string[], start: number, base: string): boolean {
  let totalLength = output.length + start;
  if (totalLength + output.length > BREAK_LENGTH) return false;
  for (const entry of output) {
    totalLength += entry.length;
    if (totalLength > BREAK_LENGTH) return false;
  }
  return !base.includes('\n');
}

/** Lays out the entries of a long array in aligned columns. */
// code-gauge-allow functionCognitiveComplexity 20 -- Ports Node.js's groupArrayElements as it is, so the two stay comparable.
// code-gauge-allow functionNcss 41 -- Ports Node.js's groupArrayElements as it is, so the two stay comparable.
function groupArrayElements(ctx: Context, output: string[], array: JsArray): string[] {
  let totalLength = 0;
  let maxLength = 0;
  const outputLength = output.length > MAX_ARRAY_LENGTH ? output.length - 1 : output.length;
  const separatorSpace = 2;
  const dataLength: number[] = [];
  for (let i = 0; i < outputLength; i++) {
    const length = stringWidth(output[i]);
    dataLength.push(length);
    totalLength += length + separatorSpace;
    if (maxLength < length) maxLength = length;
  }
  const actualMax = maxLength + separatorSpace;
  if (actualMax * 3 + ctx.indentationLvl >= BREAK_LENGTH || (totalLength / actualMax <= 5 && maxLength > 6)) {
    return output;
  }
  const approxCharHeights = 2.5;
  const averageBias = Math.sqrt(actualMax - totalLength / output.length);
  const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
  const columns = Math.min(
    Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
    Math.floor((BREAK_LENGTH - ctx.indentationLvl) / actualMax),
    COMPACT * 4,
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
  if (output.length > MAX_ARRAY_LENGTH) grouped.push(output[outputLength]);
  return grouped;
}

/** The columns a terminal shows the text in, counting East Asian wide characters twice. */
function stringWidth(text: string): number {
  let width = 0;
  for (const character of text.normalize('NFC')) {
    const code = character.codePointAt(0) ?? 0;
    if (isFullWidthCodePoint(code)) width += 2;
    else if (!isZeroWidthCodePoint(code)) width++;
  }
  return width;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Lists the ranges of Node.js's table of wide code points.
function isFullWidthCodePoint(code: number): boolean {
  return (
    code >= 0x11_00 &&
    (code <= 0x11_5f ||
      code === 0x23_29 ||
      code === 0x23_2a ||
      (code >= 0x2e_80 && code <= 0x32_47 && code !== 0x30_3f) ||
      (code >= 0x32_50 && code <= 0x4d_bf) ||
      (code >= 0x4e_00 && code <= 0xa4_c6) ||
      (code >= 0xa9_60 && code <= 0xa9_7c) ||
      (code >= 0xac_00 && code <= 0xd7_a3) ||
      (code >= 0xf9_00 && code <= 0xfa_ff) ||
      (code >= 0xfe_10 && code <= 0xfe_19) ||
      (code >= 0xfe_30 && code <= 0xfe_6b) ||
      (code >= 0xff_01 && code <= 0xff_60) ||
      (code >= 0xff_e0 && code <= 0xff_e6) ||
      (code >= 0x1_b0_00 && code <= 0x1_b0_01) ||
      (code >= 0x1_f2_00 && code <= 0x1_f2_51) ||
      (code >= 0x1_f3_00 && code <= 0x1_f6_4f) ||
      (code >= 0x2_00_00 && code <= 0x3_ff_fd))
  );
}

function isZeroWidthCodePoint(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x3_00 && code <= 0x3_6f) ||
    (code >= 0x20_0b && code <= 0x20_0f) ||
    (code >= 0x20_d0 && code <= 0x20_ff) ||
    (code >= 0xfe_00 && code <= 0xfe_0f) ||
    (code >= 0xfe_20 && code <= 0xfe_2f) ||
    (code >= 0xe_01_00 && code <= 0xe_01_ef)
  );
}
