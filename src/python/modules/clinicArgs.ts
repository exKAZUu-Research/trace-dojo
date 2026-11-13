import { bestSuggestion } from '../describe';
import { toIndex } from '../numbers';
import { defineMethod, nativeFunction, pyError, typeError } from '../types';
import type { Kwargs, PyBuiltinFunction, PyClass, PyValue } from '../values';

/**
 * Reads the arguments of a builtin method whose parameters may be passed by position or keyword, with the errors of
 * CPython's Argument Clinic (`_PyArg_UnpackKeywords`).
 */
// code-gauge-allow functionCognitiveComplexity 17 -- Follows the checks of CPython's _PyArg_UnpackKeywords in their order.
export function unpackKeywords(
  name: string,
  params: readonly string[],
  required: number,
  args: readonly PyValue[],
  kwargs: Kwargs
): (PyValue | undefined)[] {
  const keywordCount = kwargs?.size ?? 0;
  const max = params.length;
  const given = args.length + keywordCount;
  if (given > max) {
    const keyword = args.length === 0 ? 'keyword ' : '';
    throw typeError(`${name}() takes at most ${max} ${keyword}argument${max === 1 ? '' : 's'} (${given} given)`);
  }
  const values: (PyValue | undefined)[] = [...args];
  let remaining = keywordCount;
  for (let index = args.length; index < max; index++) {
    const value = remaining > 0 ? kwargs?.get(params[index]) : undefined;
    if (value !== undefined) {
      values[index] = value;
      remaining--;
    } else if (index < required) {
      throw typeError(`${name}() missing required argument '${params[index]}' (pos ${index + 1})`);
    }
  }
  if (remaining > 0) {
    for (let index = 0; index < args.length; index++) {
      if (kwargs?.has(params[index]))
        throw typeError(`argument for ${name}() given by name ('${params[index]}') and position (${index + 1})`);
    }
    const unexpected = [...(kwargs?.keys() ?? [])].find((key) => !params.includes(key));
    throw typeError(`${name}() got an unexpected keyword argument '${unexpected}'`);
  }
  return values;
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

/** Binds the arguments of a call to `spec`'s parameters, raising Argument Clinic's errors. */
// code-gauge-allow functionCognitiveComplexity 20 -- Raises each of the errors of CPython's argument clinic parser in its order.
export function clinicArgs(spec: ClinicSpec, args: readonly PyValue[], kwargs: Kwargs): (PyValue | undefined)[] {
  const { name, params, positionalOnly, required, keywordOnly = [] } = spec;
  if (args.length > params.length) {
    const exact = required === params.length;
    const kind = exact || keywordOnly.length > 0 ? 'positional ' : '';
    throw typeError(
      `${name}() takes ${exact ? 'exactly' : 'at most'} ${params.length} ${kind}argument${plural(params.length)} (${args.length} given)`
    );
  }
  const requiredPositional = Math.min(required, positionalOnly);
  if (args.length < requiredPositional) {
    const exact = requiredPositional === params.length;
    throw typeError(
      `${name}() takes ${exact ? 'exactly' : 'at least'} ${requiredPositional} positional argument${plural(requiredPositional)} (${args.length} given)`
    );
  }
  const names = [...params, ...keywordOnly];
  const bound: (PyValue | undefined)[] = names.map((_, index) => args[index]);
  for (const [key, value] of kwargs ?? []) {
    const index = names.indexOf(key);
    if (index < positionalOnly) {
      const suggestion = bestSuggestion(key, names.slice(positionalOnly));
      throw typeError(
        `${name}() got an unexpected keyword argument '${key}'${suggestion ? `. Did you mean '${suggestion}'?` : ''}`
      );
    }
    if (index < args.length) {
      throw typeError(`argument for ${name}() given by name ('${key}') and position (${index + 1})`);
    }
    bound[index] = value;
  }
  for (let index = 0; index < required; index++) {
    if (bound[index] !== undefined) continue;
    throw typeError(`${name}() missing required argument '${params[index]}' (pos ${index + 1})`);
  }
  return bound;
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
