import { pyStr } from '../conversions';
import { builtin, method } from '../define';
import { Frame } from '../frame';
import { getAttribute, isTruthy } from '../objects';
import { parsePython } from '../parse';
import { currentRuntime } from '../runtimeContext';
import {
  NoDefault,
  paramSpecClass,
  PyTypeParam,
  type TypeParamKind,
  type TypeParamParts,
  typeVarClass,
  typeVarTupleClass,
} from '../typeParams';
import { builtinClass, newDict, newTuple, None, noneClass, typeError, typeName, valueError } from '../types';
import { type Kwargs, PyClass, PyDict, PyFunction, PyInstance, type PyValue } from '../values';

/** The keyword arguments each kind of type parameter takes, beside its name. */
const KEYWORDS: Record<TypeParamKind, string[]> = {
  TypeVar: ['bound', 'covariant', 'contravariant', 'infer_variance', 'default'],
  ParamSpec: ['bound', 'covariant', 'contravariant', 'infer_variance', 'default'],
  TypeVarTuple: ['default'],
};

/** `TypeVar(name, *constraints, ...)`, `ParamSpec(name, ...)`, or `TypeVarTuple(name, ...)`. */
// code-gauge-allow functionNcss 35 -- Checks the arguments as each constructor of typevarobject.c does.
// code-gauge-allow functionCognitiveComplexity 20 -- Checks the arguments as each constructor of typevarobject.c does.
function newTypeParamFromCall(kind: TypeParamKind, args: PyValue[], kwargs: Kwargs): PyValue {
  const label = kind.toLowerCase();
  for (const key of kwargs?.keys() ?? []) {
    if (key !== 'name' && !KEYWORDS[kind].includes(key)) {
      throw typeError(`${label}() got an unexpected keyword argument '${key}'`);
    }
  }
  if (kind !== 'TypeVar' && args.length > 1) {
    throw typeError(`${label}() takes exactly 1 positional argument (${args.length} given)`);
  }
  const name = args[0] ?? kwargs?.get('name');
  if (name === undefined) throw typeError(`${label}() missing required argument 'name' (pos 1)`);
  if (typeof name !== 'string') throw typeError(`${label}() argument 'name' must be str, not ${typeName(name)}`);
  const option = (key: string): PyValue | undefined => kwargs?.get(key);
  const covariant = isTruthy(option('covariant') ?? false);
  const contravariant = isTruthy(option('contravariant') ?? false);
  const inferVariance = isTruthy(option('infer_variance') ?? false);
  if (covariant && contravariant) throw valueError('Bivariant types are not supported.');
  if (inferVariance && (covariant || contravariant)) {
    throw valueError('Variance cannot be specified with infer_variance.');
  }
  const constraints = args.slice(1);
  if (constraints.length === 1) throw typeError('A single constraint is not allowed');
  const bound = option('bound') ?? None;
  if (constraints.length > 0 && bound !== None) throw typeError('Constraints cannot be combined with bound=...');
  const defaultValue = option('default') ?? NoDefault;
  const parts: TypeParamParts = { covariant, contravariant, inferVariance };
  if (bound !== None) parts.bound = () => bound;
  if (constraints.length > 0) parts.constraints = () => newTuple(constraints);
  if (defaultValue !== NoDefault) parts.default = () => defaultValue;
  return new PyTypeParam(kind, name, parts);
}

typeVarClass.construct = (_cls, args, kwargs) => newTypeParamFromCall('TypeVar', args, kwargs);
paramSpecClass.construct = (_cls, args, kwargs) => newTypeParamFromCall('ParamSpec', args, kwargs);
typeVarTupleClass.construct = (_cls, args, kwargs) => newTypeParamFromCall('TypeVarTuple', args, kwargs);

// NewType ---------------------------------------------------------------------------------------------------------------

export const newTypeClass = builtinClass('NewType');
newTypeClass.module = 'typing';

/** A type made by `NewType(name, supertype)`, whose calls return their argument. */
export class PyNewType extends PyInstance {
  constructor(
    readonly name: string,
    readonly supertype: PyValue
  ) {
    super(newTypeClass);
    this.dict.set('__name__', name);
    this.dict.set('__qualname__', name);
    this.dict.set('__module__', '__main__');
    this.dict.set('__supertype__', supertype);
  }
}

newTypeClass.construct = (_cls, args, kwargs) => {
  const call = builtin('NewType', 'takes', 2, 2, ([name, supertype]) => new PyNewType(pyStr(name), supertype), {
    keywords: ['name', 'tp'],
  });
  return call.run(args, kwargs);
};
method(newTypeClass, '__call__', 'one', 1, 1, (_self, [value]) => value);
method(newTypeClass, '__repr__', 'none', 0, 0, (self) => `__main__.${(self as PyNewType).name}`);
method(newTypeClass, '__or__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(self, other));
method(newTypeClass, '__ror__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(other, self));

// get_type_hints --------------------------------------------------------------------------------------------------------

/** `typing.get_type_hints(obj)`: the annotations of a function or a class and its bases, with strings evaluated. */
export function getTypeHints(args: PyValue[], kwargs: Kwargs): PyValue {
  const [target] = args;
  if (kwargs?.get('globalns') !== undefined || kwargs?.get('localns') !== undefined || args.length > 1) {
    throw currentRuntime().unsupported('get_type_hints() の globalns・localns');
  }
  const hints = newDict();
  const runtime = currentRuntime();
  const mainGlobals = runtime.frames[0]?.globals ?? new Map<string, PyValue>();
  const sources: [PyValue, Map<string, PyValue>][] =
    target instanceof PyClass
      ? target.mro.toReversed().map((cls) => [classAnnotations(cls), mainGlobals])
      : [[getAttribute(target, '__annotations__'), target instanceof PyFunction ? target.globals : mainGlobals]];
  for (const [annotations, globals] of sources) {
    if (!(annotations instanceof PyDict)) continue;
    for (const entry of annotations.store.ordered()) {
      hints.store.set(entry.key, resolveHint(entry.value, globals));
    }
  }
  return hints;
}

function classAnnotations(cls: PyClass): PyValue {
  if (cls.isBuiltin) return None;
  return getAttribute(cls, '__annotations__');
}

/** A hint as `get_type_hints` gives it: a string evaluated as an expression, and None as NoneType. */
function resolveHint(hint: PyValue, globals: Map<string, PyValue>): PyValue {
  if (hint === None) return noneClass;
  if (typeof hint !== 'string') return hint;
  const module = parsePython(hint.trim());
  const [statement] = module.body;
  if (module.body.length !== 1 || statement.kind !== 'expression') {
    throw currentRuntime().unsupported(`get_type_hints() で、式でない文字列の型ヒント（${hint}）`);
  }
  const frame = new Frame('module', globals, new Map(), globals, undefined, false, module.scope);
  const value = currentRuntime().evaluator.evaluate(statement.expression, frame);
  return value === None ? noneClass : value;
}
