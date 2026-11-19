import type { RealmBuilder } from './realm';
import { hostLocales, hostOptions } from './realmDate';
import { asRegExp, replaceWithRegExp, splitWithRegExp } from './realmRegExp';
import type { Runtime } from './runtime';
import {
  isCallable,
  JsObject,
  type NativeCall,
  type NativeFunction,
  throwingHostErrors,
  unboxed,
  type Value,
} from './values';

/** One fixed locale, so that sorting with localeCompare gives the same order on every server. */
const collator = new Intl.Collator('en');

// code-gauge-allow functionCognitiveComplexity 18 -- Lists the String builtins, each a small closure of its own.
// code-gauge-allow functionNcss 42 -- Lists the String builtins, each a small closure of its own.
export function defineStringBuiltins(builder: RealmBuilder): void {
  const { stringPrototype } = builder.realm;
  // String.prototype is a String object for the empty string, which shows only as its own `length`.
  stringPrototype.properties.set('length', { value: 0, writable: false, enumerable: false, configurable: false });
  const stringConstructor = builder.defineClass('String', 1, stringPrototype, constructString);
  builder.method(stringConstructor, 'fromCharCode', 1, ({ runtime, args }) => {
    runtime.buildString(args.length);
    // oxlint-disable-next-line unicorn/prefer-code-point -- fromCharCode is the method the program called.
    return args.map((value) => String.fromCharCode(runtime.toNumber(value))).join('');
  });
  builder.method(stringConstructor, 'fromCodePoint', 1, ({ runtime, args }) => {
    runtime.buildString(args.length * 2);
    // Each argument is checked before the next one converts, as a later conversion may have effects.
    return args
      .map((value) => {
        const codePoint = runtime.toNumber(value);
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10_ff_ff)
          runtime.throwError('RangeError', `Invalid code point ${runtime.toString(codePoint)}`);
        return String.fromCodePoint(codePoint);
      })
      .join('');
  });
  builder.realm.stringRaw = builder.method(stringConstructor, 'raw', 1, ({ runtime, args }) => {
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
  builder.method(stringPrototype, 'toString', 0, thisString('toString'));
  builder.method(stringPrototype, 'valueOf', 0, thisString('valueOf'));
  defineSearches(method);
  defineExtractions(method);
  defineBuilders(method);
  defineLocaleAndLegacy(method);
  // trimLeft and trimRight are the same functions as trimStart and trimEnd.
  for (const [alias, name] of [
    ['trimLeft', 'trimStart'],
    ['trimRight', 'trimEnd'],
  ] as const) {
    const property = stringPrototype.properties.get(name);
    if (property) stringPrototype.properties.set(alias, { ...property });
  }
}

/** The locale-aware case conversions, the well-formedness checks, and the legacy `substr` and HTML methods. */
// code-gauge-allow functionCognitiveComplexity 16 -- Lists the String methods, each a small closure of its own.
function defineLocaleAndLegacy(method: StringMethod): void {
  // Node.js formats for its default locale, en-US, when no locale is given.
  method('toLocaleUpperCase', 0, ({ runtime, args }, text) =>
    built(
      runtime,
      throwingHostErrors(runtime, () =>
        text.toLocaleUpperCase((args[0] === undefined ? 'en-US' : hostLocales(runtime, args[0])) as string)
      )
    )
  );
  method('toLocaleLowerCase', 0, ({ runtime, args }, text) =>
    built(
      runtime,
      throwingHostErrors(runtime, () =>
        text.toLocaleLowerCase((args[0] === undefined ? 'en-US' : hostLocales(runtime, args[0])) as string)
      )
    )
  );
  method('isWellFormed', 0, (_, text) => text.isWellFormed());
  method('toWellFormed', 0, (_, text) => text.toWellFormed());
  method('substr', 2, ({ runtime, args }, text) => {
    const relative = integerArgument(runtime, args[0], 0);
    const start = relative < 0 ? Math.max(text.length + relative, 0) : Math.min(relative, text.length);
    const length = args[1] === undefined ? text.length - start : integerArgument(runtime, args[1], 0);
    return text.slice(start, start + Math.max(0, Math.min(length, text.length - start)));
  });
  for (const [name, tag, attribute] of htmlMethods) {
    method(name, attribute ? 1 : 0, ({ runtime, args }, text) =>
      buildLegacyHtml(runtime, text, tag, attribute, args[0])
    );
  }
}

function buildLegacyHtml(
  runtime: Runtime,
  text: string,
  tag: string,
  attribute: string | undefined,
  argument: Value
): string {
  const input = attribute ? runtime.toString(argument) : '';
  runtime.scan(input.length);
  let quotes = 0;
  for (const character of input) if (character === '"') quotes++;
  const attributeLength = attribute ? attribute.length + 4 + input.length + quotes * 5 : 0;
  runtime.buildString(text.length + tag.length * 2 + 5 + attributeLength);
  const value = attribute ? ` ${attribute}="${input.replaceAll('"', '&quot;')}"` : '';
  return `<${tag}${value}>${text}</${tag}>`;
}

/** The legacy HTML methods, by name: the element each wraps the string in, and the attribute its argument sets. */
const htmlMethods: [string, string, string | undefined][] = [
  ['anchor', 'a', 'name'],
  ['big', 'big', undefined],
  ['blink', 'blink', undefined],
  ['bold', 'b', undefined],
  ['fixed', 'tt', undefined],
  ['fontcolor', 'font', 'color'],
  ['fontsize', 'font', 'size'],
  ['italics', 'i', undefined],
  ['link', 'a', 'href'],
  ['small', 'small', undefined],
  ['strike', 'strike', undefined],
  ['sub', 'sub', undefined],
  ['sup', 'sup', undefined],
];

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
  for (const name of ['includes', 'startsWith', 'endsWith'] as const) {
    method(name, 1, ({ runtime, args }, text) => {
      if (args[0] instanceof JsObject && args[0].regexp) {
        runtime.throwError('TypeError', `First argument to String.prototype.${name} must not be a regular expression`);
      }
      const search = runtime.toString(args[0]);
      return name === 'endsWith'
        ? text.endsWith(search, integerArgument(runtime, args[1], text.length))
        : text[name](search, integerArgument(runtime, args[1], 0));
    });
  }
  method('localeCompare', 1, ({ runtime, args }, text) => {
    const that = runtime.toString(args[0]);
    if (args[1] === undefined && args[2] === undefined) return collator.compare(text, that);
    const locales = args[1] === undefined ? 'en' : (hostLocales(runtime, args[1]) as Intl.LocalesArgument);
    const options = hostOptions(runtime, args[2]) as Intl.CollatorOptions;
    return throwingHostErrors(runtime, () => text.localeCompare(that, locales, options));
  });
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
  // A case mapping can lengthen a string, as `ß` becomes `SS`.
  method('toUpperCase', 0, ({ runtime }, text) => built(runtime, text.toUpperCase()));
  method('toLowerCase', 0, ({ runtime }, text) => built(runtime, text.toLowerCase()));
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
    if (regexp) return splitWithRegExp(runtime, text, regexp, limit);
    // The separator converts before a zero limit returns, as its conversion can throw.
    const separator = args[0] === undefined ? undefined : runtime.toString(args[0]);
    if (limit === 0) return runtime.newArray([]);
    return runtime.newArray(separator === undefined ? [text] : text.split(separator, limit));
  });
}

