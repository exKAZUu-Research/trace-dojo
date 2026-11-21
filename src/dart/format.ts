import type { Runtime } from './runtime';
import type { DartObject, Value } from './values';

/** `double.toString()`: the shortest digits that read back as the value, as the Dart VM prints them. */
export function formatDouble(value: number): string {
  if (Object.is(value, -0)) return '-0.0';
  if (!Number.isFinite(value)) return String(value);
  const text = String(value);
  return /[.eN]/.test(text) ? text : `${text}.0`;
}

/** What string interpolation and `print` write for a value, running its `toString` for an object. */
export function stringOf(runtime: Runtime, value: Value): string {
  switch (typeof value) {
    case 'undefined': {
      return 'null';
    }
    case 'boolean': {
      return value ? 'true' : 'false';
    }
    case 'bigint': {
      return value.toString();
    }
    case 'number': {
      return formatDouble(value);
    }
    case 'string': {
      return value;
    }
    default: {
      return objectToString(runtime, value);
    }
  }
}

function objectToString(runtime: Runtime, value: DartObject): string {
  const result = runtime.invoke(value, 'toString', { positional: [], named: undefined }, [], undefined);
  if (typeof result !== 'string') {
    runtime.throwError('ArgumentError', 'value', [result, undefined, 'toString() did not return a string']);
  }
  return result;
}

/** Text as the VM writes it to stdout: encoded as UTF-8, where a lone surrogate becomes U+FFFD. */
export function encodableText(text: string): string {
  return text.replaceAll(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}
