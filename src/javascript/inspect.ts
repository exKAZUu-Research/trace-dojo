import type { Runtime } from './runtime';
import { isAccessor, JsArray, JsFunction, JsObject, type Value } from './values';

const MAX_DEPTH = 2;

/** Formats a value as `console.log` shows it, without running the program's own code. */
// code-gauge-allow functionCognitiveComplexity 19 -- One check per kind of value, as console.log formats each.
export function inspect(runtime: Runtime, value: Value, depth = 0, seen = new Set<JsObject>()): string {
  if (typeof value === 'string') return depth === 0 ? value : `'${value.replaceAll("'", String.raw`\'`)}'`;
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (!(value instanceof JsObject)) return String(value);
  if (value instanceof JsFunction) return functionText(runtime, value);
  if (value.isError) return errorText(value);
  if (value.turtle) return `Turtle { x: ${value.turtle.x}, y: ${value.turtle.y} }`;
  if (seen.has(value)) return '[Circular]';
  if (depth > MAX_DEPTH) return value instanceof JsArray ? '[Array]' : '[Object]';
  seen.add(value);
  try {
    const items =
      value instanceof JsArray ? arrayItems(runtime, value, depth, seen) : objectEntries(runtime, value, depth, seen);
    runtime.scan(items.length);
    if (items.length === 0) return value instanceof JsArray ? '[]' : '{}';
    return value instanceof JsArray ? `[ ${items.join(', ')} ]` : `{ ${items.join(', ')} }`;
  } finally {
    seen.delete(value);
  }
}

function functionText(runtime: Runtime, fn: JsFunction): string {
  const name = runtime.functionName(fn);
  if (fn.behavior.kind === 'class') return `[class ${name || '(anonymous)'}]`;
  return name ? `[Function: ${name}]` : '[Function (anonymous)]';
}

function arrayItems(runtime: Runtime, array: JsArray, depth: number, seen: Set<JsObject>): string[] {
  return array.elements.map((element) => inspect(runtime, element, depth + 1, seen));
}

function objectEntries(runtime: Runtime, object: JsObject, depth: number, seen: Set<JsObject>): string[] {
  const entries: string[] = [];
  for (const [key, property] of object.properties) {
    if (!property.enumerable) continue;
    const text = isAccessor(property) ? '[Getter/Setter]' : inspect(runtime, property.value, depth + 1, seen);
    entries.push(`${/^[$A-Z_a-z][\w$]*$/.test(key) ? key : `'${key}'`}: ${text}`);
  }
  return entries;
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
