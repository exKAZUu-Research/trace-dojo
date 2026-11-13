import { bytesLikeData, latin1Bytes, latin1Text, newBytes, PyBytes } from '../../bytesValues';
// The `re` module, whose functions CPython defines in Python on top of `_sre` (Lib/re/__init__.py).
import { pyHash } from '../../hashing';
import { registerModule } from '../../modules';
import { callValue, getAttribute, isTruthy } from '../../objects';
import type { Runtime } from '../../runtime';
import { nativeFunction, None, typeError, typeName, unbox, valueError } from '../../types';
import { type Kwargs, PyObject, type PyTuple, type PyValue } from '../../values';
import { pythonArgs, type PythonParameter } from './arguments';
import { FLAG } from './constants';
import { createRegexFlagClass, flagValue, isFlag } from './flags';
import { lexiconScannerClass } from './lexiconScanner';
import { matchClass } from './match';
import { checkFlagsOperand, compileRegex, patternClass, patternErrorClass, PatternObject } from './pattern';

const MAXCACHE = 512;
const caches = new WeakMap<Runtime, Map<string, PatternObject>>();

/** `count=0` and `flags=0` of `sub`, `subn`, and `split`, which tell a keyword argument from a positional one. */
const ZERO_SENTINEL = new PyObject(undefined);

