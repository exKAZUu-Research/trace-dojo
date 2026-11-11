import { bestSuggestion } from '../describe';
import { toIndex } from '../numbers';
import { defineMethod, nativeFunction, pyError, typeError } from '../types';
import type { Kwargs, PyBuiltinFunction, PyClass, PyValue } from '../values';

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
