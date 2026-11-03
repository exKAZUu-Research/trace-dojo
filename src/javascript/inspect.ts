import type { Runtime } from './runtime';
import { isAccessor, JsArray, JsFunction, JsObject, type Value } from './values';

const MAX_DEPTH = 2;

/** Formats a value as `console.log` shows it, without running the program's own code. */
export function inspect(runtime: Runtime, value: Value, depth = 0, seen = new Set<JsObject>()): string {
  if (typeof value === 'string') return depth === 0 ? value : `'${value.replaceAll("'", String.raw`\'`)}'`;
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (!(value instanceof JsObject)) return String(value);
  if (value instanceof JsFunction) {
    const name = runtime.functionName(value);
    if (value.behavior.kind === 'class') return `[class ${name || '(anonymous)'}]`;
    return name ? `[Function: ${name}]` : '[Function (anonymous)]';
  }
  if (value.isError) return errorText(value);
  if (value.turtle) return `Turtle { x: ${value.turtle.x}, y: ${value.turtle.y} }`;
  if (seen.has(value)) return '[Circular]';
  if (depth > MAX_DEPTH) return value instanceof JsArray ? '[Array]' : '[Object]';
  seen.add(value);
  try {
    if (value instanceof JsArray) {
      runtime.scan(value.elements.length);
      const items = value.elements.map((element) => inspect(runtime, element, depth + 1, seen));
      return items.length === 0 ? '[]' : `[ ${items.join(', ')} ]`;
    }
    const entries: string[] = [];
    for (const [key, property] of value.properties) {
      if (!property.enumerable) continue;
      const text = isAccessor(property) ? '[Getter/Setter]' : inspect(runtime, property.value, depth + 1, seen);
      entries.push(`${/^[$A-Z_a-z][\w$]*$/.test(key) ? key : `'${key}'`}: ${text}`);
    }
    runtime.scan(entries.length);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  } finally {
    seen.delete(value);
  }
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
