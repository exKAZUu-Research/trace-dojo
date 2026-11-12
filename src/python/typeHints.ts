// code-gauge-allow-file fileNcss 418 -- The methods and attributes of the builtin types it defines belong together.
import { isSubclassOfClass } from './builtins';
import { pyRepr } from './conversions';
import { method } from './define';
import { defineGetSet } from './descriptors';
import { pyHash } from './hashing';
import { callValue, getAttributeOrUndefined } from './objects';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import {
  builtinClass,
  classOf,
  Ellipsis,
  newList,
  newTuple,
  None,
  noneClass,
  NotImplemented,
  typeError,
} from './types';
import { type Kwargs, PyBuiltinFunction, PyClass, PyFunction, PyList, PyOpaque, PyTuple, type PyValue } from './values';

/**
 * The objects of type hints: `list[int]` (types.GenericAlias), `int | str` (typing.Union), and the aliases and special
 * forms of the typing module, as CPython 3.14 implements them in genericaliasobject.c, unionobject.c, and typing.py.
 */

/** What an alias holds: the class or special form it specializes, its arguments, and the name typing shows. */
export interface AliasData {
  origin: PyValue;
  args: readonly PyValue[];
  name?: string;
  /** Whether calling the alias creates an instance of its origin. */
  inst?: boolean;
}

/** A typing alias that is not yet specialized, such as `typing.List`. */
interface SpecialAliasData {
  origin: PyValue;
  name: string;
  /** How many arguments it takes, or -1 for Tuple and Callable. */
  nparams: number;
  inst: boolean;
  defaults: readonly PyValue[];
}

function typingClass(name: string, base?: PyClass): PyClass {
  const cls = builtinClass(name, base);
  cls.module = 'typing';
  cls.isWrittenInPython = true;
  return cls;
}

export const genericAliasClass = builtinClass('GenericAlias');
genericAliasClass.module = 'types';
genericAliasClass.tpName = 'types.GenericAlias';
export const unionClass = typingClass('Union');
unionClass.tpName = 'typing.Union';
// CPython writes typing.Union in C, unlike the other classes of typing.
unionClass.isWrittenInPython = false;
export const typingAliasClass = typingClass('_GenericAlias');
const callableAliasClass = typingClass('_CallableGenericAlias', typingAliasClass);
const literalAliasClass = typingClass('_LiteralGenericAlias', typingAliasClass);
const annotatedAliasClass = typingClass('_AnnotatedAlias', typingAliasClass);
export const specialAliasClass = typingClass('_SpecialGenericAlias');
const tupleTypeClass = typingClass('_TupleType', specialAliasClass);
const callableTypeClass = typingClass('_CallableType', specialAliasClass);
export const specialFormClass = typingClass('_SpecialForm');
const typedCacheSpecialFormClass = typingClass('_TypedCacheSpecialForm', specialFormClass);
const anyMetaClass = typingClass('_AnyMeta');
export const forwardRefClass = builtinClass('ForwardRef');
forwardRefClass.module = 'annotationlib';
forwardRefClass.isWrittenInPython = true;

const aliasOf = (value: PyValue): AliasData => (value as PyOpaque).data as AliasData;
const specialOf = (value: PyValue): SpecialAliasData => (value as PyOpaque).data as SpecialAliasData;

// Reprs ---------------------------------------------------------------------------------------------------------------

/** `annotationlib.type_repr`, with typing's special case for a tuple of parameters. */
export function typeRepr(value: PyValue): string {
  if (value instanceof PyTuple && classOf(value).isBuiltin) return `[${value.items.map(typeRepr).join(', ')}]`;
  const named = qualifiedNameOf(value);
  if (named !== undefined) return named;
  if (value === Ellipsis) return '...';
  return pyRepr(value);
}

