import type { RealmBuilder } from './realm';
import type { Runtime } from './runtime';
import { isCallable, type NativeCall, type Value } from './values';

export function defineStringBuiltins(builder: RealmBuilder): void {
  const { stringPrototype } = builder.realm;
  const stringConstructor = builder.defineClass(
    'String',
    1,
    stringPrototype,
    ({ runtime, args }) => (args.length === 0 ? '' : runtime.toString(args[0])),
    false
  );
  builder.method(stringConstructor, 'fromCharCode', 1, ({ runtime, args }) => {
    runtime.buildString(args.length);
    return String.fromCharCode(...args.map((value) => runtime.toNumber(value)));
  });
  builder.method(stringConstructor, 'fromCodePoint', 1, ({ runtime, args }) => {
    runtime.buildString(args.length * 2);
    const codePoints = args.map((value) => runtime.toNumber(value));
    if (codePoints.some((codePoint) => !Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10_ff_ff)) {
      runtime.throwError('RangeError', 'Invalid code point');
    }
    return String.fromCodePoint(...codePoints);
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
    text.lastIndexOf(runtime.toString(args[0]), args[1] === undefined ? Number.POSITIVE_INFINITY : runtime.toNumber(args[1]))
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
  method('localeCompare', 1, ({ runtime, args }, text) => {
    const other = runtime.toString(args[0]);
    return text < other ? -1 : text > other ? 1 : 0;
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
    text.substring(integerArgument(runtime, args[0], 0), integerArgument(runtime, args[1], text.length))
  );
  method('trim', 0, (_, text) => text.trim());
  method('trimStart', 0, (_, text) => text.trimStart());
  method('trimEnd', 0, (_, text) => text.trimEnd());
  method('toUpperCase', 0, (_, text) => text.toUpperCase());
  method('toLowerCase', 0, (_, text) => text.toLowerCase());
  method('split', 2, ({ runtime, args }, text) => {
    const limit = args[1] === undefined ? 2 ** 32 - 1 : runtime.toNumber(args[1]) >>> 0;
    const parts = args[0] === undefined ? [text] : text.split(runtime.toString(args[0]), limit);
    return runtime.newArray(parts);
  });
}

function defineBuilders(method: StringMethod): void {
  method('concat', 1, ({ runtime, args }, text) => {
    const result = text + args.map((value) => runtime.toString(value)).join('');
    runtime.buildString(result.length);
    return result;
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
    method(name, 2, ({ runtime, args, callRow }, text) => {
      const pattern = runtime.toString(args[0]);
      const replacement = args[1];
      const positions: number[] = [];
      for (let index = text.indexOf(pattern); index !== -1; ) {
        positions.push(index);
        if (!all) break;
        index = text.indexOf(pattern, index + Math.max(pattern.length, 1));
        runtime.spend();
      }
      let result = '';
      let copied = 0;
      for (const position of positions) {
        const inserted = isCallable(replacement)
          ? runtime.toString(runtime.call(replacement, undefined, [pattern, position, text], callRow))
          : expandReplacement(runtime.toString(replacement), pattern, position, text);
        result += text.slice(copied, position) + inserted;
        runtime.buildString(result.length);
        copied = position + pattern.length;
      }
      return result + text.slice(copied);
    });
  }
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