/** `re._compile`: the cached Pattern for a pattern and flags. */
function compileCached(runtime: Runtime, pattern: PyValue, flagsArgument: PyValue): PatternObject {
  const flags = isFlag(flagsArgument) ? flagValue(flagsArgument) : flagsArgument;
  hashKey(pattern, flags);
  const cache = caches.get(runtime) ?? new Map<string, PatternObject>();
  caches.set(runtime, cache);
  const text = patternText(pattern);
  const key = text === undefined ? undefined : cacheKey(text, flags, pattern instanceof PyBytes);
  const cached = key === undefined ? undefined : cache.get(key);
  if (cached && key !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  if (pattern instanceof PatternObject) {
    if (isTruthy(flags)) throw valueError('cannot process flags argument with a compiled pattern');
    return pattern;
  }
  if (text === undefined) throw typeError('first argument must be string or compiled pattern');
  checkFlagsOperand(text, flags, !(pattern instanceof PyBytes));
  const compiled = compileRegex(pattern, Number(BigInt.asIntN(32, BigInt(flags as bigint | boolean))));
  // CPython neither caches a pattern compiled with re.DEBUG nor takes it from the cache, so it prints each time.
  if (key !== undefined && !(compiled.flags & FLAG.DEBUG)) {
    if (cache.size >= MAXCACHE) cache.delete(cache.keys().next().value as string);
    cache.set(key, compiled);
  }
  return compiled;
}

/** The text of a str or bytes pattern, one character per byte for bytes, or undefined for anything else. */
function patternText(pattern: PyValue): string | undefined {
  if (pattern instanceof PyBytes && !pattern.isMutable) return latin1Text(pattern.data);
  const text = unbox(pattern);
  return typeof text === 'string' ? text : undefined;
}

/** The key of a pattern in the cache, where flags equal as Python numbers share a key. */
function cacheKey(pattern: string, flags: PyValue, isBytes: boolean): string | undefined {
  const kind = isBytes ? 'b' : 's';
  if (typeof flags === 'bigint' || typeof flags === 'boolean') return `${kind}${BigInt(flags)}:${pattern}`;
  if (typeof flags === 'number' && Number.isInteger(flags)) return `${kind}${BigInt(flags)}:${pattern}`;
  return undefined;
}

/** Hashes the cache key `(type(pattern), pattern, flags)`, raising CPython's error for an unhashable one. */
function hashKey(pattern: PyValue, flags: PyValue): void {
  for (const value of [pattern, flags]) {
    try {
      pyHash(value);
    } catch (error) {
      if (!(error instanceof Error) || !('exception' in error)) throw error;
      throw typeError(`cannot use 'tuple' as a dict key (unhashable type: '${typeName(value)}')`);
    }
  }
}

const positional = (name: string, fallback?: PyValue): PythonParameter => ({
  name,
  kind: 'positional',
  default: fallback,
});

const SEARCH_SIGNATURE = [positional('pattern'), positional('string'), positional('flags', 0n)];

function callPattern(pattern: PatternObject, name: string, args: PyValue[]): PyValue {
  return callValue(getAttribute(pattern, name), args);
}

function searchFunction(runtime: Runtime, name: string): PyValue {
  return nativeFunction(name, (args, kwargs) => {
    const bound = pythonArgs(name, SEARCH_SIGNATURE, args, kwargs);
    const pattern = compileCached(runtime, bound.get('pattern') as PyValue, bound.get('flags') as PyValue);
    return callPattern(pattern, name, [bound.get('string') as PyValue]);
  });
}

/** `sub`, `subn`, and `split`, whose last two parameters may still be passed by position. */
// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes the argument handling of re.sub, re.subn, and re.split.
function deprecatedPositionalFunction(runtime: Runtime, name: 'sub' | 'subn' | 'split'): PyValue {
  const leading = name === 'split' ? ['pattern', 'string'] : ['pattern', 'repl', 'string'];
  const optional = name === 'split' ? 'maxsplit' : 'count';
  const signature: PythonParameter[] = [
    ...leading.map((each) => positional(each)),
    { name: 'args', kind: 'varArgs' },
    { name: optional, kind: 'keywordOnly', default: ZERO_SENTINEL },
    { name: 'flags', kind: 'keywordOnly', default: ZERO_SENTINEL },
  ];
  return nativeFunction(name, (args: PyValue[], kwargs: Kwargs) => {
    const bound = pythonArgs(name, signature, args, kwargs);
    let extra = (bound.get('args') as PyTuple).items;
    let count = bound.get(optional) as PyValue;
    let flags = bound.get('flags') as PyValue;
    if (extra.length > 0) {
      if (count !== ZERO_SENTINEL) throw typeError(`${name}() got multiple values for argument '${optional}'`);
      [count, ...extra] = extra;
      if (extra.length > 0) {
        if (flags !== ZERO_SENTINEL) throw typeError(`${name}() got multiple values for argument 'flags'`);
        [flags, ...extra] = extra;
        if (extra.length > 0) {
          const total = leading.length + 2;
          throw typeError(
            `${name}() takes from ${leading.length} to ${total} positional arguments but ${total + extra.length} were given`
          );
        }
      }
    }
    const pattern = compileCached(runtime, bound.get('pattern') as PyValue, flags === ZERO_SENTINEL ? 0n : flags);
    const rest = leading.slice(1).map((each) => bound.get(each) as PyValue);
    return callPattern(pattern, name, [...rest, count === ZERO_SENTINEL ? 0n : count]);
  });
}

const SPECIAL_CHARS = new Set('()[]{}?*+-|^$\\.&~# \t\n\r\v\f');

function escape(args: PyValue[], kwargs: Kwargs): PyValue {
  const pattern = pythonArgs('escape', [positional('pattern')], args, kwargs).get('pattern') as PyValue;
  const text = unbox(pattern);
  const data = typeof text === 'string' ? undefined : bytesLikeData(pattern);
  if (typeof text !== 'string' && data === undefined) {
    throw typeError(`decoding to str: need a bytes-like object, ${typeName(pattern)} found`);
  }
  let result = '';
  for (const char of data === undefined ? (text as string) : latin1Text(data)) {
    result += SPECIAL_CHARS.has(char) ? `\\${char}` : char;
  }
  return data === undefined ? result : newBytes(latin1Bytes(result));
}

registerModule('re', (runtime) => {
  const regexFlagClass = createRegexFlagClass(runtime);
  const namespace = new Map<string, PyValue>();
  for (const name of ['match', 'fullmatch', 'search', 'findall', 'finditer'])
    namespace.set(name, searchFunction(runtime, name));
  for (const name of ['sub', 'subn', 'split'] as const)
    namespace.set(name, deprecatedPositionalFunction(runtime, name));
  namespace.set(
    'compile',
    nativeFunction('compile', (args, kwargs) => {
      const bound = pythonArgs('compile', [positional('pattern'), positional('flags', 0n)], args, kwargs);
      return compileCached(runtime, bound.get('pattern') as PyValue, bound.get('flags') as PyValue);
    })
  );
  namespace.set('escape', nativeFunction('escape', escape));
  namespace.set(
    'purge',
    nativeFunction('purge', (args, kwargs) => {
      pythonArgs('purge', [], args, kwargs);
      caches.get(runtime)?.clear();
      return None;
    })
  );
  for (const [name, value] of regexFlagClass.dict) if (/^[A-Z]+$/.test(name)) namespace.set(name, value);
  namespace.set('RegexFlag', regexFlagClass);
  namespace.set('error', patternErrorClass);
  namespace.set('PatternError', patternErrorClass);
  namespace.set('Pattern', patternClass);
  namespace.set('Match', matchClass);
  namespace.set('Scanner', lexiconScannerClass);
  return namespace;
});