function qualifiedNameOf(value: PyValue): string | undefined {
  if (value instanceof PyClass)
    return value.module === 'builtins' ? value.qualifiedName : `${value.module}.${value.qualifiedName}`;
  if (value instanceof PyFunction)
    return value.module === 'builtins' ? value.qualifiedName : `${value.module}.${value.qualifiedName}`;
  if (value instanceof PyBuiltinFunction) return value.qualifiedName;
  return undefined;
}

/** How genericaliasobject.c and unionobject.c show an argument. */
function argumentRepr(value: PyValue): string {
  if (value === Ellipsis) return '...';
  if (value instanceof PyOpaque && (value.cls === unionClass || isAlias(value))) return pyRepr(value);
  return qualifiedNameOf(value) ?? pyRepr(value);
}

function genericAliasRepr(alias: AliasData): string {
  const items = alias.args.map((arg) =>
    arg instanceof PyList ? `[${arg.items.map(argumentRepr).join(', ')}]` : argumentRepr(arg)
  );
  return `${argumentRepr(alias.origin)}[${items.length === 0 ? '()' : items.join(', ')}]`;
}

function typingAliasRepr(self: PyOpaque): string {
  const alias = aliasOf(self);
  const head = alias.name === undefined ? typeRepr(alias.origin) : `typing.${alias.name}`;
  if (self.cls === literalAliasClass) return `${head}[${alias.args.map((arg) => pyRepr(arg)).join(', ')}]`;
  if (self.cls === callableAliasClass && !(alias.args.length === 2 && alias.args[0] === Ellipsis)) {
    const parameters = alias.args.slice(0, -1).map(typeRepr).join(', ');
    return `${head}[[${parameters}], ${typeRepr(alias.args.at(-1) as PyValue)}]`;
  }
  return `${head}[${alias.args.length === 0 ? '()' : alias.args.map(typeRepr).join(', ')}]`;
}

function unionRepr(self: PyOpaque): string {
  return (self.data as PyValue[]).map((item) => (item === noneClass ? 'None' : argumentRepr(item))).join(' | ');
}

// Creating aliases and unions -------------------------------------------------------------------------------------

export function newGenericAlias(origin: PyValue, key: PyValue): PyOpaque {
  const args = key instanceof PyTuple && classOf(key).isBuiltin ? [...key.items] : [key];
  return new PyOpaque(genericAliasClass, '', { origin, args } satisfies AliasData);
}

function newTypingAlias(
  origin: PyValue,
  args: readonly PyValue[],
  name?: string,
  inst = true,
  cls = typingAliasClass
): PyOpaque {
  return new PyOpaque(cls, '', { origin, args, name, inst } satisfies AliasData);
}

export function isAlias(value: PyValue): value is PyOpaque {
  return (
    value instanceof PyOpaque && (value.cls.isSubclassOf(genericAliasClass) || value.cls.isSubclassOf(typingAliasClass))
  );
}

/** Whether `int | other` makes a union, as unionobject.c's is_unionable decides; typing's objects make their own. */
function isUnionable(value: PyValue): boolean {
  return (
    value === None ||
    value instanceof PyClass ||
    (value instanceof PyOpaque && (value.cls === genericAliasClass || value.cls === unionClass))
  );
}

/** `left | right` for a class, which gives NotImplemented for an operand that is not a type. */
export function typeOr(left: PyValue, right: PyValue): PyValue {
  if (!isUnionable(left) || !isUnionable(right)) return NotImplemented;
  return unionOf([left, right]);
}

/** A union of types, flattening nested unions, dropping duplicates, and giving a lone type itself. */
export function unionOf(items: readonly PyValue[]): PyValue {
  const members: PyValue[] = [];
  for (const item of items) {
    const flattened =
      item instanceof PyOpaque && item.cls === unionClass ? (item.data as PyValue[]) : [convertNone(item)];
    for (const member of flattened) if (!members.some((each) => equals(each, member))) members.push(member);
  }
  if (members.length === 1) return members[0];
  return new PyOpaque(unionClass, '', members);
}

