import { builtinTextSignature } from '../builtinDocs';
import { keywordEntries, keywordMap } from '../callArguments';
import { pyRepr } from '../conversions';
import { method } from '../define';
import { callValue, getAttribute, getAttributeOrUndefined, isCallable, isTruthy } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { toInt } from '../typeNumbers';
import {
  builtinClass,
  defineMethod,
  descriptorOwners,
  intClass,
  newDict,
  newTuple,
  None,
  stringValue,
  typeClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import {
  type Kwargs,
  PyBoundMethod,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  type PyDict,
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
  nameValue?: PyValue;
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
defineProperty(parameterClass, 'name', (self) => parameterOf(self).nameValue ?? parameterOf(self).name);
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
  const text = stringValue(name);
  if (text === undefined) throw typeError(`name must be a str, not a ${typeName(name as PyValue)}`);
  if (kindIndex(kind as PyValue) === -1)
    throw valueError(`value ${pyRepr(kind as PyValue)} is not a valid Parameter.kind`);
  return newParameter({
    name: text,
    nameValue: name,
    kind: kindIndex(kind as PyValue) as Kind,
    default: defaultValue ?? emptyClass,
    annotation: annotation ?? emptyClass,
  });
};

defineProperty(signatureClass, 'parameters', (self) => {
  const ordered = currentRuntime().importModule('collections').dict.get('OrderedDict') as PyValue;
  const pairs = signatureOf(self).parameters.map((parameter) =>
    currentRuntime().tuple([parameterOf(parameter).nameValue ?? parameterOf(parameter).name, parameter])
  );
  return callValue(ordered, [currentRuntime().listOf(pairs)]);
});
defineProperty(signatureClass, 'return_annotation', (self) => signatureOf(self).returnAnnotation);
method(signatureClass, '__str__', 'none', 0, 0, (self) => formatSignature(signatureOf(self)));
method(signatureClass, '__repr__', 'none', 0, 0, (self) => `<Signature ${formatSignature(signatureOf(self))}>`);
method(
  signatureClass,
  'format',
  'expected',
  0,
  0,
  (self, _args, kwargs) => {
    const width = kwargs?.get('max_width') ?? None;
    return formatSignature(
      signatureOf(self),
      width === None ? undefined : Number(toInt(width)),
      isTruthy(kwargs?.get('quote_annotation_strings') ?? true)
    );
  },
  { keywords: ['max_width', 'quote_annotation_strings'] }
);
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
    const named = newDict(keywordEntries(kwargs));
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

function formatParameter({ name, kind, default: defaultValue, annotation }: Parameter, quoteStrings = true): string {
  let formatted = name;
  if (annotation !== emptyClass) formatted = `${formatted}: ${formatSignatureAnnotation(annotation, quoteStrings)}`;
  if (defaultValue !== emptyClass) {
    formatted =
      annotation === emptyClass ? `${formatted}=${pyRepr(defaultValue)}` : `${formatted} = ${pyRepr(defaultValue)}`;
  }
  if (kind === Kind.VarPositional) return `*${formatted}`;
  return kind === Kind.VarKeyword ? `**${formatted}` : formatted;
}

/** `Signature.format(max_width=...)`: the parameters on lines of their own when they do not fit in `maxWidth`. */
export function formatSignatureWithin(value: PyValue, maxWidth: number | undefined): string {
  return formatSignature(signatureOf(value), maxWidth);
}

function formatSignature({ parameters, returnAnnotation }: Signature, maxWidth?: number, quoteStrings = true): string {
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
    result.push(formatParameter(parameter, quoteStrings));
  }
  if (positionalOnlySeparator) result.push('/');
  let rendered = `(${result.join(', ')})`;
  if (maxWidth !== undefined && rendered.length > maxWidth) rendered = `(\n    ${result.join(',\n    ')}\n)`;
  return returnAnnotation === emptyClass
    ? rendered
    : `${rendered} -> ${formatSignatureAnnotation(returnAnnotation, quoteStrings)}`;
}

