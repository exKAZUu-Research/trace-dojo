import type { Parameter } from '../../ast';
import { bindArguments } from '../../calls';
import { typeError } from '../../types';
import type { Kwargs, PyFunction, PyValue } from '../../values';

/**
 * Reads the arguments of a builtin method whose parameters may be passed by position or keyword, with the errors of
 * CPython's Argument Clinic (`_PyArg_UnpackKeywords`).
 */
// code-gauge-allow functionCognitiveComplexity 17 -- Follows the checks of CPython's _PyArg_UnpackKeywords in their order.
export function clinicArgs(
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

export interface PythonParameter {
  name: string;
  kind: Parameter['kind'];
  default?: PyValue;
}

/** Binds the arguments of a function that CPython defines in Python, with the errors CPython raises for it. */
export function pythonArgs(
  name: string,
  params: readonly PythonParameter[],
  args: readonly PyValue[],
  kwargs: Kwargs
): Map<string, PyValue> {
  const positionalDefaults = params
    .filter((param) => param.kind === 'positional' && param.default !== undefined)
    .map((param) => param.default as PyValue);
  const keywordDefaults = new Map(
    params
      .filter((param) => param.kind === 'keywordOnly' && param.default !== undefined)
      .map((param) => [param.name, param.default as PyValue])
  );
  // bindArguments reads only the signature of a function, which these fields give.
  const signature = {
    def: { params: params.map((param) => ({ name: param.name, kind: param.kind, row: 0 })) },
    defaults: positionalDefaults,
    keywordDefaults,
    qualifiedName: name,
  } as unknown as PyFunction;
  return bindArguments(signature, args, kwargs);
}
