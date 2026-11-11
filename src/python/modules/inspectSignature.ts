import { functionAnnotations } from '../annotations';
import { pyRepr } from '../conversions';
import { method } from '../define';
import { callValue, getAttribute, getAttributeOrUndefined, isCallable } from '../objects';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  defineMethod,
  intClass,
  newDict,
  newTuple,
  None,
  typeError,
  typeName,
  valueError,
} from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import {
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyFunction,
  PyInstance,
  PyOpaque,
  type PyValue,
} from '../values';
import { type Partial, partialClass } from './functools';
import { bindArguments, defineProperty } from './numberSupport';

// Classes -----------------------------------------------------------------------------------------------------------

/** `inspect._empty`, which marks a parameter without a default or an annotation. */
export const emptyClass = builtinClass('_empty');
emptyClass.module = 'inspect';

const KIND_NAMES = ['POSITIONAL_ONLY', 'POSITIONAL_OR_KEYWORD', 'VAR_POSITIONAL', 'KEYWORD_ONLY', 'VAR_KEYWORD'];
const KIND_DESCRIPTIONS = [
  'positional-only',
  'positional or keyword',
  'variadic positional',
  'keyword-only',
  'variadic keyword',
];

/** `inspect._ParameterKind`, an IntEnum. */
const kindClass = builtinClass('_ParameterKind', intClass);
kindClass.module = 'inspect';
export const KINDS = KIND_NAMES.map((_name, index) => {
  const kind = new PyInstance(kindClass);
  kind.primitive = BigInt(index);
  return kind;
});
const kindIndex = (kind: PyValue): number => KINDS.indexOf(kind as PyInstance);
method(
  kindClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<_ParameterKind.${KIND_NAMES[kindIndex(self)]}: ${kindIndex(self)}>`
);
method(kindClass, '__str__', 'none', 0, 0, (self) => KIND_NAMES[kindIndex(self)]);
defineProperty(kindClass, 'name', (self) => KIND_NAMES[kindIndex(self)]);
defineProperty(kindClass, 'value', (self) => BigInt(kindIndex(self)));
defineProperty(kindClass, 'description', (self) => KIND_DESCRIPTIONS[kindIndex(self)]);

const Kind = { PositionalOnly: 0, PositionalOrKeyword: 1, VarPositional: 2, KeywordOnly: 3, VarKeyword: 4 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

interface Parameter {
  name: string;
  kind: Kind;
  default: PyValue;
  annotation: PyValue;
}

interface Signature {
  parameters: PyOpaque[];
  returnAnnotation: PyValue;
}

export const parameterClass = builtinClass('Parameter');
parameterClass.module = 'inspect';
export const signatureClass = builtinClass('Signature');
signatureClass.module = 'inspect';

function parameterOf(value: PyValue): Parameter {
  return (value as PyOpaque).data as Parameter;
}

function signatureOf(value: PyValue): Signature {
  return (value as PyOpaque).data as Signature;
}

for (const [index, name] of KIND_NAMES.entries()) parameterClass.dict.set(name, KINDS[index]);
parameterClass.dict.set('empty', emptyClass);
signatureClass.dict.set('empty', emptyClass);
defineProperty(parameterClass, 'name', (self) => parameterOf(self).name);
defineProperty(parameterClass, 'kind', (self) => KINDS[parameterOf(self).kind]);
defineProperty(parameterClass, 'default', (self) => parameterOf(self).default);
defineProperty(parameterClass, 'annotation', (self) => parameterOf(self).annotation);
method(parameterClass, '__str__', 'none', 0, 0, (self) => formatParameter(parameterOf(self)));
method(parameterClass, '__repr__', 'none', 0, 0, (self) => `<Parameter "${formatParameter(parameterOf(self))}">`);
parameterClass.construct = (_cls, args, kwargs) => {
  const [name, kind, defaultValue, annotation] = bindArguments(
    { qualified: 'Parameter', params: ['name', 'kind', 'default', 'annotation'], required: 2, isFunction: true },
    args,
    kwargs
  );
  if (typeof name !== 'string') throw typeError(`name must be a str, not a ${typeName(name as PyValue)}`);
  if (kindIndex(kind as PyValue) === -1)
    throw valueError(`value ${pyRepr(kind as PyValue)} is not a valid Parameter.kind`);
  return newParameter({
    name,
    kind: kindIndex(kind as PyValue) as Kind,
    default: defaultValue ?? emptyClass,
    annotation: annotation ?? emptyClass,
  });
};

defineProperty(signatureClass, 'parameters', (self) => {
  const ordered = currentRuntime().importModule('collections').dict.get('OrderedDict') as PyValue;
  const pairs = signatureOf(self).parameters.map((parameter) =>
    currentRuntime().tuple([parameterOf(parameter).name, parameter])
  );
  return callValue(ordered, [currentRuntime().listOf(pairs)]);
});
defineProperty(signatureClass, 'return_annotation', (self) => signatureOf(self).returnAnnotation);
method(signatureClass, '__str__', 'none', 0, 0, (self) => formatSignature(signatureOf(self)));
method(signatureClass, '__repr__', 'none', 0, 0, (self) => `<Signature ${formatSignature(signatureOf(self))}>`);
method(
  signatureClass,
  'replace',
  'none',
  0,
  0,
  (self, _args, kwargs) => {
    const { parameters, returnAnnotation } = signatureOf(self);
    const replaced = kwargs?.get('parameters');
    return newSignature({
      parameters: replaced === undefined ? parameters : (currentRuntime().toArray(replaced) as PyOpaque[]),
      returnAnnotation: kwargs?.get('return_annotation') ?? returnAnnotation,
    });
  },
  { keywords: ['parameters', 'return_annotation'] }
);
// Signature._bind is written in Python with the rest of inspect.
for (const [name, partial] of [
  ['bind', false],
  ['bind_partial', true],
] as const) {
  defineMethod(signatureClass, name, (self, args, kwargs) => {
    const bind = getAttribute(currentRuntime().importModule('inspect'), '_signature_bind');
    const named = newDict(kwargs?.entries() ?? []);
    return callValue(bind, [self, newTuple(args), named], new Map([['partial', partial]]));
  });
}
signatureClass.construct = (_cls, args, kwargs) => {
  const [parameters, returnAnnotation] = bindArguments(
    { qualified: 'Signature', params: ['parameters', 'return_annotation'], required: 0, isFunction: true },
    args,
    kwargs
  );
  return newSignature({
    parameters:
      parameters === undefined || parameters === None ? [] : (currentRuntime().toArray(parameters) as PyOpaque[]),
    returnAnnotation: returnAnnotation ?? emptyClass,
  });
};

function newParameter(parameter: Parameter): PyOpaque {
  return new PyOpaque(parameterClass, parameter.name, parameter);
}

function newSignature(signature: Signature): PyOpaque {
  return new PyOpaque(signatureClass, '', signature);
}

// Formatting --------------------------------------------------------------------------------------------------------

function formatParameter({ name, kind, default: defaultValue, annotation }: Parameter): string {
  let formatted = name;
  if (annotation !== emptyClass) formatted = `${formatted}: ${formatAnnotation(annotation)}`;
  if (defaultValue !== emptyClass) {
    formatted =
      annotation === emptyClass ? `${formatted}=${pyRepr(defaultValue)}` : `${formatted} = ${pyRepr(defaultValue)}`;
  }
  if (kind === Kind.VarPositional) return `*${formatted}`;
  return kind === Kind.VarKeyword ? `**${formatted}` : formatted;
}

function formatSignature({ parameters, returnAnnotation }: Signature): string {
  const result: string[] = [];
  let positionalOnlySeparator = false;
  let keywordOnlySeparator = true;
  for (const parameter of parameters.map(parameterOf)) {
    const { kind } = parameter;
    if (kind === Kind.PositionalOnly) {
      positionalOnlySeparator = true;
    } else if (positionalOnlySeparator) {
      result.push('/');
      positionalOnlySeparator = false;
    }
    if (kind === Kind.VarPositional) {
      keywordOnlySeparator = false;
    } else if (kind === Kind.KeywordOnly && keywordOnlySeparator) {
      result.push('*');
      keywordOnlySeparator = false;
    }
    result.push(formatParameter(parameter));
  }
  if (positionalOnlySeparator) result.push('/');
  const rendered = `(${result.join(', ')})`;
  return returnAnnotation === emptyClass ? rendered : `${rendered} -> ${formatAnnotation(returnAnnotation)}`;
}

/** `inspect.formatannotation`. */
export function formatAnnotation(annotation: PyValue, baseModule?: PyValue): string {
  if (annotation instanceof PyClass) {
    return annotation.module === 'builtins' || annotation.module === baseModule
      ? annotation.qualifiedName
      : `${annotation.module}.${annotation.qualifiedName}`;
  }
  const text = pyRepr(annotation);
  return typeof annotation === 'object' && getAttributeOrUndefined(annotation, '__module__') === 'typing'
    ? text.replaceAll(/[\w.]+/g, (name) => (name.startsWith('typing.') ? name.slice('typing.'.length) : name))
    : text;
}

// Signatures of callables -------------------------------------------------------------------------------------------

/** `inspect.signature(obj)` of a function, method, or class the program defines. */
export function signature(value: PyValue): PyOpaque {
  return newSignature(signatureData(value));
}

function signatureData(value: PyValue): Signature {
  if (value instanceof PyFunction) return functionSignature(value);
  if (value instanceof PyBoundMethod) return withoutFirst(signatureData(value.fn));
  if (value instanceof PyClass) return classSignature(value);
  if (value instanceof PyInstance && !value.cls.isBuiltin) {
    const call = value.cls.lookup('__call__');
    if (call instanceof PyFunction) return withoutFirst(functionSignature(call));
  }
  if (value instanceof PyOpaque && value.cls === partialClass) return partialSignature(value);
  const text = value instanceof PyBuiltinFunction ? builtinTextSignature(value) : undefined;
  if (text !== undefined) return textSignature(text, (value as PyBuiltinFunction).self !== undefined);
  if (!isCallable(value)) throw typeError(`${pyRepr(value)} is not a callable object`);
  throw new UnsupportedFeatureError('組み込みの関数やクラスの inspect.signature()');
}

/** The signature of a `functools.partial` object, as `_signature_get_partial` derives it from its function's. */
// code-gauge-allow functionCognitiveComplexity 19 -- Follows the cases of _signature_get_partial in CPython's inspect.py.
// code-gauge-allow functionNcss 32 -- Follows the cases of _signature_get_partial in CPython's inspect.py.
function partialSignature(value: PyOpaque): Signature {
  const { fn, args, kwargs } = value.data as Partial;
  const { parameters, returnAnnotation } = signatureData(fn);
  const params = parameters.map(parameterOf);
  const positional = params.filter((each) => each.kind <= Kind.PositionalOrKeyword);
  const hasVarArgs = params.some((each) => each.kind === Kind.VarPositional);
  const accepts = (name: string): boolean =>
    params.some((each) => each.name === name && each.kind !== Kind.PositionalOnly && each.kind !== Kind.VarPositional);
  const hasVarKeywords = params.some((each) => each.kind === Kind.VarKeyword);
  const badKeyword = [...kwargs.keys()].some((name) => !accepts(name) && !hasVarKeywords);
  if ((args.length > positional.length && !hasVarArgs) || badKeyword) {
    throw valueError(`partial object ${pyRepr(value)} has incorrect arguments`);
  }
  const bound = new Set(positional.slice(0, args.length));
  let keywordOnly = false;
  const result: Parameter[] = [];
  const moved: Parameter[] = [];
  for (const param of params) {
    if (bound.has(param)) continue;
    const given = kwargs.get(param.name);
    if (param.kind === Kind.PositionalOrKeyword && given !== undefined) keywordOnly = true;
    if (keywordOnly && param.kind === Kind.VarPositional) continue;
    const changed = { ...param, default: given ?? param.default };
    if (keywordOnly && param.kind === Kind.PositionalOrKeyword) moved.push({ ...changed, kind: Kind.KeywordOnly });
    else if (keywordOnly) moved.push(changed);
    else result.push(changed);
  }
  return { parameters: [...result, ...moved].map(newParameter), returnAnnotation };
}

/** The `__text_signature__`s CPython gives the methods of `object` and `type`, where `$` marks the bound parameter. */
const TEXT_SIGNATURES: Record<string, string> = {
  'type.__call__': '$self, /, *args, **kwargs',
  __init__: '$self, /, *args, **kwargs',
  __new__: '$type, *args, **kwargs',
  __init_subclass__: '$type, /',
  __subclasshook__: '$type, object, /',
  __delattr__: '$self, name, /',
  __getattribute__: '$self, name, /',
  __setattr__: '$self, name, value, /',
  __format__: '$self, format_spec, /',
  __reduce_ex__: '$self, protocol, /',
  ...Object.fromEntries(
    ['__eq__', '__ne__', '__lt__', '__le__', '__gt__', '__ge__'].map((name) => [name, '$self, value, /'])
  ),
  ...Object.fromEntries(
    ['__dir__', '__getstate__', '__hash__', '__reduce__', '__repr__', '__sizeof__', '__str__'].map((name) => [
      name,
      '$self, /',
    ])
  ),
};

function builtinTextSignature(fn: PyBuiltinFunction): string | undefined {
  const key = fn.ownerName === 'object' ? fn.name : `${fn.ownerName}.${fn.name}`;
  return Object.hasOwn(TEXT_SIGNATURES, key) ? TEXT_SIGNATURES[key] : undefined;
}

/** The signature a `__text_signature__` describes, without its `$` parameter when the method is bound. */
function textSignature(text: string, bound: boolean): Signature {
  const names = text.split(', ');
  const slash = names.indexOf('/');
  const parameters: PyOpaque[] = [];
  for (const [index, name] of names.entries()) {
    if (name === '/' || (bound && name.startsWith('$'))) continue;
    let kind: Kind = index < slash || name.startsWith('$') ? Kind.PositionalOnly : Kind.PositionalOrKeyword;
    if (name.startsWith('**')) kind = Kind.VarKeyword;
    else if (name.startsWith('*')) kind = Kind.VarPositional;
    parameters.push(
      newParameter({ name: name.replace(/^[$*]+/, ''), kind, default: emptyClass, annotation: emptyClass })
    );
  }
  return { parameters, returnAnnotation: emptyClass };
}

function classSignature(cls: PyClass): Signature {
  for (const each of cls.mro) {
    if (each.isBuiltin) break;
    const init = each.dict.get('__init__');
    if (init instanceof PyFunction) return withoutFirst(functionSignature(init));
    const create = each.dict.get('__new__');
    const fn = create instanceof PyDescriptor ? create.fn : create;
    if (fn instanceof PyFunction) return withoutFirst(functionSignature(fn));
  }
  if (cls.mro.every((each) => !each.isBuiltin || each === cls.mro.at(-1))) {
    return { parameters: [], returnAnnotation: emptyClass };
  }
  throw new UnsupportedFeatureError('組み込みのクラスを継承したクラスの inspect.signature()');
}

function withoutFirst({ parameters, returnAnnotation }: Signature): Signature {
  const [first] = parameters;
  if (first === undefined) throw valueError('invalid method signature');
  const kind = parameterOf(first).kind;
  if (kind === Kind.VarPositional) return { parameters, returnAnnotation };
  if (kind === Kind.KeywordOnly || kind === Kind.VarKeyword) throw valueError('invalid method signature');
  return { parameters: parameters.slice(1), returnAnnotation };
}

const KINDS_OF_PARAMETERS: Record<string, Kind> = {
  positionalOnly: Kind.PositionalOnly,
  positional: Kind.PositionalOrKeyword,
  varArgs: Kind.VarPositional,
  keywordOnly: Kind.KeywordOnly,
  varKeywords: Kind.VarKeyword,
};

function functionSignature(fn: PyFunction): Signature {
  const annotations = functionAnnotations(fn);
  const annotationOf = (name: string): PyValue => annotations.store.get(name) ?? emptyClass;
  const positional = fn.def.params.filter((param) => param.kind === 'positionalOnly' || param.kind === 'positional');
  const firstDefault = positional.length - fn.defaults.length;
  const parameters = fn.def.params.map((param) => {
    const index = positional.indexOf(param);
    const defaultValue =
      index >= firstDefault && index !== -1 ? fn.defaults[index - firstDefault] : fn.keywordDefaults.get(param.name);
    return newParameter({
      name: param.name,
      kind: KINDS_OF_PARAMETERS[param.kind],
      default: defaultValue ?? emptyClass,
      annotation: annotationOf(param.name),
    });
  });
  return { parameters, returnAnnotation: annotationOf('return') };
}
