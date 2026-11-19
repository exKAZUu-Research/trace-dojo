import type { Runtime } from './runtime';
import { vmTypeString } from './types';
import { type DartObject, DartRecord, type Value } from './values';

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

/** `Error.safeToString`: numbers, booleans, and null as themselves, strings quoted, and objects by their class. */
export function safeToString(runtime: Runtime, value: Value): string {
  if (value === undefined || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'number') {
    return stringOf(runtime, value);
  }
  if (typeof value === 'string') return quoteForError(value);
  if (value instanceof DartRecord) return `Record ${stringOf(runtime, value)}`;
  return `Instance of '${instanceName(runtime, value)}'`;
}

/** The name `Instance of '…'` shows: the runtime type, with its type arguments. */
export function instanceName(runtime: Runtime, value: Value): string {
  return vmTypeString(runtime.runtimeTypeOf(value));
}

/** A string as `Error.safeToString` quotes it, escaping as JSON does. */
export function quoteForError(text: string): string {
  let result = '"';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === '"') result += String.raw`\"`;
    else if (char === '\\') result += String.raw`\\`;
    else if (char === '\n') result += String.raw`\n`;
    else if (char === '\r') result += String.raw`\r`;
    else if (char === '\t') result += String.raw`\t`;
    else if (char === '\b') result += String.raw`\b`;
    else if (char === '\f') result += String.raw`\f`;
    else if (code < 0x20) result += `\\u${code.toString(16).padStart(4, '0')}`;
    else result += char;
  }
  return `${result}"`;
}

/** Text as the VM writes it to stdout: encoded as UTF-8, where a lone surrogate becomes U+FFFD. */
export function encodableText(text: string): string {
  return text.replaceAll(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}
