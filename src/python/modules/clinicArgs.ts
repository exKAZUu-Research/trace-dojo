import { keywordEntries, unicodeKeywords } from '../callArguments';
import { pyStr } from '../conversions';
import { bestSuggestion } from '../describe';
import { toIndex } from '../numbers';
import { equals } from '../operators';
import { defineMethod, nativeFunction, pyError, stringValue, typeError } from '../types';
import type { Kwargs, PyBuiltinFunction, PyClass, PyValue } from '../values';

export function unpackKeywords(
  name: string,
  params: readonly string[],
  required: number,
  args: readonly PyValue[],
  kwargs: Kwargs
): (PyValue | undefined)[] {
  return unpackCArguments({ name, params, required, positionalOnly: 0 }, args, kwargs);
}

/** The parameters of a builtin whose arguments CPython's Argument Clinic parses. */
export interface ClinicSpec {
  name: string;
  /** The names of the positional parameters, the first `positionalOnly` of them positional-only. */
  params: readonly string[];
  positionalOnly: number;
  /** How many leading parameters are required. */
  required: number;
  /** The names of the keyword-only parameters, which follow the positional ones in the bound arguments. */
  keywordOnly?: readonly string[];
}

const plural = (count: number): string => (count === 1 ? '' : 's');

export interface CKeywordSpec extends Omit<ClinicSpec, 'name'> {
  name?: string;
  legacy?: boolean;
}

export function clinicArgs(spec: ClinicSpec, args: readonly PyValue[], kwargs: Kwargs): (PyValue | undefined)[] {
  return unpackCArguments(spec, args, unicodeKeywords(kwargs, spec.name));
}

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps CPython's argument count, required parameter and keyword checks in precedence order.
// code-gauge-allow functionNcss 31 -- Keeps CPython's argument count, required parameter and keyword checks in precedence order.
export function unpackCArguments(
  spec: CKeywordSpec,
  args: readonly PyValue[],
  kwargs: Kwargs
): (PyValue | undefined)[] {
  const { name, params, positionalOnly, required, keywordOnly = [] } = spec;
  const names = [...params, ...keywordOnly];
  const label = name === undefined ? 'function' : `${name}()`;
  const keywordCount = kwargs?.size ?? 0;
  const given = args.length + keywordCount;
  if (given > names.length) {
    const keyword = args.length === 0 ? 'keyword ' : '';
    throw typeError(
      `${label} takes at most ${names.length} ${keyword}argument${plural(names.length)} (${given} given)`
    );
  }
  if (args.length > params.length) {
    if (params.length === 0) throw typeError(`${label} takes no positional arguments`);
    const exact = required === (spec.legacy ? names.length : params.length);
    throw typeError(
      `${label} takes ${exact ? 'exactly' : 'at most'} ${params.length} positional argument${plural(params.length)} (${args.length} given)`
    );
  }
  const requiredPositional = Math.min(required, positionalOnly);
  if (args.length < requiredPositional) {
    const exact = requiredPositional === params.length;
    throw typeError(
      `${label} takes ${exact ? 'exactly' : 'at least'} ${requiredPositional} positional argument${plural(requiredPositional)} (${args.length} given)`
    );
  }
  const bound: (PyValue | undefined)[] = [...args];
  let remaining = keywordCount;
  for (let index = Math.max(args.length, positionalOnly); index < names.length; index++) {
    const value = remaining > 0 ? kwargs?.get(names[index]) : undefined;
    if (value !== undefined) {
      bound[index] = value;
      remaining--;
    } else if (index < required) {
      throw typeError(`${label} missing required argument '${names[index]}' (pos ${index + 1})`);
    }
  }
  if (remaining > 0) rejectRemainingKeywords(spec, args.length, kwargs);
  return bound;
}

function rejectRemainingKeywords(spec: CKeywordSpec, positional: number, kwargs: Kwargs): never {
  const { name, params, positionalOnly, keywordOnly = [] } = spec;
  const label = name === undefined ? 'function' : `${name}()`;
  for (let index = positionalOnly; index < positional; index++) {
    if (kwargs?.has(params[index]))
      throw typeError(`argument for ${label} given by name ('${params[index]}') and position (${index + 1})`);
  }
  const accepted = [...params.slice(positionalOnly), ...keywordOnly];
  const unexpected = keywordEntries(kwargs).find(([key]) =>
    spec.legacy ? !accepted.includes(stringValue(key) as string) : !accepted.some((name) => equals(name, key))
  );
  const callable = name === undefined ? 'this function' : `${name}()`;
  if (unexpected === undefined) throw typeError(`invalid keyword argument for ${callable}`);
  const key = unexpected[0];
  const suggestion = bestSuggestion(stringValue(key) as string, accepted);
  throw typeError(
    `${callable} got an unexpected keyword argument '${pyStr(key)}'${suggestion ? `. Did you mean '${suggestion}'?` : ''}`
  );
}

/** A builtin function whose arguments Argument Clinic parses into `spec`'s parameters. */
export function clinicFunction(
  spec: ClinicSpec,
  run: (bound: (PyValue | undefined)[]) => PyValue,
  owner?: string
): PyBuiltinFunction {
  return nativeFunction(spec.name, (args, kwargs) => run(clinicArgs(spec, args, kwargs)), owner);
}

/** A builtin method whose arguments Argument Clinic parses into `spec`'s parameters. */
export function clinicMethod(
  cls: PyClass,
  spec: ClinicSpec,
  run: (self: PyValue, bound: (PyValue | undefined)[]) => PyValue
): void {
  defineMethod(cls, spec.name, (self, args, kwargs) => run(self, clinicArgs(spec, args, kwargs)));
}

/** Converts an argument as the `i` format does: an integer that fits a C int. */
export function cInt(value: PyValue | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = toIndex(value);
  if (result > 2_147_483_647n || result < -2_147_483_648n) {
    throw pyError('OverflowError', 'Python int too large to convert to C int');
  }
  return Number(result);
}

/** Converts an argument as the `n` format does: an integer that fits a C ssize_t. */
export function cSsize(value: PyValue | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = toIndex(value);
  if (result > 9_223_372_036_854_775_807n || result < -9_223_372_036_854_775_808n) {
    throw pyError('OverflowError', 'Python int too large to convert to C ssize_t');
  }
  return Number(result);
}