function formatSignatureAnnotation(annotation: PyValue, quoteStrings: boolean): string {
  return quoteStrings ? formatAnnotation(annotation) : (stringValue(annotation) ?? formatAnnotation(annotation));
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
export function signature(value: PyValue, format: PyValue = 1n, options?: Kwargs): PyOpaque {
  return newSignature(signatureData(value, format, options));
}

function signatureData(value: PyValue, format: PyValue, options: Kwargs): Signature {
  if (value instanceof PyBoundMethod) return withoutFirst(signatureData(value.fn, format, options));
  // As _signature_from_callable does: the function a decorator wraps, and a `__signature__` set on the way.
  if (isTruthy(options?.get('follow_wrapped') ?? true)) value = unwrapForSignature(value);
  if (value instanceof PyBoundMethod) return withoutFirst(signatureData(value.fn, format, options));
  const given = givenSignature(value);
  if (given) return given;
  if (value instanceof PyFunction) return functionSignature(value, format, options);
  if (value instanceof PyClass) return classSignature(value, format, options);
  if (value instanceof PyInstance && !value.cls.isBuiltin) {
    const call = value.cls.lookup('__call__');
    if (call instanceof PyFunction) return withoutFirst(functionSignature(call, format, options));
  }
  if (value instanceof PyOpaque && value.cls === partialClass) return partialSignature(value, format, options);
  if (value instanceof PyBuiltinFunction) return builtinSignature(value);
  if (!isCallable(value)) throw typeError(`${pyRepr(value)} is not a callable object`);
  throw new UnsupportedFeatureError('組み込みの関数やクラスの inspect.signature()');
}

/** The signature an object's `__signature__` gives, if it gives one. */
function givenSignature(value: PyValue): Signature | undefined {
  const given = typeof value === 'object' ? getAttributeOrUndefined(value, '__signature__') : undefined;
  if (given === undefined || given === None) return undefined;
  if (!(given instanceof PyOpaque && given.cls === signatureClass)) {
    throw typeError(`unexpected object ${pyRepr(given)} in __signature__ attribute`);
  }
  return signatureOf(given);
}

/** `inspect.unwrap` as signature() calls it, stopping at an object with `__signature__` or at a bound method. */
function unwrapForSignature(value: PyValue): PyValue {
  const seen = new Set<PyValue>([value]);
  let current = value;
  for (;;) {
    if (current instanceof PyBoundMethod || typeof current !== 'object' || current instanceof PyClass) return current;
    if (getAttributeOrUndefined(current, '__signature__') !== undefined) return current;
    const wrapped = getAttributeOrUndefined(current, '__wrapped__');
    if (wrapped === undefined) return current;
    if (seen.has(wrapped)) throw valueError(`wrapper loop when unwrapping ${pyRepr(value)}`);
    seen.add(wrapped);
    current = wrapped;
  }
}

/** `_signature_from_builtin`: the signature a builtin's `__text_signature__` describes. */
function builtinSignature(fn: PyBuiltinFunction): Signature {
  const text = builtinTextSignature(fn);
  if (text === undefined) throw valueError(`no signature found for builtin ${pyRepr(fn)}`);
  // The parameter that `$` marks is the bound object, which a method descriptor that is not bound still takes.
  const unbound = fn.self === undefined && (descriptorOwners.has(fn) || fn.ownerName !== undefined);
  const parsed = textSignature(text, !unbound);
  if (!parsed) throw valueError(`${pyRepr(fn)} builtin has invalid signature`);
  return parsed;
}

/** The signature of a `functools.partial` object, as `_signature_get_partial` derives it from its function's. */
// code-gauge-allow functionCognitiveComplexity 19 -- Follows the cases of _signature_get_partial in CPython's inspect.py.
// code-gauge-allow functionNcss 33 -- Follows the cases of _signature_get_partial in CPython's inspect.py.
function partialSignature(value: PyOpaque, format: PyValue, options: Kwargs): Signature {
  const { fn, args, keywords } = value.data as Partial;
  const kwargs = keywordMap(keywords.store.ordered().map((entry) => [entry.key, entry.value]));
  const { parameters, returnAnnotation } = signatureData(fn, format, options);
  const params = parameters.map(parameterOf);
  const positional = params.filter((each) => each.kind <= Kind.PositionalOrKeyword);
  const hasVarArgs = params.some((each) => each.kind === Kind.VarPositional);
  const accepts = (name: string): boolean =>
    params.some((each) => each.name === name && each.kind !== Kind.PositionalOnly && each.kind !== Kind.VarPositional);
  const hasVarKeywords = params.some((each) => each.kind === Kind.VarKeyword);
  const badKeyword = [...kwargs.keys()].some((name) => !accepts(name) && !hasVarKeywords);
  if ((args.items.length > positional.length && !hasVarArgs) || badKeyword) {
    throw valueError(`partial object ${pyRepr(value)} has incorrect arguments`);
  }
  const bound = new Set(positional.slice(0, args.items.length));
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

/**
 * `_signature_fromstr`: the signature a `__text_signature__` describes, without its `$` parameter when the callable is
 * bound, or undefined when a default is not an expression CPython evaluates.
 */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows _signature_fromstr of CPython's inspect.py.
// code-gauge-allow functionNcss 34 -- Follows _signature_fromstr of inspect.py.
function textSignature(text: string, bound: boolean): Signature | undefined {
  const parameters: PyOpaque[] = [];
  let kind: Kind = Kind.PositionalOrKeyword;
  const parts = splitParameters(text.slice(1, -1));
  const slash = parts.indexOf('/');
  for (const [index, part] of parts.entries()) {
    if (part === '/') continue;
    if (part === '*') {
      kind = Kind.KeywordOnly;
      continue;
    }
    const [rawName, defaultText] = splitDefault(part);
    if (rawName.startsWith('$')) {
      if (!bound) parameters.push(newParameter(parameterData(rawName.slice(1), Kind.PositionalOnly, emptyClass)));
      continue;
    }
    let parameterKind: Kind = index < slash ? Kind.PositionalOnly : kind;
    let name = rawName;
    if (name.startsWith('**')) {
      parameterKind = Kind.VarKeyword;
      name = name.slice(2);
    } else if (name.startsWith('*')) {
      parameterKind = Kind.VarPositional;
      name = name.slice(1);
      kind = Kind.KeywordOnly;
    }
    let value: PyValue = emptyClass;
    if (defaultText !== undefined) {
      const evaluated = evaluateDefault(defaultText);
      if (evaluated === undefined) return undefined;
      value = evaluated;
    }
    parameters.push(newParameter(parameterData(name, parameterKind, value)));
  }
  return { parameters, returnAnnotation: emptyClass };
}

function parameterData(name: string, kind: Kind, value: PyValue): Parameter {
  return { name, kind, default: value, annotation: emptyClass };
}

/** The parameters of a signature's text, split at the commas outside brackets and strings. */
// code-gauge-allow functionCognitiveComplexity 16 -- Splits at commas outside brackets and strings, escapes included.
// code-gauge-allow functionNcss 32 -- Splits at commas outside brackets and strings, escapes included.
function splitParameters(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quote) {
      if (char === '\\') {
        current += char + (text[index + 1] ?? '');
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

function splitDefault(part: string): [string, string | undefined] {
  const equals = part.indexOf('=');
  return equals === -1 ? [part, undefined] : [part.slice(0, equals).trim(), part.slice(equals + 1).trim()];
}

/** A default's value, which CPython evaluates from literals and names of `sys`, or undefined for any other. */
function evaluateDefault(text: string): PyValue | undefined {
  if (!/^(?:[-+]?[\w.]+|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\(\)|\[\]|\{\})$/.test(text)) return undefined;
  const runtime = currentRuntime();
  // CPython looks names up in sys.modules too, where os, which its startup imports, always is.
  const modules = /^[-+]?os\./.test(text) ? ['sys', 'os'] : ['sys'];
  const globals = newDict(modules.map((name) => [name, runtime.importModule(name)]));
  try {
    return callValue(runtime.builtins.get('eval') as PyValue, [text, globals]);
  } catch {
    return undefined;
  }
}

// code-gauge-allow functionCognitiveComplexity 19 -- Follows how _signature_from_callable of inspect.py tries a class.
function classSignature(cls: PyClass, format: PyValue, options: Kwargs): Signature {
  for (const each of cls.mro) {
    if (each.isBuiltin) break;
    const init = each.dict.get('__init__');
    if (init instanceof PyFunction) return withoutFirst(functionSignature(init, format, options));
    const create = each.dict.get('__new__');
    const fn = create instanceof PyDescriptor ? create.fn : create;
    if (fn instanceof PyFunction) return withoutFirst(functionSignature(fn, format, options));
  }
  for (const base of cls.mro.slice(0, -1)) {
    const text = base.isBuiltin ? builtinTextSignature(base) : undefined;
    if (text === undefined) continue;
    const parsed = textSignature(text, true);
    if (!parsed) throw valueError(`${pyRepr(base)} builtin has invalid signature`);
    return parsed;
  }
  if (cls.mro.every((each) => !each.isBuiltin || each === cls.mro.at(-1))) {
    return { parameters: [], returnAnnotation: emptyClass };
  }
  if (cls.mro.includes(typeClass)) throw valueError(`no signature found for builtin ${pyRepr(cls)}`);
  throw valueError(`no signature found for builtin type ${pyRepr(cls)}`);
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

function functionSignature(fn: PyFunction, format: PyValue, options: Kwargs): Signature {
  const annotations = callValue(
    getAttribute(currentRuntime().importModule('annotationlib'), 'get_annotations'),
    [fn],
    new Map([
      ['format', format],
      ['eval_str', options?.get('eval_str') ?? false],
      ['globals', options?.get('globals') ?? None],
      ['locals', options?.get('locals') ?? None],
    ])
  ) as PyDict;
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
