// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { readProp } from './classes';
import { throwError } from './errors';
import { constructDual, dualOf, type DualState } from './libIterators';
import { defineClass } from './native';
import { toStr } from './operators';
import { PatternError, translate } from './pcrePattern';
import { rt } from './runtime';
import { type NativeFunction, PhpArray, type PhpObject, Ref, type Value } from './values';

const USE_KEY = 1n;
const INVERT_MATCH = 2n;
const MODE_MATCH = 0;
const MODE_GET_MATCH = 1;
const MODE_ALL_MATCHES = 2;
const MODE_SPLIT = 3;
const MODE_REPLACE = 4;

const MODE_MESSAGE =
  'must be RegexIterator::MATCH, RegexIterator::GET_MATCH, RegexIterator::ALL_MATCHES, RegexIterator::SPLIT, or RegexIterator::REPLACE';

defineClass({
  name: 'RegexIterator',
  parent: 'FilterIterator',
  consts: {
    USE_KEY,
    INVERT_MATCH,
    MATCH: BigInt(MODE_MATCH),
    GET_MATCH: BigInt(MODE_GET_MATCH),
    ALL_MATCHES: BigInt(MODE_ALL_MATCHES),
    SPLIT: BigInt(MODE_SPLIT),
    REPLACE: BigInt(MODE_REPLACE),
  },
  props: [{ name: 'replacement', visibility: 'public', defaultValue: () => null, type: '?string' }],
  methods: [
    {
      signature: '__construct(Iterator $iterator, string $pattern, int $mode = 0, int $flags = 0, int $pregFlags = 0)',
      impl: ({ thisObj, args }) => {
        const state = constructDual(thisObj, 'RegexIterator');
        const pattern = args[1] as string;
        const mode = Number(args[2] ?? 0n);
        if (mode < MODE_MATCH || mode > MODE_REPLACE)
          throwError('ValueError', `RegexIterator::__construct(): Argument #3 ($mode) ${MODE_MESSAGE}`);
        checkPattern(pattern);
        const flags = (args[3] as bigint | undefined) ?? 0n;
        const pregFlags = (args[4] as bigint | undefined) ?? 0n;
        state.regex = { pattern, mode, flags, pregFlags };
        state.constructed = true;
        state.setInner(args[0] as PhpObject);
        return null;
      },
    },
    { signature: 'accept(): bool', impl: ({ thisObj }) => accept(thisObj) },
    { signature: 'getMode(): int', impl: ({ thisObj }) => BigInt(dualOf(thisObj).regex.mode) },
    {
      signature: 'setMode(int $mode): void',
      impl: ({ thisObj, args }) => {
        const mode = Number(args[0]);
        if (mode < MODE_MATCH || mode > MODE_REPLACE)
          throwError('ValueError', `RegexIterator::setMode(): Argument #1 ($mode) ${MODE_MESSAGE}`);
        dualOf(thisObj).regex.mode = mode;
        return null;
      },
    },
    { signature: 'getFlags(): int', impl: ({ thisObj }) => dualOf(thisObj).regex.flags },
    {
      signature: 'setFlags(int $flags): void',
      impl: ({ thisObj, args }) => ((dualOf(thisObj).regex.flags = args[0] as bigint), null),
    },
    { signature: 'getRegex(): string', impl: ({ thisObj }) => dualOf(thisObj).regex.pattern },
    { signature: 'getPregFlags(): int', impl: ({ thisObj }) => dualOf(thisObj).regex.pregFlags },
    {
      signature: 'setPregFlags(int $pregFlags): void',
      impl: ({ thisObj, args }) => ((dualOf(thisObj).regex.pregFlags = args[0] as bigint), null),
    },
  ],
});

/** Rejects a pattern PCRE cannot compile, with the message preg_match would warn with. */
function checkPattern(pattern: string): void {
  try {
    translate(pattern);
  } catch (error) {
    if (!(error instanceof PatternError || error instanceof SyntaxError)) throw error;
    const prefix = error instanceof PatternError ? '' : 'Compilation failed: ';
    throwError('InvalidArgumentException', `RegexIterator::__construct(): ${prefix}${error.message}`);
  }
}

/** Transcribes RegexIterator::accept, which matches (string)current() or the key and may replace the element. */
function accept(object: PhpObject): boolean {
  const state = dualOf(object);
  if (state.data === undefined) return false;
  const { flags } = state.regex;
  let subject: string;
  if (flags & USE_KEY) subject = toStr(state.key ?? null);
  else {
    if (state.data.v instanceof PhpArray) return false;
    subject = toStr(state.data.v);
  }
  const accepted = match(object, state, subject);
  return flags & INVERT_MATCH ? !accepted : accepted;
}

function match(object: PhpObject, state: DualState, subject: string): boolean {
  const { pattern, mode, flags, pregFlags } = state.regex;
  switch (mode) {
    case MODE_GET_MATCH:
    case MODE_ALL_MATCHES: {
      const matches = new Ref(null);
      const name = mode === MODE_ALL_MATCHES ? 'preg_match_all' : 'preg_match';
      const count = preg(name, [pattern, subject, null, pregFlags], matches);
      state.replaceData(matches.v);
      return typeof count === 'bigint' && count > 0n;
    }
    case MODE_SPLIT: {
      const parts = preg('preg_split', [pattern, subject, -1n, pregFlags]);
      state.replaceData(parts);
      return parts instanceof PhpArray && parts.size > 1;
    }
    case MODE_REPLACE: {
      const count = new Ref(0n);
      const replacement = toStr(readProp(object, 'replacement', object.cls));
      const result = preg('preg_replace', [pattern, replacement, subject, -1n, null], count);
      if (result === null) return false;
      if (flags & USE_KEY) state.replaceKey(result);
      else state.replaceData(result);
      return (count.v as bigint) > 0n;
    }
    default: {
      return preg('preg_match', [pattern, subject]) === 1n;
    }
  }
}

/** Runs one of PHP's preg functions, passing `ref` as its by-reference matches or count argument. */
function preg(name: string, args: Value[], ref?: Ref): Value {
  const fn = rt().functions.get(name) as NativeFunction;
  const refs = Array.from<Ref | undefined>({ length: args.length });
  if (ref) refs[name === 'preg_replace' ? 4 : 2] = ref;
  return fn.impl({ args, refs });
}
