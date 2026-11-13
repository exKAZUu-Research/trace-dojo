import type { Expr, LocalRef, Pattern } from './ast';
import { caseEquals, inspect, rEquals } from './conversions';
import { rubyError, typeError } from './errors';
import { hashGet, hashSet } from './hashes';
import { callMethod, ev, type Gen, respondsTo } from './interp';
import { NIL, RArray, RHash, RSymbol, type Value } from './objects';
import { type Frame, rt } from './runtime';
import { arr, newHash, sym, truthy } from './values';

/** Why the last pattern failed to match, which a `case`/`in` with one clause, or a `=>`, reports. */
interface Failure {
  message: string;
  missingKey?: Value;
}

let lastFailure: Failure | undefined;

function* fail(describe: () => Gen<string>, missingKey?: Value): Gen<boolean> {
  lastFailure = { message: yield* describe(), missingKey };
  return false;
}

function* caseFailure(pattern: Value, value: Value): Gen<boolean> {
  return yield* fail(function* () {
    return `${yield* inspect(pattern)} === ${yield* inspect(value)} does not return true`;
  });
}

function* checked(pattern: Value, value: Value): Gen<boolean> {
  return (yield* caseEquals(pattern, value)) || (yield* caseFailure(pattern, value));
}

/** Records that a guard clause rejected the value. */
export function guardFailed(): void {
  lastFailure = { message: 'guard clause does not return true' };
}

/** Whether a value matches a pattern, binding the pattern's variables in the frame as it goes, as Ruby does. */
// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of pattern.
export function* matchPattern(pattern: Pattern, value: Value, frame: Frame): Gen<boolean> {
  rt().spend();
  switch (pattern.k) {
    case 'value':
    case 'pin': {
      return yield* checked(yield* ev(pattern.e, frame), value);
    }
    case 'bind': {
      bind(pattern.target, value, frame);
      return true;
    }
    case 'as': {
      if (!(yield* matchPattern(pattern.pattern, value, frame))) return false;
      bind(pattern.target, value, frame);
      return true;
    }
    case 'alt': {
      for (const option of pattern.options) if (yield* matchPattern(option, value, frame)) return true;
      return false;
    }
    case 'array': {
      return yield* matchArray(pattern, value, frame);
    }
    case 'find': {
      return yield* matchFind(pattern, value, frame);
    }
    case 'hash': {
      return yield* matchHash(pattern, value, frame);
    }
  }
}

function bind(target: LocalRef | undefined, value: Value, frame: Frame): void {
  if (target) frame.scope.assign(target.name, target.depth, value);
}

function* classMatches(cls: Expr | undefined, value: Value, frame: Frame): Gen<boolean> {
  if (!cls) return true;
  return yield* checked(yield* ev(cls, frame), value);
}

function* deconstruct(value: Value): Gen<Value[] | undefined> {
  if (value instanceof RArray) return value.items;
  if (!respondsTo(value, 'deconstruct')) {
    yield* fail(function* () {
      return `${yield* inspect(value)} does not respond to #deconstruct`;
    });
    return undefined;
  }
  const result = yield* callMethod(value, 'deconstruct', []);
  if (!(result instanceof RArray)) throw typeError('deconstruct must return Array');
  return result.items;
}

function* matchArray(pattern: Extract<Pattern, { k: 'array' }>, value: Value, frame: Frame): Gen<boolean> {
  if (!(yield* classMatches(pattern.cls, value, frame))) return false;
  const items = yield* deconstruct(value);
  if (!items) return false;
  const fixed = pattern.pre.length + pattern.post.length;
  if (pattern.rest ? items.length < fixed : items.length !== fixed) {
    return yield* fail(function* () {
      return `${yield* inspect(value)} length mismatch (given ${items.length}, expected ${fixed}${pattern.rest ? '+' : ''})`;
    });
  }
  for (const [index, item] of pattern.pre.entries())
    if (!(yield* matchPattern(item, items[index], frame))) return false;
  if (pattern.rest)
    bind(pattern.rest.target, arr(items.slice(pattern.pre.length, items.length - pattern.post.length)), frame);
  const offset = items.length - pattern.post.length;
  for (const [index, item] of pattern.post.entries())
    if (!(yield* matchPattern(item, items[offset + index], frame))) return false;
  return true;
}

