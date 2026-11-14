import { isTruthy } from '../objects';
import { typeConvert } from '../typeHints';
import {
  NoDefault,
  paramSpecClass,
  PyTypeParam,
  type TypeParamKind,
  type TypeParamParts,
  typeVarClass,
  typeVarTupleClass,
} from '../typeParams';
import { newTuple, None, stringValue, typeError, typeName, valueError } from '../types';
import type { Kwargs, PyValue } from '../values';

/** The keyword arguments each kind of type parameter takes, beside its name. */
const KEYWORDS: Record<TypeParamKind, string[]> = {
  TypeVar: ['bound', 'covariant', 'contravariant', 'infer_variance', 'default'],
  ParamSpec: ['bound', 'covariant', 'contravariant', 'infer_variance', 'default'],
  TypeVarTuple: ['default'],
};

/** `TypeVar(name, *constraints, ...)`, `ParamSpec(name, ...)`, or `TypeVarTuple(name, ...)`. */
// code-gauge-allow functionCognitiveComplexity 20 -- Checks the arguments as each constructor of typevarobject.c does.
// code-gauge-allow functionNcss 31 -- Validates one native constructor while retaining its original name object.
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
  const nameValue = args[0] ?? kwargs?.get('name');
  const name = stringValue(nameValue) ?? nameValue;
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
  const [constraints, bound] = constraintsAndBound(args.slice(1), option('bound') ?? None);
  const defaultValue = option('default') ?? NoDefault;
  const parts: TypeParamParts = { covariant, contravariant, inferVariance };
  if (bound !== None) parts.bound = () => bound;
  if (constraints.length > 0) parts.constraints = () => newTuple(constraints);
  if (defaultValue !== NoDefault) parts.default = () => defaultValue;
  return new PyTypeParam(kind, name, parts, nameValue);
}

/** A TypeVar's constraints and bound, with strings as forward references, as typing's `_type_convert` makes them. */
function constraintsAndBound(given: PyValue[], givenBound: PyValue): [PyValue[], PyValue] {
  const constraints = given.map(typeConvert);
  if (constraints.length === 1) throw typeError('A single constraint is not allowed');
  const bound = givenBound === None ? None : typeConvert(givenBound);
  if (constraints.length > 0 && bound !== None) throw typeError('Constraints cannot be combined with bound=...');
  return [constraints, bound];
}

typeVarClass.construct = (_cls, args, kwargs) => newTypeParamFromCall('TypeVar', args, kwargs);
paramSpecClass.construct = (_cls, args, kwargs) => newTypeParamFromCall('ParamSpec', args, kwargs);
typeVarTupleClass.construct = (_cls, args, kwargs) => newTypeParamFromCall('TypeVarTuple', args, kwargs);
