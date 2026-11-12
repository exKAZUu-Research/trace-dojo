import type { RealmBuilder } from './realm';
import { asRegExp, replaceWithRegExp } from './realmRegExp';
import type { Runtime } from './runtime';
import { isCallable, type NativeCall, type Value } from './values';

/** One fixed locale, so that sorting with localeCompare gives the same order on every server. */
const collator = new Intl.Collator('en');

export function defineStringBuiltins(builder: RealmBuilder): void {
  const { stringPrototype } = builder.realm;
  const stringConstructor = builder.defineClass(
    'String',
    1,
    stringPrototype,
    ({ runtime, args }) => {
      if (args.length === 0) return '';
      // Called as a function, String describes a symbol instead of rejecting it.
      return typeof args[0] === 'symbol' ? args[0].toString() : runtime.toString(args[0]);
    },
    false
  );
  builder.method(stringConstructor, 'fromCharCode', 1, ({ runtime, args }) => {
    runtime.buildString(args.length);
    // oxlint-disable-next-line unicorn/prefer-code-point -- fromCharCode is the method the program called.
    return args.map((value) => String.fromCharCode(runtime.toNumber(value))).join('');
  });
  builder.method(stringConstructor, 'fromCodePoint', 1, ({ runtime, args }) => {
    runtime.buildString(args.length * 2);
    const codePoints = args.map((value) => runtime.toNumber(value));
    if (codePoints.some((codePoint) => !Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10_ff_ff)) {
      runtime.throwError('RangeError', 'Invalid code point');
    }
    return codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join('');
  });
  builder.method(stringConstructor, 'raw', 1, ({ runtime, args }) => {
    const raw = runtime.toObject(runtime.get(runtime.toObject(args[0]), 'raw'));
    const length = Math.max(0, Math.min(Math.trunc(runtime.toNumber(runtime.get(raw, 'length'))) || 0, 2 ** 53 - 1));
    let text = '';
    for (let index = 0; index < length; index++) {
      const part = runtime.toString(runtime.get(raw, String(index)));
      const substitution = index + 1 < length && index + 1 < args.length ? runtime.toString(args[index + 1]) : '';
      runtime.extendString(text.length + part.length + substitution.length, part.length + substitution.length);
      text += part + substitution;
    }
    return text;
  });
  const method = (name: string, length: number, run: (call: NativeCall, text: string) => Value): void => {
    builder.method(stringPrototype, name, length, (call) => {
      const { runtime, thisValue } = call;
      if (thisValue === undefined || thisValue === null) {
        return runtime.throwError('TypeError', `String.prototype.${name} called on null or undefined`);
      }
      const text = runtime.toString(thisValue);
      runtime.scan(text.length);
      return run(call, text);
    });
  };
  method('toString', 0, (_, text) => text);
  method('valueOf', 0, (_, text) => text);
  defineSearches(method);
  defineExtractions(method);
  defineBuilders(method);
}

type StringMethod = (name: string, length: number, run: (call: NativeCall, text: string) => Value) => void;

function integerArgument(runtime: Runtime, value: Value, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.trunc(runtime.toNumber(value)) || 0;
}

function defineSearches(method: StringMethod): void {
  method('indexOf', 1, ({ runtime, args }, text) =>
    text.indexOf(runtime.toString(args[0]), integerArgument(runtime, args[1], 0))
  );
  method('lastIndexOf', 1, ({ runtime, args }, text) =>
    text.lastIndexOf(
      runtime.toString(args[0]),
      args[1] === undefined ? Number.POSITIVE_INFINITY : runtime.toNumber(args[1])
    )
  );
  method('includes', 1, ({ runtime, args }, text) =>
    text.includes(runtime.toString(args[0]), integerArgument(runtime, args[1], 0))
  );
  method('startsWith', 1, ({ runtime, args }, text) =>
    text.startsWith(runtime.toString(args[0]), integerArgument(runtime, args[1], 0))
  );
  method('endsWith', 1, ({ runtime, args }, text) =>
    text.endsWith(runtime.toString(args[0]), integerArgument(runtime, args[1], text.length))
  );
  method('localeCompare', 1, ({ runtime, args }, text) => collator.compare(text, runtime.toString(args[0])));
}