function* matchFind(pattern: Extract<Pattern, { k: 'find' }>, value: Value, frame: Frame): Gen<boolean> {
  if (!(yield* classMatches(pattern.cls, value, frame))) return false;
  const items = yield* deconstruct(value);
  if (!items) return false;
  const width = pattern.middle.length;
  for (let start = 0; start + width <= items.length; start++) {
    let matched = true;
    for (const [index, item] of pattern.middle.entries()) {
      if (!(yield* matchPattern(item, items[start + index], frame))) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    bind(pattern.before, arr(items.slice(0, start)), frame);
    bind(pattern.after, arr(items.slice(start + width)), frame);
    return true;
  }
  return yield* fail(function* () {
    return `${yield* inspect(value)} does not match to find pattern`;
  });
}

function* matchHash(pattern: Extract<Pattern, { k: 'hash' }>, value: Value, frame: Frame): Gen<boolean> {
  if (!(yield* classMatches(pattern.cls, value, frame))) return false;
  let hash: RHash;
  if (value instanceof RHash) hash = value;
  else if (respondsTo(value, 'deconstruct_keys')) {
    const keys =
      pattern.rest === undefined || pattern.rest === 'nil' ? arr(pattern.pairs.map((pair) => sym(pair.key))) : NIL;
    const result = yield* callMethod(value, 'deconstruct_keys', [keys]);
    if (!(result instanceof RHash)) throw typeError('deconstruct_keys must return Hash');
    hash = result;
  } else {
    return yield* fail(function* () {
      return `${yield* inspect(value)} does not respond to #deconstruct_keys`;
    });
  }
  for (const pair of pattern.pairs) {
    const entry = yield* hashGet(hash, sym(pair.key));
    if (!entry) {
      const key = sym(pair.key);
      return yield* fail(function* () {
        return `key not found: ${yield* inspect(key)}`;
      }, key);
    }
    if (pair.pattern) {
      if (!(yield* matchPattern(pair.pattern, entry.value, frame))) return false;
    } else if (pair.target) {
      bind(pair.target, entry.value, frame);
    }
  }
  if (pattern.rest === 'nil' && hash.map.size !== pattern.pairs.length) {
    const rest = yield* restOf(hash, pattern.pairs);
    return yield* fail(function* () {
      return `rest of ${yield* inspect(rest)} is not empty`;
    });
  }
  if (pattern.rest && pattern.rest !== 'any' && pattern.rest !== 'nil')
    bind(pattern.rest, yield* restOf(hash, pattern.pairs), frame);
  if (pattern.pairs.length === 0 && pattern.rest === undefined && hash.map.size > 0) {
    return yield* fail(function* () {
      return `${yield* inspect(hash)} is not empty`;
    });
  }
  return true;
}

function* restOf(hash: RHash, pairs: { key: string }[]): Gen<RHash> {
  const rest = newHash();
  for (const entry of hash.map.values()) {
    if (entry.key instanceof RSymbol && pairs.some((pair) => pair.key === (entry.key as RSymbol).name)) continue;
    yield* hashSet(rest, entry.key, entry.value);
  }
  return rest;
}

/**
 * The error a `case`/`in` without `else`, or a `=>`, raises when nothing matched. With a single pattern, the message
 * says why it failed.
 */
export function* noMatchingPattern(value: Value, single: boolean): Gen<unknown> {
  const subject = yield* inspect(value);
  const failure = lastFailure;
  lastFailure = undefined;
  if (!single || !failure) return rubyError(rt().c.NoMatchingPatternError, subject);
  const error = rubyError(
    failure.missingKey === undefined ? rt().c.NoMatchingPatternError : rt().c.NoMatchingPatternKeyError,
    `${subject}: ${failure.message}`
  );
  return error;
}

export { rEquals, truthy };
