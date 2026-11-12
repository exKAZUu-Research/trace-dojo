import { formatNumber, inspect, inspectValue, OutputBudget } from './inspect';
import { jsonStringify } from './realmJson';
import type { Runtime } from './runtime';
import { isAccessor, JsFunction, JsObject, JsThrow, type Value } from './values';

/** Formats the arguments of a `console` call as Node.js's `util.format` does, including its `%` placeholders. */
export function formatLogArguments(runtime: Runtime, args: Value[]): string {
  const budget = new OutputBudget();
  const [first] = args;
  let index = 0;
  let text = '';
  if (typeof first === 'string' && args.length > 1) {
    const formatted = formatFormatString(runtime, first, args, budget);
    if (formatted) {
      text = formatted.text;
      index = formatted.consumed;
    }
  }
  for (; index < args.length; index++) {
    text += (index > 0 ? ' ' : '') + inspect(runtime, args[index], budget);
  }
  return text;
}

/**
 * Replaces the placeholders in the first argument with the arguments after it,
 * or returns undefined when it has neither placeholders nor `%%`, which then prints as it is.
 */
function formatFormatString(
  runtime: Runtime,
  format: string,
  args: Value[],
  budget: OutputBudget
): { text: string; consumed: number } | undefined {
  let used = 0;
  let text = '';
  let lastPos = 0;
  for (let i = 0; i < format.length - 1; i++) {
    if (format[i] !== '%') continue;
    const kind = format[++i];
    const isPercent = kind === '%';
    let replacement: string | undefined = '';
    if (!isPercent) {
      replacement = used + 1 < args.length ? formatPlaceholder(runtime, kind, args[used + 1], budget) : undefined;
    }
    if (replacement === undefined) continue;
    if (!isPercent) used++;
    const literal = format.slice(lastPos, isPercent ? i : i - 1);
    budget.charge(literal.length);
    text += literal + replacement;
    lastPos = i + 1;
  }
  if (lastPos === 0) return undefined;
  budget.charge(format.length - lastPos);
  return { text: text + format.slice(lastPos), consumed: used + 1 };
}

/** The text a placeholder stands for, or undefined for a `%` that starts no placeholder. */
function formatPlaceholder(runtime: Runtime, kind: string, value: Value, budget: OutputBudget): string | undefined {
  if (kind === 'o' || kind === 'O') {
    // Node.js's `%o` also shows hidden properties, which this leaves out.
    return inspectValue(runtime, value, budget, kind === 'o' ? 4 : undefined);
  }
  if (kind === 's' && value instanceof JsObject && !(value instanceof JsFunction) && hasBuiltinToString(value)) {
    return inspect(runtime, value, budget, 0);
  }
  const text = formatPrimitivePlaceholder(runtime, kind, value);
  if (text !== undefined) budget.charge(text.length);
  return text;
}

/** Formats `%s`, `%j`, `%d`, `%i`, and `%f` as Node.js's `formatWithOptions` does, which never rejects a BigInt or a symbol. */
function formatPrimitivePlaceholder(runtime: Runtime, kind: string, value: Value): string | undefined {
  switch (kind) {
    case 's': {
      if (typeof value === 'number') return formatNumber(value);
      if (typeof value === 'bigint') return `${value}n`;
      return typeof value === 'symbol' ? value.toString() : runtime.toString(value);
    }
    case 'j': {
      return jsonOrCircular(runtime, value);
    }
    case 'd': {
      if (typeof value === 'bigint') return `${value}n`;
      return typeof value === 'symbol' ? 'NaN' : formatNumber(runtime.toNumber(value));
    }
    case 'i': {
      if (typeof value === 'bigint') return `${value}n`;
      return typeof value === 'symbol' ? 'NaN' : formatNumber(Number.parseInt(runtime.toString(value)));
    }
    case 'f': {
      return typeof value === 'symbol' ? 'NaN' : formatNumber(Number.parseFloat(runtime.toString(value)));
    }
    case 'c': {
      return '';
    }
    default: {
      return undefined;
    }
  }
}

/** Whether the `toString` the object inherits is a builtin one, for which Node.js shows `inspect`'s text instead. */
function hasBuiltinToString(object: JsObject): boolean {
  for (let current: JsObject | null = object; current; current = current.proto) {
    const property = current.properties.get('toString');
    if (!property) continue;
    return (
      current !== object &&
      !isAccessor(property) &&
      property.value instanceof JsFunction &&
      property.value.behavior.kind === 'native'
    );
  }
  return true;
}

/** `JSON.stringify` of the value, or `[Circular]` for a cyclic one, as `%j` prints them. */
function jsonOrCircular(runtime: Runtime, value: Value): string {
  try {
    return jsonStringify(runtime, value, undefined, undefined, runtime.currentRow) ?? 'undefined';
  } catch (error) {
    if (error instanceof JsThrow && isCircularError(error.value)) return '[Circular]';
    throw error;
  }
}

function isCircularError(error: Value): boolean {
  if (!(error instanceof JsObject) || !error.isError) return false;
  const message = error.properties.get('message');
  return (
    message !== undefined &&
    !isAccessor(message) &&
    typeof message.value === 'string' &&
    message.value.startsWith('Converting circular structure to JSON\n')
  );
}