function convertNone(value: PyValue): PyValue {
  return value === None ? noneClass : value;
}

/** `typing._type_convert`: None is NoneType and a string is a forward reference. */
function typeConvert(value: PyValue): PyValue {
  if (value === None) return noneClass;
  if (typeof value === 'string') return new PyOpaque(forwardRefClass, value);
  return value;
}

/** `typing._type_check`, which rejects special forms and tuples that cannot be arguments. */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows typing._type_check's rules for special forms.
function typeCheck(value: PyValue, message: string, allowSpecialForms = false, isArgument = true): PyValue {
  const arg = typeConvert(value);
  if (arg instanceof PyOpaque && arg.cls === typingAliasClass) {
    const origin = aliasOf(arg).origin;
    const invalid = [
      !allowSpecialForms && formNamed(origin, 'ClassVar'),
      !allowSpecialForms && isArgument && formNamed(origin, 'Final'),
    ];
    if (invalid.some(Boolean)) throw typeError(`${pyRepr(arg)} is not valid as type argument`);
  }
  if (arg instanceof PyOpaque && arg.cls.isSubclassOf(specialFormClass)) {
    const name = (arg.data as { name: string }).name;
    if (['LiteralString', 'NoReturn', 'Never', 'Self', 'TypeAlias'].includes(name)) return arg;
    if (allowSpecialForms && (name === 'ClassVar' || name === 'Final')) return arg;
    throw typeError(`Plain ${pyRepr(arg)} is not valid as type argument`);
  }
  if (arg instanceof PyTuple && arg.cls.isBuiltin) throw typeError(`${message} Got ${pyRepr(arg).slice(0, 100)}.`);
  return arg;
}

function formNamed(value: PyValue, name: string): boolean {
  return (
    value instanceof PyOpaque &&
    value.cls.isSubclassOf(specialFormClass) &&
    (value.data as { name: string }).name === name
  );
}

const tupleItems = (key: PyValue): PyValue[] =>
  key instanceof PyTuple && classOf(key).isBuiltin ? [...key.items] : [key];

// Special forms -----------------------------------------------------------------------------------------------------

interface SpecialFormData {
  name: string;
  getitem?: (self: PyOpaque, key: PyValue) => PyValue;
}

export function newSpecialForm(name: string, getitem?: SpecialFormData['getitem'], cached = false): PyOpaque {
  return new PyOpaque(cached ? typedCacheSpecialFormClass : specialFormClass, '', {
    name,
    getitem,
  } satisfies SpecialFormData);
}

const formOf = (self: PyValue): SpecialFormData => (self as PyOpaque).data as SpecialFormData;

/** The getitem of ClassVar, Final, TypeGuard, and the other forms that take a single type. */
export function singleTypeForm(allowSpecialForms: boolean): SpecialFormData['getitem'] {
  return (self, key) => {
    const item = typeCheck(key, `${pyRepr(self)} accepts only single type.`, allowSpecialForms);
    return newTypingAlias(self, [item]);
  };
}

export const optionalGetItem: SpecialFormData['getitem'] = (self, key) => {
  const arg = typeCheck(key, `${pyRepr(self)} requires a single type.`);
  return unionOf([arg, None]);
};

export const literalGetItem: SpecialFormData['getitem'] = (self, key) => {
  const values: PyValue[] = [];
  for (const item of tupleItems(key)) {
    const flattened = item instanceof PyOpaque && item.cls === literalAliasClass ? aliasOf(item).args : [item];
    for (const value of flattened) {
      if (!values.some((each) => classOf(each) === classOf(value) && equals(each, value))) values.push(value);
    }
  }
  return newTypingAlias(self, values, undefined, true, literalAliasClass);
};