function constructString({ runtime, args, newTarget }: NativeCall): Value {
  if (args.length === 0) return runtime.primitiveOrBox('', newTarget);
  // Called as a function, String describes a symbol instead of rejecting it.
  if (!newTarget && typeof args[0] === 'symbol') return args[0].toString();
  return runtime.primitiveOrBox(runtime.toString(args[0]), newTarget);
}

/** `String.prototype.toString` or `valueOf`, which give the string a primitive or a String object holds. */
function thisString(name: string): NativeFunction {
  return ({ runtime, thisValue }) => {
    const primitive = unboxed(thisValue);
    if (typeof primitive === 'string') return primitive;
    return runtime.throwError('TypeError', `String.prototype.${name} requires that 'this' be a String`);
  };
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
    method(name, 1, (call, text) => padText(call, text, atStart));
  }
  for (const [name, all] of [
    ['replace', false],
    ['replaceAll', true],
  ] as const) {
    method(name, 2, (call, text) => replaceText(call, text, all));
  }
}

function padText({ runtime, args }: NativeCall, text: string, atStart: boolean): string {
  const length = integerArgument(runtime, args[0], 0);
  if (length <= text.length) return text;
  const filler = args[1] === undefined ? ' ' : runtime.toString(args[1]);
  if (filler.length === 0) return text;
  runtime.buildString(length);
  return atStart ? text.padStart(length, filler) : text.padEnd(length, filler);
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

/** Charges for a string a host method built, which may be longer than its input. */
function built(runtime: Runtime, text: string): string {
  runtime.buildString(text.length);
  return text;
}
