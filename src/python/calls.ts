import type { Parameter } from './ast';
import { bestSuggestion } from './describe';
import { newDict, newTuple, typeError } from './types';
import type { Kwargs, PyDict, PyFunction, PyValue } from './values';

function quoteNames(names: string[]): string {
  const quoted = names.map((name) => `'${name}'`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted.at(-1)}`;
}

/** Binds call arguments to a function's parameters, raising the TypeError CPython raises for a mismatch. */
export function bindArguments(fn: PyFunction, args: readonly PyValue[], kwargs: Kwargs): Map<string, PyValue> {
  const { params } = fn.def;
  const bound = new Map<string, PyValue>();
  const positional = params.filter((param) => param.kind === 'positionalOnly' || param.kind === 'positional');
  const varArgs = params.find((param) => param.kind === 'varArgs');
  const keywordOnly = params.filter((param) => param.kind === 'keywordOnly');
  const varKeywords = params.find((param) => param.kind === 'varKeywords');
  const count = Math.min(args.length, positional.length);
  for (let index = 0; index < count; index++) bound.set(positional[index].name, args[index]);
  if (varArgs) bound.set(varArgs.name, newTuple(args.slice(positional.length)));
  const extra = varKeywords ? newDict() : undefined;
  bindKeywords(fn, kwargs, bound, extra);
  if (args.length > positional.length && !varArgs)
    throw tooManyPositional(fn, positional, keywordOnly, args.length, kwargs);
  bindPositionalDefaults(fn, positional, bound);
  bindKeywordDefaults(fn, keywordOnly, bound);
  if (varKeywords && extra) bound.set(varKeywords.name, extra);
  return bound;
}

function bindKeywords(fn: PyFunction, kwargs: Kwargs, bound: Map<string, PyValue>, extra: PyDict | undefined): void {
  const { params } = fn.def;
  const positionalOnlyAsKeyword: string[] = [];
  for (const [key, value] of kwargs ?? []) {
    const param = params.find(
      (candidate) => candidate.name === key && candidate.kind !== 'varArgs' && candidate.kind !== 'varKeywords'
    );
    if (param?.kind === 'positionalOnly' || !param) {
      if (extra) extra.store.set(key, value);
      else if (param) positionalOnlyAsKeyword.push(key);
      else throw unexpectedKeyword(fn, key);
      continue;
    }
    if (bound.has(key)) throw typeError(`${fn.qualifiedName}() got multiple values for argument '${key}'`);
    bound.set(key, value);
  }
  if (positionalOnlyAsKeyword.length > 0) {
    throw typeError(
      `${fn.qualifiedName}() got some positional-only arguments passed as keyword arguments: '${positionalOnlyAsKeyword.join(', ')}'`
    );
  }
}

function unexpectedKeyword(fn: PyFunction, key: string): Error {
  const names = fn.def.params.filter(
    (each) => each.kind !== 'varArgs' && each.kind !== 'varKeywords' && each.kind !== 'positionalOnly'
  );
  const suggestion = bestSuggestion(
    key,
    names.map((each) => each.name)
  );
  return typeError(
    `${fn.qualifiedName}() got an unexpected keyword argument '${key}'${suggestion ? `. Did you mean '${suggestion}'?` : ''}`
  );
}

function tooManyPositional(
  fn: PyFunction,
  positional: Parameter[],
  keywordOnly: Parameter[],
  given: number,
  kwargs: Kwargs
): Error {
  const defaults = fn.defaults.length;
  const total = positional.length;
  const signature = defaults > 0 ? `from ${total - defaults} to ${total}` : String(total);
  const plural = defaults > 0 || total !== 1;
  const keywordOnlyGiven = keywordOnly.filter((param) => kwargs?.has(param.name)).length;
  const keywordOnlyText =
    keywordOnlyGiven > 0
      ? ` positional argument${given === 1 ? '' : 's'} (and ${keywordOnlyGiven} keyword-only argument${keywordOnlyGiven === 1 ? '' : 's'})`
      : '';
  const verb = given === 1 && keywordOnlyGiven === 0 ? 'was' : 'were';
  return typeError(
    `${fn.qualifiedName}() takes ${signature} positional argument${plural ? 's' : ''} but ${given}${keywordOnlyText} ${verb} given`
  );
}

function bindPositionalDefaults(fn: PyFunction, positional: Parameter[], bound: Map<string, PyValue>): void {
  const defaultsStart = positional.length - fn.defaults.length;
  const missing: string[] = [];
  for (const [index, param] of positional.entries()) {
    if (bound.has(param.name)) continue;
    if (index >= defaultsStart) bound.set(param.name, fn.defaults[index - defaultsStart]);
    else missing.push(param.name);
  }
  if (missing.length > 0) {
    throw typeError(
      `${fn.qualifiedName}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${quoteNames(missing)}`
    );
  }
}

function bindKeywordDefaults(fn: PyFunction, keywordOnly: Parameter[], bound: Map<string, PyValue>): void {
  const missing: string[] = [];
  for (const param of keywordOnly) {
    if (bound.has(param.name)) continue;
    const value = fn.keywordDefaults.get(param.name);
    if (value === undefined) missing.push(param.name);
    else bound.set(param.name, value);
  }
  if (missing.length > 0) {
    throw typeError(
      `${fn.qualifiedName}() missing ${missing.length} required keyword-only argument${missing.length === 1 ? '' : 's'}: ${quoteNames(missing)}`
    );
  }
}