export const annotatedGetItem: SpecialFormData['getitem'] = (self, key) => {
  const items = tupleItems(key);
  if (items.length < 2) {
    throw typeError('Annotated[...] should be used with at least two arguments (a type and an annotation).');
  }
  const origin = typeCheck(items[0], 'Annotated[t, ...]: t must be a type.', true);
  const metadata = items.slice(1);
  if (origin instanceof PyOpaque && origin.cls === annotatedAliasClass) {
    const inner = aliasOf(origin);
    return newTypingAlias(
      self,
      [inner.args[0], ...inner.args.slice(1), ...metadata],
      undefined,
      true,
      annotatedAliasClass
    );
  }
  return newTypingAlias(self, [origin, ...metadata], undefined, true, annotatedAliasClass);
};

export const concatenateGetItem: SpecialFormData['getitem'] = (self, key) => {
  const items = tupleItems(key);
  if (items.length === 0) throw typeError('Cannot take a Concatenate of no types.');
  if (items.at(-1) !== Ellipsis) {
    throw typeError('The last parameter to Concatenate should be a ParamSpec variable or ellipsis.');
  }
  const args = items.map((item, index) =>
    index === items.length - 1 ? item : typeCheck(item, 'Concatenate[arg, ...]: each arg must be a type.')
  );
  return newTypingAlias(self, args);
};

method(specialFormClass, '__repr__', 'none', 0, 0, (self) => `typing.${formOf(self).name}`);
method(specialFormClass, '__getitem__', 'one', 1, 1, (self, [key]) => {
  const { getitem } = formOf(self);
  if (!getitem) throw typeError(`${pyRepr(self)} is not subscriptable`);
  return getitem(self as PyOpaque, key);
});
method(
  specialFormClass,
  '__call__',
  'expected',
  0,
  Number.POSITIVE_INFINITY,
  (self) => {
    throw typeError(`Cannot instantiate ${pyRepr(self)}`);
  },
  { keywords: [] }
);
specialFormClass.opaqueAttribute = (self, name) => {
  if (name === '__name__' || name === '_name') return formOf(self).name;
  if (name === '__module__') return 'typing';
  return;
};
specialFormClass.subclassCheck = (self, _cls, caller) => {
  throw typeError(`${pyRepr(self)} cannot be used with ${caller}()`);
};
typedCacheSpecialFormClass.opaqueAttribute = specialFormClass.opaqueAttribute;
typedCacheSpecialFormClass.subclassCheck = specialFormClass.subclassCheck;

// Any ---------------------------------------------------------------------------------------------------------------

export const anyType = new PyOpaque(anyMetaClass, 'Any');
method(anyMetaClass, '__repr__', 'none', 0, 0, () => 'typing.Any');
method(anyMetaClass, '__getitem__', 'one', 1, 1, () => {
  throw typeError("type 'Any' is not subscriptable");
});
method(
  anyMetaClass,
  '__call__',
  'expected',
  0,
  Number.POSITIVE_INFINITY,
  () => {
    throw typeError('Any cannot be instantiated');
  },
  { keywords: [] }
);
anyMetaClass.opaqueAttribute = (_self, name) => {
  if (name === '__name__' || name === '__qualname__') return 'Any';
  if (name === '__module__') return 'typing';
  return;
};
anyMetaClass.subclassCheck = (_self, _cls, caller) => {
  throw typeError(`typing.Any cannot be used with ${caller}()`);
};

// typing's aliases --------------------------------------------------------------------------------------------------

export function newSpecialAlias(
  origin: PyValue,
  nparams: number,
  options: { name?: string; inst?: boolean; defaults?: PyValue[] } = {}
): PyOpaque {
  const name = options.name ?? (origin as PyClass).name;
  const cls = name === 'Tuple' ? tupleTypeClass : name === 'Callable' ? callableTypeClass : specialAliasClass;
  return new PyOpaque(cls, '', {
    origin,
    name,
    nparams,
    inst: options.inst ?? true,
    defaults: options.defaults ?? [],
  } satisfies SpecialAliasData);
}

