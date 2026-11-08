import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { Runtime } from './runtime';
import { HOLE, isAccessor, JsArray, JsFunction, JsObject, type Value } from './values';

const MAX_DEPTH = 2;

/** Bounds the text one console call formats before it is joined, since repeated large values multiply its length. */
export class OutputBudget {
  /** The characters charged so far. */
  used = 0;

  charge(length: number): void {
    this.used += length;
    if (this.used > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  }
}

/** Formats a value as `console.log` shows it, without running the program's own code. */
export function inspect(
  runtime: Runtime,
  value: Value,
  budget = new OutputBudget(),
  depth = 0,
  seen = new Set<JsObject>()
): string {
  const usedBefore = budget.used;
  const text = formatValue(runtime, value, budget, depth, seen);
  // The values nested in an array or object charged their own text, so only the rest of this text is new.
  budget.charge(text.length - (budget.used - usedBefore));
  return text;
}

// code-gauge-allow functionCognitiveComplexity 19 -- One check per kind of value, as console.log formats each.
function formatValue(runtime: Runtime, value: Value, budget: OutputBudget, depth: number, seen: Set<JsObject>): string {
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
      value instanceof JsArray
        ? arrayItems(runtime, value, budget, depth, seen)
        : objectEntries(runtime, value, budget, depth, seen);
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

function arrayItems(
  runtime: Runtime,
  array: JsArray,
  budget: OutputBudget,
  depth: number,
  seen: Set<JsObject>
): string[] {
  return array.elements.map((element) =>
    element === HOLE ? '<1 empty item>' : inspect(runtime, element, budget, depth + 1, seen)
  );
}

function objectEntries(
  runtime: Runtime,
  object: JsObject,
  budget: OutputBudget,
  depth: number,
  seen: Set<JsObject>
): string[] {
  const entries: string[] = [];
  for (const [key, property] of object.properties) {
    if (!property.enumerable) continue;
    const text = isAccessor(property) ? '[Getter/Setter]' : inspect(runtime, property.value, budget, depth + 1, seen);
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