function defineExtractions(method: StringMethod): void {
  method('charAt', 1, ({ runtime, args }, text) => text.charAt(integerArgument(runtime, args[0], 0)));
  method('charCodeAt', 1, ({ runtime, args }, text) =>
    // oxlint-disable-next-line unicorn/prefer-code-point -- charCodeAt is the method the program called.
    text.charCodeAt(integerArgument(runtime, args[0], 0))
  );
  method('codePointAt', 1, ({ runtime, args }, text) => text.codePointAt(integerArgument(runtime, args[0], 0)));
  method('at', 1, ({ runtime, args }, text) => text.at(integerArgument(runtime, args[0], 0)));
  method('slice', 2, ({ runtime, args }, text) =>
    text.slice(integerArgument(runtime, args[0], 0), integerArgument(runtime, args[1], text.length))
  );
  method('substring', 2, ({ runtime, args }, text) =>
    // oxlint-disable-next-line unicorn/prefer-string-slice -- substring swaps its arguments, which slice does not.
    text.substring(integerArgument(runtime, args[0], 0), integerArgument(runtime, args[1], text.length))
  );
  method('trim', 0, (_, text) => text.trim());
  method('trimStart', 0, (_, text) => text.trimStart());
  method('trimEnd', 0, (_, text) => text.trimEnd());
  method('toUpperCase', 0, (_, text) => text.toUpperCase());
  method('toLowerCase', 0, (_, text) => text.toLowerCase());
  method('normalize', 0, ({ runtime, args }, text) => {
    const form = args[0] === undefined ? 'NFC' : runtime.toString(args[0]);
    if (!['NFC', 'NFD', 'NFKC', 'NFKD'].includes(form)) {
      runtime.throwError('RangeError', 'The normalization form should be one of NFC, NFD, NFKC, NFKD.');
    }
    return text.normalize(form);
  });
  method('split', 2, ({ runtime, args }, text) => {
    const limit = args[1] === undefined ? 2 ** 32 - 1 : runtime.toNumber(args[1]) >>> 0;
    const regexp = asRegExp(args[0]);
    const separator = regexp ? new RegExp(regexp.regexp.source, regexp.regexp.flags) : args[0];
    const parts =
      separator === undefined
        ? [text]
        : text.split(separator instanceof RegExp ? separator : runtime.toString(separator), limit);
    return runtime.newArray(parts);
  });
}

function defineBuilders(method: StringMethod): void {
  method('concat', 1, ({ runtime, args }, text) => {
    const parts = args.map((value) => runtime.toString(value));
    let length = text.length;
    for (const part of parts) length += part.length;
    // Checked before joining, since many references to one long string make a far longer result.
    runtime.buildString(length);
    return text + parts.join('');
  });
  method('repeat', 1, ({ runtime, args }, text) => {
    const count = integerArgument(runtime, args[0], 0);
    if (count < 0 || !Number.isFinite(count)) runtime.throwError('RangeError', `Invalid count value: ${count}`);
    runtime.buildString(text.length * count);
    return text.repeat(count);
  });
  for (const [name, atStart] of [
    ['padStart', true],
    ['padEnd', false],
  ] as const) {
    method(name, 2, ({ runtime, args }, text) => {
      const length = integerArgument(runtime, args[0], 0);
      const filler = args[1] === undefined ? ' ' : runtime.toString(args[1]);
      runtime.buildString(Math.max(length, text.length));
      return atStart ? text.padStart(length, filler) : text.padEnd(length, filler);
    });
  }
  for (const [name, all] of [
    ['replace', false],
    ['replaceAll', true],
  ] as const) {
    method(name, 2, (call, text) => replaceText(call, text, all));
  }
}

function replaceText(call: NativeCall, text: string, all: boolean): string {
  const { runtime, args, callRow } = call;
  const regexp = asRegExp(args[0]);
  if (regexp) return replaceWithRegExp(call, text, regexp, args[1], all);
  const pattern = runtime.toString(args[0]);
  const replacement = args[1];
  let result = '';
  let copied = 0;
  for (const position of matchPositions(runtime, text, pattern, all)) {
    const inserted = isCallable(replacement)
      ? runtime.toString(runtime.call(replacement, undefined, [pattern, position, text], callRow))
      : expandReplacement(runtime.toString(replacement), pattern, position, text);
    const part = text.slice(copied, position) + inserted;
    runtime.extendString(result.length + part.length, part.length);
    result += part;
    copied = position + pattern.length;
  }
  const suffix = text.slice(copied);
  runtime.extendString(result.length + suffix.length, suffix.length);
  return result + suffix;
}

/** The positions where `pattern` occurs in `text`: the first only, or all without overlapping. */
function matchPositions(runtime: Runtime, text: string, pattern: string, all: boolean): number[] {
  const positions: number[] = [];
  for (let index = text.indexOf(pattern); index !== -1;) {
    positions.push(index);
    const next = index + Math.max(pattern.length, 1);
    // indexOf clamps a start past the end, where an empty pattern would match again forever.
    if (!all || next > text.length) break;
    index = text.indexOf(pattern, next);
    runtime.spend();
  }
  return positions;
}

/** Expands `$$`, `$&`, `` $` ``, and `$'` in a replacement string. */
function expandReplacement(replacement: string, matched: string, position: number, text: string): string {
  return replacement.replaceAll(/\$([$&`'])/g, (_, symbol: string) => {
    if (symbol === '$') return '$';
    if (symbol === '&') return matched;
    if (symbol === '`') return text.slice(0, position);
    return text.slice(position + matched.length);
  });
}