for (const cls of [specialAliasClass, tupleTypeClass, callableTypeClass]) {
  method(cls, '__repr__', 'none', 0, 0, (self) => `typing.${specialOf(self).name}`);
  method(
    cls,
    '__call__',
    'expected',
    0,
    Number.POSITIVE_INFINITY,
    (self, args, kwargs) => callAlias(specialOf(self), args, kwargs),
    { keywords: [] }
  );
  method(cls, '__or__', 'one', 1, 1, (self, [other]) => unionOf([self, other]));
  method(cls, '__ror__', 'one', 1, 1, (self, [other]) => unionOf([other, self]));
  cls.opaqueAttribute = (self, name) => {
    const data = specialOf(self);
    if (name === '__origin__') return data.origin;
    if (name === '__name__' || name === '__qualname__' || name === '_name') return data.name;
    if (name === '__module__') return 'typing';
    return;
  };
  cls.subclassCheck = (self, cls) => isSubclassOfOrigin(cls, specialOf(self).origin);
}

method(specialAliasClass, '__getitem__', 'one', 1, 1, (self, [key]) => {
  const data = specialOf(self);
  let params = tupleItems(key).map((param) => typeCheck(param, 'Parameters to generic types must be types.'));
  const { nparams, defaults } = data;
  if (defaults.length > 0 && params.length < nparams && params.length + defaults.length >= nparams) {
    params = [...params, ...defaults.slice(params.length - nparams + defaults.length)];
  }
  if (params.length !== nparams) {
    if (nparams === 0) throw typeError(`${pyRepr(self)} is not a generic class`);
    const expected = defaults.length > 0 ? `at least ${nparams - defaults.length}` : String(nparams);
    throw typeError(
      `Too ${params.length > nparams ? 'many' : 'few'} arguments for ${pyRepr(self)}; actual ${params.length}, expected ${expected}`
    );
  }
  return newTypingAlias(data.origin, params, data.name, data.inst);
});

method(tupleTypeClass, '__getitem__', 'one', 1, 1, (self, [key]) => {
  const data = specialOf(self);
  const items = key instanceof PyTuple && classOf(key).isBuiltin ? [...key.items] : [key];
  if (items.length === 2 && items[1] === Ellipsis) {
    return newTypingAlias(
      data.origin,
      [typeCheck(items[0], 'Tuple[t, ...]: t must be a type.'), Ellipsis],
      'Tuple',
      false
    );
  }
  const params = items.map((item) => typeCheck(item, 'Tuple[t0, t1, ...]: each t must be a type.'));
  return newTypingAlias(data.origin, params, 'Tuple', false);
});

method(callableTypeClass, '__getitem__', 'one', 1, 1, (self, [key]) => {
  const data = specialOf(self);
  if (!(key instanceof PyTuple && classOf(key).isBuiltin) || key.items.length !== 2) {
    throw typeError('Callable must be used as Callable[[arg, ...], result].');
  }
  const [parameters, result] = key.items;
  const returns = typeCheck(result, 'Callable[args, result]: result must be a type.');
  if (parameters === Ellipsis)
    return newTypingAlias(data.origin, [Ellipsis, returns], 'Callable', true, callableAliasClass);
  const items = parameters instanceof PyList ? parameters.items : tupleItems(parameters);
  const args = items.map((item) => typeCheck(item, 'Callable[[arg, ...], result]: each arg must be a type.'));
  return newTypingAlias(data.origin, [...args, returns], 'Callable', true, callableAliasClass);
});

function callAlias(
  alias: { origin: PyValue; name?: string; inst?: boolean },
  args: PyValue[],
  kwargs: Kwargs
): PyValue {
  if (alias.inst === false) {
    const origin = alias.origin as PyClass;
    throw typeError(`Type ${alias.name} cannot be instantiated; use ${origin.name.toLowerCase()}() instead`);
  }
  return callValue(alias.origin, args, kwargs);
}

