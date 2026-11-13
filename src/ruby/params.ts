import type { Params, ParamTarget } from './ast';
import { inspect } from './conversions';
import { argumentError, expectedArity } from './errors';
import { hashSet } from './hashes';
import { destructure, ev, type Gen } from './interp';
import { NIL, RArray, type RHash, RSymbol, type Value } from './objects';
import type { Frame } from './runtime';
import { arr, newHash } from './values';

type BindMode = 'method' | 'lambda' | 'proc';

// code-gauge-allow functionCognitiveComplexity 29 -- Ruby parameter forms share arity and binding paths, which this function keeps in source order.
// code-gauge-allow functionNcss 42 -- Ruby parameter forms share arity and binding paths, which this function keeps in source order.
export function* bindParams(
  params: Params,
  frame: Frame,
  given: Value[],
  keywords: RHash | undefined,
  mode: BindMode
): Gen<void> {
  const { scope } = frame;
  const takesKeywords = params.keywords.length > 0 || params.keywordRest !== undefined;
  let args = given;
  if (keywords && !takesKeywords) {
    args = [...args, keywords];
    keywords = undefined;
  }
  const required = params.required.length + params.post.length;
  const optional = params.optional.length;
  if (mode === 'proc') {
    if (args.length === 1 && args[0] instanceof RArray && autoSplats(params)) args = [...args[0].items];
  } else if (args.length < required || (params.rest === undefined && args.length > required + optional)) {
    const missingKeywords = params.keywords.filter((keyword) => !keyword.value).map((keyword) => keyword.name);
    const max = params.rest === undefined ? required + optional : -1;
    let message = `wrong number of arguments (given ${args.length}, expected ${expectedArity(required, max)}`;
    if (missingKeywords.length > 0 && !keywords) {
      message += `; required keyword${missingKeywords.length > 1 ? 's' : ''}: ${missingKeywords.join(', ')}`;
    }
    throw argumentError(`${message})`);
  }
  let index = 0;
  for (const param of params.required) yield* bindParam(param, args[index++] ?? NIL, frame);
  const available = Math.max(0, args.length - required);
  const optionalCount = Math.min(optional, available);
  for (const [position, param] of params.optional.entries()) {
    if (position < optionalCount) scope.vars.set(param.name, args[index++]);
    else scope.vars.set(param.name, yield* ev(param.value, frame));
  }
  if (params.rest !== undefined) {
    const restCount = Math.max(0, args.length - index - params.post.length);
    const rest = arr(args.slice(index, index + restCount));
    if (params.rest !== '') scope.vars.set(params.rest, rest);
    index += restCount;
  }
  for (const param of params.post) yield* bindParam(param, args[index++] ?? NIL, frame);
  if (takesKeywords) yield* bindKeywords(params, frame, keywords);
  if (params.block !== undefined) scope.vars.set(params.block, frame.extra.block ?? NIL);
}

function* bindParam(param: ParamTarget, value: Value, frame: Frame): Gen<void> {
  if (typeof param === 'string') frame.scope.vars.set(param, value);
  else yield* destructure(param, value, frame);
}

function autoSplats(params: Params): boolean {
  const positional = params.required.length + params.optional.length + params.post.length;
  return positional > 1 || params.trailingComma || (params.rest !== undefined && positional > 0);
}

// code-gauge-allow functionCognitiveComplexity 22 -- Ruby parameter forms share arity and binding paths, which this function keeps in source order.
function* bindKeywords(params: Params, frame: Frame, keywords: RHash | undefined): Gen<void> {
  const { scope } = frame;
  const given = new Map<string, Value>();
  const extra = newHash();
  if (keywords) {
    for (const entry of keywords.map.values()) {
      if (
        entry.key instanceof RSymbol &&
        params.keywords.some((keyword) => keyword.name === (entry.key as RSymbol).name)
      ) {
        given.set(entry.key.name, entry.value);
      } else {
        yield* hashSet(extra, entry.key, entry.value);
      }
    }
  }
  const missing = params.keywords.filter((keyword) => !keyword.value && !given.has(keyword.name));
  if (missing.length > 0) {
    const names = missing.map((keyword) => `:${keyword.name}`).join(', ');
    throw argumentError(`missing keyword${missing.length > 1 ? 's' : ''}: ${names}`);
  }
  if (params.keywordRest === undefined && extra.map.size > 0) {
    const names = [];
    for (const entry of extra.map.values()) names.push(yield* inspect(entry.key));
    throw argumentError(`unknown keyword${names.length > 1 ? 's' : ''}: ${names.join(', ')}`);
  }
  for (const keyword of params.keywords) {
    const value = given.get(keyword.name);
    scope.vars.set(keyword.name, value ?? (keyword.value ? yield* ev(keyword.value, frame) : NIL));
  }
  if (params.keywordRest) scope.vars.set(params.keywordRest, extra);
}
