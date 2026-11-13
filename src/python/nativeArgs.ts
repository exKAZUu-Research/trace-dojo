import { pushAll } from './arrays';
import { bindArguments, type Signature } from './calls';
import { bestSuggestion } from './describe';
import { typeError } from './types';
import type { Kwargs, PyTuple, PyValue } from './values';

/**
 * How CPython words an argument-count error for a builtin, which depends on how the builtin parses its arguments:
 * `one` and `none` for single-argument and argument-less builtins (METH_O and METH_NOARGS), `expected` for
 * positional-only parsers, `takes` for the parsers that also bind keywords to parameters, and `wrapper` for the
 * special methods a type implements in a slot, which take a fixed number of arguments.
 */
export type ArgStyle = 'one' | 'none' | 'expected' | 'takes' | 'wrapper';

export interface ArgSpec {
  /**
   * The name in messages of the `one`, `none`, and no-keyword kinds, which CPython qualifies with the type or the C
   * module: `len`, `list.append`, `math.sqrt`, or `_heapq.heappop`.
   */
  qualified: string;
  /** The name in messages of the `expected` and `takes` kinds, such as `pop`. */
  short?: string;
  min: number;
  max: number;
  style: ArgStyle;
  /** The keyword arguments the builtin accepts, which it reads itself. */
  keywords?: readonly string[];
  /**
   * How many of the first `keywords` name the last positional parameters in order, which may be passed either way;
   * the positional parameters before them are positional-only.
   */
  named?: number;
}

const plural = (count: number): string => (count === 1 ? '' : 's');

/** Checks the number of positional arguments and that only accepted keywords are passed, as CPython does. */
export function checkArgs(spec: ArgSpec, args: readonly PyValue[], kwargs: Kwargs): void {
  const { qualified, min, max, style } = spec;
  const short = spec.short ?? qualified.split('.').at(-1) ?? qualified;
  const accepted = spec.keywords ?? [];
  const count = args.length;
  if (style === 'wrapper') return checkWrapper(short, min, max, count, kwargs);
  if (kwargs && kwargs.size > 0 && accepted.length === 0) throw typeError(`${qualified}() takes no keyword arguments`);
  if (style === 'takes') {
    checkKeywordParser(short, spec, accepted, args, kwargs);
  } else if (style === 'expected') {
    checkPositional(`${short} `, min, max, count);
    // Such a builtin parses its keywords apart from its positional arguments.
    checkKeywordParser(short, { ...spec, min: 0, max: 0, named: 0 }, accepted, [], kwargs);
  } else if (style === 'one' ? count !== 1 : count !== 0) {
    throw typeError(
      `${qualified}() takes ${style === 'one' ? 'exactly one argument' : 'no arguments'} (${count} given)`
    );
  }
}

/** Follows the wrappers of slots (Objects/typeobject.c), which name the method only when it takes two arguments. */
function checkWrapper(short: string, min: number, max: number, count: number, kwargs: Kwargs): void {
  if (kwargs && kwargs.size > 0) throw typeError(`wrapper ${short}() takes no keyword arguments`);
  if (min !== max && (count < min || count > max)) {
    throw typeError(`expected ${min} or ${max} arguments, got ${count}`);
  }
  checkPositional(max >= 2 ? `${short} ` : '', min, max, count);
}

function checkPositional(prefix: string, min: number, max: number, count: number): void {
  if (count >= min && count <= max) return;
  const bound = count < min ? min : max;
  const limit = min === max ? '' : count < min ? 'at least ' : 'at most ';
  throw typeError(`${prefix}expected ${limit}${bound} argument${plural(bound)}, got ${count}`);
}

function checkKeywordNames(short: string, accepted: readonly string[], kwargs: Kwargs): void {
  for (const key of kwargs?.keys() ?? []) {
    if (accepted.includes(key)) continue;
    const suggestion = bestSuggestion(key, [...accepted]);
    throw typeError(
      `${short}() got an unexpected keyword argument '${key}'${suggestion ? `. Did you mean '${suggestion}'?` : ''}`
    );
  }
}