/** `issubclass(cls, origin)` for the class or abstract base class a typing alias stands for. */
function isSubclassOfOrigin(cls: PyClass, origin: PyValue): boolean {
  return origin instanceof PyClass && isSubclassOfClass(cls, origin);
}

for (const cls of [typingAliasClass, callableAliasClass, literalAliasClass, annotatedAliasClass]) {
  method(cls, '__repr__', 'none', 0, 0, (self) => typingAliasRepr(self as PyOpaque));
  method(cls, '__getitem__', 'one', 1, 1, (self) => {
    throw typeError(`${pyRepr(self)} is not a generic class`);
  });
  method(
    cls,
    '__call__',
    'expected',
    0,
    Number.POSITIVE_INFINITY,
    (self, args, kwargs) => callAlias(aliasOf(self), args, kwargs),
    { keywords: [] }
  );
  method(cls, '__or__', 'one', 1, 1, (self, [other]) => unionOf([self, other]));
  method(cls, '__ror__', 'one', 1, 1, (self, [other]) => unionOf([other, self]));
  method(cls, '__eq__', 'one', 1, 1, (self, [other]) => aliasEquals(self, other));
  method(cls, '__hash__', 'none', 0, 0, (self) =>
    pyHash(newTuple([aliasOf(self).origin, newTuple(aliasOf(self).args)]))
  );
  cls.opaqueAttribute = (self, name) => {
    const alias = aliasOf(self);
    if (name === '__origin__') return alias.origin;
    if (name === '__args__') return newTuple(alias.args);
    if (name === '__parameters__') return newTuple([]);
    if (name === '__metadata__' && self.cls === annotatedAliasClass) return newTuple(alias.args.slice(1));
    if ((name === '__name__' || name === '__qualname__' || name === '_name') && alias.name !== undefined)
      return alias.name;
    if (name === '__module__') return 'typing';
    return;
  };
  cls.subclassCheck = () => {
    throw typeError('Subscripted generics cannot be used with class and instance checks');
  };
}

function aliasEquals(self: PyValue, other: PyValue): PyValue {
  if (!(other instanceof PyOpaque) || other.cls !== (self as PyOpaque).cls) return NotImplemented;
  const a = aliasOf(self);
  const b = aliasOf(other);
  if (!equals(a.origin, b.origin) || a.args.length !== b.args.length) return false;
  if ((self as PyOpaque).cls === literalAliasClass) {
    return a.args.every((arg) => b.args.some((each) => classOf(each) === classOf(arg) && equals(each, arg)));
  }
  return a.args.every((arg, index) => equals(arg, b.args[index]));
}

// types.GenericAlias ------------------------------------------------------------------------------------------------

