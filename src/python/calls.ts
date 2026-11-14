import type { Parameter } from './ast';
import { keywordEntries } from './callArguments';
import { bestSuggestion } from './describe';
import { equals } from './operators';
import { newDict, newTuple, stringValue, typeError } from './types';
import type { Kwargs, PyDict, PyFunction, PyValue } from './values';

/** What binding needs of a function, which a native function that CPython's library writes in Python also gives. */
export type Signature = Pick<PyFunction, 'qualifiedName' | 'defaults' | 'keywordDefaults'> & {
  def: { params: Pick<Parameter, 'name' | 'kind'>[] };
};
type SignatureParameter = Signature['def']['params'][number];

/** Binds call arguments to a function's parameters, raising the TypeError CPython raises for a mismatch. */
export function bindArguments(fn: Signature, args: readonly PyValue[], kwargs: Kwargs): Map<string, PyValue> {
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

function bindKeywords(fn: Signature, kwargs: Kwargs, bound: Map<string, PyValue>, extra: PyDict | undefined): void {
  const { params } = fn.def;
  const positionalOnlyAsKeyword: string[] = [];
  for (const [rawKey, value] of keywordEntries(kwargs)) {
    const key = stringValue(rawKey) as string;
    const param = params.find(
      (candidate) => equals(rawKey, candidate.name) && candidate.kind !== 'varArgs' && candidate.kind !== 'varKeywords'
    );
    if (param?.kind === 'positionalOnly' || !param) {
      if (extra) extra.store.set(rawKey, value);
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

function unexpectedKeyword(fn: Signature, key: string): Error {
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
  fn: Signature,
  positional: SignatureParameter[],
  keywordOnly: SignatureParameter[],
  given: number,
  kwargs: Kwargs
): Error {
  const keywordOnlyGiven = keywordOnly.filter((param) => kwargs?.has(param.name)).length;
  return tooManyPositionalError(fn.qualifiedName, positional.length, fn.defaults.length, given, keywordOnlyGiven);
}

/** The TypeError CPython raises when a call passes more positional arguments than a function takes. */
function tooManyPositionalError(
  qualifiedName: string,
  total: number,
  defaults: number,
  given: number,
  keywordOnlyGiven = 0
): Error {
  const signature = defaults > 0 ? `from ${total - defaults} to ${total}` : String(total);
  const plural = defaults > 0 || total !== 1;
  const keywordOnlyText =
    keywordOnlyGiven > 0
      ? ` positional argument${given === 1 ? '' : 's'} (and ${keywordOnlyGiven} keyword-only argument${keywordOnlyGiven === 1 ? '' : 's'})`
      : '';
  const verb = given === 1 && keywordOnlyGiven === 0 ? 'was' : 'were';
  return typeError(
    `${qualifiedName}() takes ${signature} positional argument${plural ? 's' : ''} but ${given}${keywordOnlyText} ${verb} given`
  );
}

function bindPositionalDefaults(fn: Signature, positional: SignatureParameter[], bound: Map<string, PyValue>): void {
  const defaultsStart = positional.length - fn.defaults.length;
  const missing: string[] = [];
  for (const [index, param] of positional.entries()) {
    if (bound.has(param.name)) continue;
    if (index >= defaultsStart) bound.set(param.name, fn.defaults[index - defaultsStart]);
    else missing.push(param.name);
  }
  if (missing.length > 0) throw missingPositionalError(fn.qualifiedName, missing);
}

/** The TypeError CPython raises when a call leaves required positional parameters unbound. */
function missingPositionalError(qualifiedName: string, missing: string[]): Error {
  return typeError(
    `${qualifiedName}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${quoteNames(missing)}`
  );
}

function bindKeywordDefaults(fn: Signature, keywordOnly: SignatureParameter[], bound: Map<string, PyValue>): void {
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

function quoteNames(names: string[]): string {
  const quoted = names.map((name) => `'${name}'`);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted.at(-1)}`;
}
