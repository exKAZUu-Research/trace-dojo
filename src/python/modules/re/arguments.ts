import type { Parameter } from '../../ast';
import { bindArguments } from '../../calls';
import type { Kwargs, PyFunction, PyValue } from '../../values';

export { unpackKeywords as clinicArgs } from '../clinicArgs';

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