method(genericAliasClass, '__repr__', 'none', 0, 0, (self) => genericAliasRepr(aliasOf(self)));
method(genericAliasClass, '__getitem__', 'one', 1, 1, (self) => {
  throw typeError(`${pyRepr(self)} is not a generic class`);
});
method(
  genericAliasClass,
  '__call__',
  'expected',
  0,
  Number.POSITIVE_INFINITY,
  (self, args, kwargs) => callValue(aliasOf(self).origin, args, kwargs),
  { keywords: [] }
);
method(genericAliasClass, '__or__', 'one', 1, 1, (self, [other]) => typeOr(self, other));
method(genericAliasClass, '__ror__', 'one', 1, 1, (self, [other]) => typeOr(other, self));
method(genericAliasClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyOpaque) || other.cls !== genericAliasClass) return NotImplemented;
  const a = aliasOf(self);
  const b = aliasOf(other);
  return (
    equals(a.origin, b.origin) &&
    a.args.length === b.args.length &&
    a.args.every((arg, index) => equals(arg, b.args[index]))
  );
});
method(
  genericAliasClass,
  '__hash__',
  'none',
  0,
  0,
  (self) => pyHash(aliasOf(self).origin) ^ pyHash(newTuple(aliasOf(self).args))
);
genericAliasClass.construct = (_cls, args) => {
  if (args.length !== 2) throw typeError(`GenericAlias expected 2 arguments, got ${args.length}`);
  return newGenericAlias(args[0], args[1]);
};
/** The attributes a types.GenericAlias has of its own; it reads every other attribute from its origin. */
const GENERIC_ALIAS_OWN = new Set([
  '__class__',
  '__bases__',
  '__origin__',
  '__args__',
  '__unpacked__',
  '__parameters__',
  '__typing_unpacked_tuple_args__',
  '__mro_entries__',
  '__reduce_ex__',
  '__reduce__',
  '__copy__',
  '__deepcopy__',
]);
genericAliasClass.opaqueAttribute = (self, name) => {
  const alias = aliasOf(self);
  if (name === '__origin__') return alias.origin;
  if (name === '__args__') return newTuple(alias.args);
  if (name === '__parameters__') return newTuple([]);
  if (name === '__unpacked__') return false;
  if (name === '__typing_unpacked_tuple_args__') return None;
  if (GENERIC_ALIAS_OWN.has(name)) return;
  return getAttributeOrUndefined(alias.origin, name);
};
genericAliasClass.dirNames = (self) => [
  ...currentRuntime().dirNames(aliasOf(self).origin),
  '__origin__',
  '__args__',
  '__unpacked__',
  '__parameters__',
  '__typing_unpacked_tuple_args__',
  '__mro_entries__',
];
method(genericAliasClass, '__mro_entries__', 'one', 1, 1, (self) => newTuple([aliasOf(self).origin]));
genericAliasClass.subclassCheck = (_self, _cls, caller) => {
  throw typeError(`${caller}() argument 2 cannot be a parameterized generic`);
};

// collections.abc.Callable[...] -----------------------------------------------------------------------------------

export const callableGenericAliasClass = builtinClass('_CallableGenericAlias', genericAliasClass);
callableGenericAliasClass.module = 'collections.abc';
callableGenericAliasClass.isWrittenInPython = true;
callableGenericAliasClass.construct = (cls, args) => {
  const [origin, key] = args;
  if (!(key instanceof PyTuple && key.items.length === 2)) {
    throw typeError('Callable must be used as Callable[[arg, ...], result].');
  }
  const [parameters, result] = key.items;
  let items: PyValue[];
  if ((parameters instanceof PyTuple && classOf(parameters).isBuiltin) || parameters instanceof PyList) {
    items = [...parameters.items, result];
  } else if (isParameterExpression(parameters)) {
    items = [parameters, result];
  } else {
    throw typeError(`Expected a list of types, an ellipsis, ParamSpec, or Concatenate. Got ${pyRepr(parameters)}`);
  }
  return new PyOpaque(cls, '', { origin, args: items } satisfies AliasData);
};
method(callableGenericAliasClass, '__repr__', 'none', 0, 0, (self) => {
  const alias = aliasOf(self);
  if (alias.args.length === 2 && isParameterExpression(alias.args[0])) return genericAliasRepr(alias);
  const parameters = alias.args.slice(0, -1).map(typeRepr).join(', ');
  return `collections.abc.Callable[[${parameters}], ${typeRepr(alias.args.at(-1) as PyValue)}]`;
});
callableGenericAliasClass.opaqueAttribute = genericAliasClass.opaqueAttribute;
callableGenericAliasClass.subclassCheck = genericAliasClass.subclassCheck;

function isParameterExpression(value: PyValue): boolean {
  return value === Ellipsis || value instanceof PyList;
}

// typing.Union ------------------------------------------------------------------------------------------------------

