import { namespaceOf } from './namespaces';
import { argument } from './nativeArgs';
import { toArray } from './objects';
import { codeClass, infoOf } from './tracebacks';
import { functionClass, None, typeError, typeName } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { type PyCell, PyDict, PyFunction, PyOpaque, PyTuple, type PyValue } from './values';

const PARAMETERS = ['code', 'globals', 'name', 'argdefs', 'closure', 'kwdefaults'];

/**
 * `types.FunctionType(code, globals, name=None, argdefs=None, closure=None, kwdefaults=None)`: a function of the
 * code of a function this grader ran, with other globals, defaults, or cells.
 */
functionClass.construct = (_cls, args, kwargs) => {
  if (args.length > 6) throw typeError(`function() takes at most 6 arguments (${args.length} given)`);
  const [code, globals, name, argdefs, closure, kwdefaults] = PARAMETERS.map((parameter, index) =>
    argument(args, kwargs, index, parameter)
  );
  if (!(code instanceof PyOpaque) || code.cls !== codeClass) {
    throw typeError(`function() argument 'code' must be code, not ${typeName(code ?? None)}`);
  }
  if (!(globals instanceof PyDict))
    throw typeError(`function() argument 'globals' must be dict, not ${typeName(globals ?? None)}`);
  const original = infoOf(code).fn;
  if (!original) throw new UnsupportedFeatureError('関数でないコード（モジュールやクラスの本体）から作る関数');
  const fn = new PyFunction(
    functionClass,
    original.def,
    namespaceOf(globals),
    cellsOf(original, closure),
    argdefs === undefined || argdefs === None ? [] : defaultsOf(argdefs),
    kwdefaults instanceof PyDict ? new Map(namespaceOf(kwdefaults)) : new Map(),
    original.classCell
  );
  if (typeof name === 'string') fn.name = name;
  else if (name !== undefined && name !== None)
    throw typeError(`arg 3 (name) must be None or string, not ${typeName(name)}`);
  return fn;
};

function defaultsOf(argdefs: PyValue): PyValue[] {
  if (!(argdefs instanceof PyTuple))
    throw typeError(`arg 4 (defaults) must be None or tuple, not ${typeName(argdefs)}`);
  return [...argdefs.items];
}

/** The cells of the new function: those given, by the free variables of the code, or none for a code without any. */
function cellsOf(original: PyFunction, closure: PyValue | undefined): Map<string, PyCell> {
  const names = [...original.closure.keys()];
  if (closure === undefined || closure === None) {
    if (names.length > 0) throw typeError(`${original.name} requires closure of length ${names.length}, not 0`);
    return new Map();
  }
  const cells = toArray(closure) as PyCell[];
  if (cells.length !== names.length) {
    throw typeError(`${original.name} requires closure of length ${names.length}, not ${cells.length}`);
  }
  return new Map(names.map((key, index) => [key, cells[index] as PyCell]));
}
