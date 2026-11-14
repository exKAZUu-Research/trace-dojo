// Argument parsing of the `datetime` module, whose C functions use `PyArg_ParseTupleAndKeywords` and word their
// errors after it.
import { toIndex } from '../numbers';
import { pyError, typeError } from '../types';
import type { Kwargs, PyValue } from '../values';

export interface CSignature {
  names: readonly string[];
  /** How many leading parameters are required. */
  required: number;
  /** How many leading parameters may be passed positionally; the rest are keyword-only. */
  positional?: number;
  /** The name in messages, which CPython's constructors leave out as `function`. */
  name?: string;
}

/**
 * Reads the arguments of a C function as `PyArg_ParseTupleAndKeywords` does, converting each with `convert` in order,
 * so that the first error matches CPython's.
 */
export function parseCArgs<T>(
  signature: CSignature,
  args: readonly PyValue[],
  kwargs: Kwargs,
  convert: (value: PyValue, index: number) => T
): (T | undefined)[] {
  const fname = signature.name === undefined ? 'function' : `${signature.name}()`;
  checkCounts(signature, fname, args, kwargs);
  const positional = signature.positional ?? signature.names.length;
  const values: (T | undefined)[] = [];
  let remaining = kwargs?.size ?? 0;
  for (const [index, name] of signature.names.entries()) {
    let value: PyValue | undefined = args[index];
    if (value === undefined && remaining > 0) {
      value = kwargs?.get(name);
      if (value !== undefined) remaining--;
    }
    if (value !== undefined) values.push(convert(value, index));
    else if (index < signature.required) throw missingError(fname, name, index, positional);
    else values.push(undefined);
  }
  if (remaining > 0) checkKeywords(signature.names, fname, args, kwargs);
  return values;
}

function checkCounts(signature: CSignature, fname: string, args: readonly PyValue[], kwargs: Kwargs): void {
  const { names, required } = signature;
  const positional = signature.positional ?? names.length;
  const total = args.length + (kwargs?.size ?? 0);
  if (total > names.length) {
    const keyword = args.length === 0 ? 'keyword ' : '';
    throw typeError(
      `${fname} takes at most ${names.length} ${keyword}argument${plural(names.length)} (${total} given)`
    );
  }
  if (args.length > positional) {
    const bound = required < positional ? 'at most' : 'exactly';
    throw typeError(
      `${fname} takes ${bound} ${positional} positional argument${plural(positional)} (${args.length} given)`
    );
  }
}

const plural = (count: number): string => (count === 1 ? '' : 's');

function missingError(fname: string, name: string, index: number, positional: number): Error {
  return typeError(
    index < positional
      ? `${fname} missing required argument '${name}' (pos ${index + 1})`
      : `${fname} missing required keyword-only argument '${name}'`
  );
}

/** Rejects a keyword that repeats a positional argument or that the function does not take. */
function checkKeywords(names: readonly string[], fname: string, args: readonly PyValue[], kwargs: Kwargs): void {
  for (let index = 0; index < args.length; index++) {
    if (kwargs?.has(names[index])) {
      throw typeError(`argument for ${fname} given by name ('${names[index]}') and position (${index + 1})`);
    }
  }
  for (const key of kwargs?.keys() ?? []) {
    if (!names.includes(key)) throw typeError(`'${key}' is an invalid keyword argument for ${fname}`);
  }
}

/** Converts an argument as the `i` format does, to a C int. */
export function cInt(value: PyValue): number {
  const integer = toIndex(value);
  if (integer > 2_147_483_647n) throw pyError('OverflowError', 'signed integer is greater than maximum');
  if (integer < -2_147_483_648n) throw pyError('OverflowError', 'signed integer is less than minimum');
  return Number(integer);
}
