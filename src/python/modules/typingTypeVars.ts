import { CompileError } from '../../interpreter/diagnostics';
import type { Expression, ScopeInfo } from '../ast';
import { MappingNamespace } from '../classes';
import { pyRepr, pyStr } from '../conversions';
import { builtin, method } from '../define';
import { Frame } from '../frame';
import { namespaceOf } from '../namespaces';
import { getAttribute, isTruthy } from '../objects';
import { parseDynamicCode } from '../parse';
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
import {
  builtinClass,
  dictClass,
  exceptionClassNamed,
  newDict,
  newException,
  newTuple,
  None,
  noneClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import { type Kwargs, PyClass, PyDict, PyError, PyFunction, PyInstance, PyModule, type PyValue } from '../values';

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

/**
 * `typing.get_type_hints(obj, globalns=None, localns=None)`: the annotations of a function or module, or of a class
 * and its bases, with strings evaluated in the namespaces CPython chooses.
 */
export function getTypeHints(args: PyValue[], kwargs: Kwargs): PyValue {
  const [target, globalArgument, localArgument] = ['obj', 'globalns', 'localns'].map(
    (name, index) => args[index] ?? kwargs?.get(name) ?? None
  );
  const globalns = globalArgument === None ? undefined : namespaceOfMapping(globalArgument);
  const localns = localArgument === None ? undefined : namespaceOfMapping(localArgument);
  const hints = newDict();
  const runtime = currentRuntime();
  if (target instanceof PyClass) {
    for (const cls of target.mro.toReversed()) {
      const annotations = cls.isBuiltin ? undefined : getAttribute(cls, '__annotations__');
      if (!(annotations instanceof PyDict)) continue;
      let baseGlobals = globalns ?? moduleGlobals(cls.module);
      let baseLocals: Map<string, PyValue> = localns ?? new Map(cls.dict);
      // CPython swaps them when neither is given, so that the class's names shadow the module's.
      if (!globalns && !localns) [baseGlobals, baseLocals] = [baseLocals, baseGlobals];
      for (const entry of annotations.store.ordered()) {
        hints.store.set(entry.key, resolveHint(entry.value, baseGlobals, baseLocals));
      }
    }
    return hints;
  }
  const annotations = getAttribute(target, '__annotations__');
  const ownGlobals =
    target instanceof PyFunction
      ? target.globals
      : target instanceof PyModule
        ? target.dict
        : new Map<string, PyValue>();
  const globals = globalns ?? ownGlobals;
  if (annotations instanceof PyDict) {
    for (const entry of annotations.store.ordered()) {
      hints.store.set(entry.key, resolveHint(entry.value, globals, localns ?? globals));
    }
  }
  runtime.allocate(hints.store.size + 1);
  return hints;
}

function namespaceOfMapping(value: PyValue): Map<string, PyValue> {
  return value instanceof PyDict && value.cls === dictClass ? namespaceOf(value) : new MappingNamespace(value);
}

function moduleGlobals(name: string): Map<string, PyValue> {
  const module = currentRuntime().modules.get(name);
  if (module) return module.dict;
  return name === '__main__' ? (currentRuntime().frames[0]?.globals ?? new Map()) : new Map();
}

/** A hint as `get_type_hints` gives it: a string evaluated as an expression, and None as NoneType. */
function resolveHint(hint: PyValue, globals: Map<string, PyValue>, locals: Map<string, PyValue>): PyValue {
  if (hint === None) return noneClass;
  if (typeof hint !== 'string') return hint;
  const expression = forwardReference(hint);
  const runtime = currentRuntime();
  const frame = new Frame('module', locals, new Map(), globals, undefined, true, expression.scope);
  const value = runtime.evaluator.evaluate(expression.expression, frame);
  return value === None ? noneClass : value;
}

/** The expression a string hint holds, as `ForwardRef.__forward_code__` compiles it. */
function forwardReference(hint: string): { expression: Expression; scope: ScopeInfo } {
  const invalid = (): PyError =>
    new PyError(
      newException(exceptionClassNamed('SyntaxError'), [
        `Forward reference must be an expression -- got ${pyRepr(hint)}`,
      ])
    );
  let module;
  try {
    module = parseDynamicCode(hint.trimStart().startsWith('*') ? `(${hint},)[0]` : hint);
  } catch (error) {
    if (error instanceof CompileError) throw invalid();
    throw error;
  }
  const [statement] = module.body;
  if (module.body.length !== 1 || statement.kind !== 'expression') throw invalid();
  return { expression: statement.expression, scope: module.scope };
}