method(unionClass, '__repr__', 'none', 0, 0, (self) => unionRepr(self as PyOpaque));
method(unionClass, '__or__', 'one', 1, 1, (self, [other]) => typeOr(self, other));
method(unionClass, '__ror__', 'one', 1, 1, (self, [other]) => typeOr(other, self));
method(unionClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyOpaque) || other.cls !== unionClass) return NotImplemented;
  const a = (self as PyOpaque).data as PyValue[];
  const b = other.data as PyValue[];
  return (
    a.every((item) => b.some((each) => equals(each, item))) && b.every((item) => a.some((each) => equals(each, item)))
  );
});
method(unionClass, '__hash__', 'none', 0, 0, (self) => {
  let hash = 0n;
  for (const item of (self as PyOpaque).data as PyValue[]) hash ^= pyHash(item);
  return hash;
});
for (const [name, get] of [
  ['__args__', (self: PyValue) => newTuple((self as PyOpaque).data as PyValue[])],
  ['__origin__', () => unionClass],
  ['__parameters__', () => newTuple([])],
  ['__name__', () => 'Union'],
  ['__qualname__', () => 'Union'],
] as const) {
  defineGetSet(unionClass, name, get);
}
method(unionClass, '__getitem__', 'one', 1, 1, (self) => {
  throw typeError(`${pyRepr(self)} is not a generic class`);
});
method(unionClass, '__mro_entries__', 'one', 1, 1, (self) => {
  throw typeError(`Cannot subclass ${pyRepr(self)}`);
});
method(unionClass, '__class_getitem__', 'one', 1, 1, (_owner, [key]) => unionGetItem(key), { binding: 'class' });
unionClass.construct = () => {
  throw typeError("cannot create 'typing.Union' instances");
};

/** `Union[X, Y]`, which typing.Union's `__class_getitem__` makes. */
export function unionGetItem(key: PyValue): PyValue {
  const items = tupleItems(key);
  if (items.length === 0) throw typeError('Cannot take a Union of no types.');
  return unionOf(items.map(typeConvert));
}

// ForwardRef --------------------------------------------------------------------------------------------------------

method(forwardRefClass, '__repr__', 'none', 0, 0, (self) => `ForwardRef(${pyRepr((self as PyOpaque).text)})`);
method(forwardRefClass, '__eq__', 'one', 1, 1, (self, [other]) =>
  other instanceof PyOpaque && other.cls === forwardRefClass ? other.text === (self as PyOpaque).text : NotImplemented
);
method(forwardRefClass, '__hash__', 'none', 0, 0, (self) => pyHash((self as PyOpaque).text));
forwardRefClass.opaqueAttribute = (self, name) => (name === '__forward_arg__' ? self.text : undefined);

/** The arguments `typing.get_args` gives, unflattening a Callable's parameters into a list. */
export function typingArgs(value: PyValue): PyValue {
  if (value instanceof PyOpaque && value.cls === annotatedAliasClass) return newTuple(aliasOf(value).args);
  if (value instanceof PyOpaque && value.cls === unionClass) return newTuple(value.data as PyValue[]);
  if (!isAlias(value)) return newTuple([]);
  const { args } = aliasOf(value);
  const isCallable = value.cls === callableAliasClass || value.cls === callableGenericAliasClass;
  if (isCallable && !(args.length === 2 && isParameterExpression(args[0]))) {
    return newTuple([newList(args.slice(0, -1)), args.at(-1) as PyValue]);
  }
  return newTuple(args);
}

/** The origin `typing.get_origin` gives. */
export function typingOrigin(value: PyValue, annotated: PyValue): PyValue {
  if (value instanceof PyOpaque && value.cls === annotatedAliasClass) return annotated;
  if (isAlias(value)) return aliasOf(value).origin;
  if (value instanceof PyOpaque && specialAliasOrigin(value) !== undefined) return specialAliasOrigin(value) as PyValue;
  if (value instanceof PyOpaque && value.cls === unionClass) return unionClass;
  return None;
}

function specialAliasOrigin(value: PyOpaque): PyValue | undefined {
  return value.cls.isSubclassOf(specialAliasClass) ? specialOf(value).origin : undefined;
}