/** Follows `_PyArg_UnpackKeywords` (Python/getargs.c), whose checks run in this order. */
function checkKeywordParser(
  short: string,
  { min, max, named = 0 }: ArgSpec,
  names: readonly string[],
  args: readonly PyValue[],
  kwargs: Kwargs
): void {
  // A builtin taking any number of positional arguments parses its keywords alone.
  const count = Number.isFinite(max) ? args.length : 0;
  const given = count + (kwargs?.size ?? 0);
  const positionalOnly = Number.isFinite(max) ? max - named : 0;
  const total = positionalOnly + names.length;
  if (given > total) {
    const kind = count === 0 ? 'keyword ' : '';
    throw typeError(`${short}() takes at most ${total} ${kind}argument${plural(total)} (${given} given)`);
  }
  if (count > max)
    throw typeError(`${short}() takes ${positionalLimit(min < max ? 'at most' : 'exactly', max, count)}`);
  const required = Math.min(positionalOnly, min);
  if (count < required) {
    throw typeError(`${short}() takes ${positionalLimit(required < max ? 'at least' : 'exactly', required, count)}`);
  }
  checkNamed(short, names.slice(0, named), positionalOnly, min, count, kwargs);
  checkKeywordNames(short, names, kwargs);
}

function positionalLimit(limit: string, bound: number, count: number): string {
  if (bound === 0) return 'no positional arguments';
  return `${limit} ${bound} positional argument${plural(bound)} (${count} given)`;
}

/** Checks parameters that may be passed by position or by name: the required ones at all, and each only once. */
function checkNamed(
  short: string,
  names: readonly string[],
  positionalOnly: number,
  min: number,
  count: number,
  kwargs: Kwargs
): void {
  for (const [offset, name] of names.entries()) {
    const index = positionalOnly + offset;
    if (index >= count && index < min && !kwargs?.has(name)) {
      throw typeError(`${short}() missing required argument '${name}' (pos ${index + 1})`);
    }
  }
  for (const [offset, name] of names.entries()) {
    const index = positionalOnly + offset;
    if (index < count && kwargs?.has(name)) {
      throw typeError(`argument for ${short}() given by name ('${name}') and position (${index + 1})`);
    }
  }
}

/** Reads a keyword argument, or a positional one at `index`, or undefined when neither was passed. */
export function argument(args: readonly PyValue[], kwargs: Kwargs, index: number, name: string): PyValue | undefined {
  return args[index] ?? kwargs?.get(name);
}

/** Stands for the default of a native function's parameter: natives apply their defaults themselves. */
const OMITTED = Symbol('omitted') as unknown as PyValue;

/**
 * The signature of a native function that CPython's library writes in Python, which reports a wrong call in the words
 * of a `def`, such as `mean() missing 1 required positional argument: 'data'`. `parameters` are written as in that
 * `def`, such as `population, weights=None, *, k=1`; only whether one has a default matters, not the default's value.
 */
// code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of parameter in a def's parameter list.
export function pythonSignature(qualifiedName: string, parameters: string): Signature {
  const params: Signature['def']['params'] = [];
  const defaults: PyValue[] = [];
  const keywordDefaults = new Map<string, PyValue>();
  let isKeywordOnly = false;
  for (const text of parameters.split(',').map((each) => each.trim())) {
    if (text === '') continue;
    if (text === '/') {
      for (const param of params) param.kind = 'positionalOnly';
    } else if (text.startsWith('**')) {
      params.push({ name: text.slice(2), kind: 'varKeywords' });
    } else if (text.startsWith('*')) {
      isKeywordOnly = true;
      if (text !== '*') params.push({ name: text.slice(1), kind: 'varArgs' });
    } else {
      const [name, defaultText] = text.split('=').map((each) => each.trim());
      params.push({ name, kind: isKeywordOnly ? 'keywordOnly' : 'positional' });
      if (defaultText === undefined) continue;
      if (isKeywordOnly) keywordDefaults.set(name, OMITTED);
      else defaults.push(OMITTED);
    }
  }
  return { qualifiedName, def: { params }, defaults, keywordDefaults };
}

/**
 * Checks a call as a Python function of `signature` does and returns its positional arguments in parameter order,
 * including the ones passed by name, followed by the ones `*args` takes. An omitted parameter is undefined, and the
 * trailing omitted ones are left out; the keyword-only ones stay in `kwargs`.
 */
export function bindPythonArgs(signature: Signature, args: readonly PyValue[], kwargs: Kwargs): PyValue[] {
  const bound = bindArguments(signature, args, kwargs);
  const values: (PyValue | undefined)[] = [];
  for (const { name, kind } of signature.def.params) {
    const value = bound.get(name);
    if (kind === 'positionalOnly' || kind === 'positional') values.push(value === OMITTED ? undefined : value);
    else if (kind === 'varArgs') pushAll(values, (value as PyTuple).items);
  }
  while (values.length > 0 && values.at(-1) === undefined) values.pop();
  return values as PyValue[];
}
