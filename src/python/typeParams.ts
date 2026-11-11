import { pyRepr } from './conversions';
import { method } from './define';
import { identityHash } from './hashing';
import { argument, checkArgs } from './nativeArgs';
import { callValue, getIterator, setAttribute, toArray } from './objects';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import { newGenericAlias } from './typeHints';
import {
  builtinClass,
  newTuple,
  None,
  noneClass,
  NotImplemented,
  objectClass,
  propertyClass,
  typeError,
  typeName,
} from './types';
import {
  type Kwargs,
  PyBuiltinFunction,
  PyClass,
  PyDescriptor,
  PyError,
  PyFunction,
  PyInstance,
  PyObject,
  PyOpaque,
  PyTuple,
  type PyValue,
} from './values';

/** A value computed when a program first reads it, such as the bound of a type parameter written in brackets. */
export type Lazy = () => PyValue;

function typingType(name: string, base: PyClass = objectClass): PyClass {
  const cls = builtinClass(name, base);
  cls.module = 'typing';
  return cls;
}

/** A class of typing that CPython writes in C, whose errors name it with its module. */
function typingCType(name: string): PyClass {
  const cls = typingType(name);
  cls.typeName = `typing.${name}`;
  return cls;
}

export const typeVarClass = typingCType('TypeVar');
export const typeVarTupleClass = typingCType('TypeVarTuple');
export const paramSpecClass = typingCType('ParamSpec');
export const paramSpecArgsClass = typingCType('ParamSpecArgs');
export const paramSpecKwargsClass = typingCType('ParamSpecKwargs');
export const typeAliasClass = typingCType('TypeAliasType');
const noDefaultClass = typingType('NoDefaultType');
/** The class of `Generic[T]` and of a subscripted user generic class, such as `Box[int]`. */
export const aliasClass = typingType('_GenericAlias');

/** `typing.Generic`, the base of classes with type parameters. */
export const genericClass = typingType('Generic');
genericClass.layout = { base: 'object' };
genericClass.isBaseType = true;

/** The classes whose subscription declares the type parameters of a class deriving from it: Generic and Protocol. */
export const parameterDeclaringClasses = new Set<PyClass>([genericClass]);

/** `typing.NoDefault`, the default of a type parameter that has none. */
export const NoDefault = new PyObject(noDefaultClass);

export type TypeParamKind = 'TypeVar' | 'TypeVarTuple' | 'ParamSpec';

/** A type parameter's bound, constraints, and default, each computed on first read, and its variance. */
export interface TypeParamParts {
  bound?: Lazy;
  constraints?: Lazy;
  default?: Lazy;
  covariant?: boolean;
  contravariant?: boolean;
  /** Whether the variance is inferred, as for the type parameters written in brackets. */
  inferVariance?: boolean;
}

/** A TypeVar, a TypeVarTuple, or a ParamSpec. */
export class PyTypeParam extends PyInstance {
  private readonly computed = new Map<string, PyValue>();

  constructor(
    readonly kind: TypeParamKind,
    readonly name: string,
    readonly parts: TypeParamParts
  ) {
    super(kind === 'TypeVar' ? typeVarClass : kind === 'TypeVarTuple' ? typeVarTupleClass : paramSpecClass);
  }

  /** The bound, the constraints, or the default, computing it on first read. */
  part(name: 'bound' | 'constraints' | 'default', missing: PyValue): PyValue {
    const known = this.computed.get(name);
    if (known !== undefined) return known;
    const compute = this.parts[name];
    const value = compute ? compute() : missing;
    this.computed.set(name, value);
    return value;
  }

  get text(): string {
    if (this.kind === 'TypeVarTuple' || this.parts.inferVariance) return this.name;
    return `${this.parts.covariant ? '+' : this.parts.contravariant ? '-' : '~'}${this.name}`;
  }
}

/** `P.args` or `P.kwargs` of a ParamSpec `P`. */
class PyParamSpecPart extends PyObject {
  constructor(
    cls: PyClass,
    /** The ParamSpec, or whatever `ParamSpecArgs(origin)` was given. */
    readonly origin: PyValue
  ) {
    super(cls);
  }
}

/** A `type` statement's alias, or a TypeAliasType made by calling it. */
export class PyTypeAlias extends PyInstance {
  private value: PyValue | undefined;

  constructor(
    readonly name: string,
    readonly typeParams: PyValue[],
    private readonly compute: Lazy,
    readonly module: string
  ) {
    super(typeAliasClass);
  }

  get aliased(): PyValue {
    this.value ??= this.compute();
    return this.value;
  }
}

/** A subscripted generic class, such as `Generic[T]` or `Box[int]`, or an unpacked TypeVarTuple, `*Ts`. */
export class PyTypingAlias extends PyObject {
  constructor(
    readonly origin: PyValue,
    readonly args: readonly PyValue[],
    readonly isUnpack = false
  ) {
    super(aliasClass);
  }

  get parameters(): PyValue[] {
    return this.isUnpack ? [this.origin] : collectParameters(this.args);
  }
}

/** The object a type parameter written in brackets, such as `T: int` in `def f[T: int]()`, stands for. */
export function newTypeParam(kind: TypeParamKind, name: string, parts: TypeParamParts): PyTypeParam {
  return new PyTypeParam(kind, name, { ...parts, inferVariance: true });
}

/** The base a class with type parameters adds after its own: `Generic[T, *Ts, P]`. */
export function genericBaseOf(params: PyValue[]): PyValue {
  return new PyTypingAlias(genericClass, params.map(unpackedIfTuple));
}

function unpackedIfTuple(param: PyValue): PyValue {
  return param instanceof PyTypeParam && param.kind === 'TypeVarTuple' ? new PyTypingAlias(param, [], true) : param;
}

/** The text `typing` shows for a type inside a subscription, as its `_type_repr` does. */
export function typeText(value: PyValue): string {
  if (value instanceof PyClass) {
    if (value === noneClass) return 'None';
    return value.module === 'builtins' ? value.qualifiedName : `${value.module}.${value.qualifiedName}`;
  }
  if (value instanceof PyFunction) return value.name;
  if (value === None) return 'None';
  if (value instanceof PyOpaque) return value.text;
  return pyRepr(value);
}

/** `cls[key]` for a class that derives from Generic, as `Generic.__class_getitem__` checks it. */
export function subscriptGeneric(cls: PyClass, key: PyValue): PyValue {
  const args = key instanceof PyTuple ? [...key.items] : [key];
  if (parameterDeclaringClasses.has(cls)) {
    const { name } = cls;
    if (args.length === 0) throw typeError(`Parameter list to ${name}[...] cannot be empty`);
    if (!args.every((arg) => isGenericParameter(arg))) {
      throw typeError(`Parameters to ${name}[...] must all be type variables or parameter specification variables.`);
    }
    const params = args.map((arg) => (arg instanceof PyTypingAlias ? arg.origin : arg));
    if (new Set(params).size !== params.length) throw typeError(`Parameters to ${name}[...] must all be unique`);
    return cachedAlias(cls, args);
  }
  const params = parametersOf(cls);
  if (params.length === 0) throw typeError(`${classText(cls)} is not a generic class`);
  checkArgumentCount(cls, params, args);
  return cachedAlias(cls, args);
}

const aliasCache = new WeakMap<PyClass, PyTypingAlias[]>();

/** The alias of a class subscripted with `args`, the same object each time, as typing's cache gives. */
function cachedAlias(cls: PyClass, args: PyValue[]): PyTypingAlias {
  const known = aliasCache.get(cls) ?? [];
  aliasCache.set(cls, known);
  const found = known.find(
    (alias) => alias.args.length === args.length && alias.args.every((arg, index) => arg === args[index])
  );
  if (found) return found;
  const alias = new PyTypingAlias(cls, args);
  known.push(alias);
  return alias;
}

function isGenericParameter(value: PyValue): boolean {
  return (
    (value instanceof PyTypeParam && value.kind !== 'TypeVarTuple') ||
    (value instanceof PyTypingAlias && value.isUnpack)
  );
}

function classText(cls: PyClass): string {
  return `<class '${cls.module === 'builtins' ? '' : `${cls.module}.`}${cls.qualifiedName}'>`;
}

function checkArgumentCount(cls: PyClass, params: PyValue[], args: PyValue[]): void {
  if (params.some(isKind('TypeVarTuple'))) {
    if (args.length < params.length - 1) {
      throw typeError(
        `Too few arguments for ${classText(cls)}; actual ${args.length}, expected at least ${params.length - 1}`
      );
    }
    return;
  }
  if (params.length === 1 && isKind('ParamSpec')(params[0])) return;
  if (args.length !== params.length) {
    throw typeError(
      `Too ${args.length > params.length ? 'many' : 'few'} arguments for ${classText(cls)}; actual ${args.length}, expected ${params.length}`
    );
  }
}

function isKind(kind: TypeParamKind): (param: PyValue) => boolean {
  return (param) => param instanceof PyTypeParam && param.kind === kind;
}

/** The `__parameters__` of a class that derives from Generic. */
export function parametersOf(cls: PyClass): PyValue[] {
  const parameters = cls.lookup('__parameters__');
  return parameters instanceof PyTuple ? [...parameters.items] : [];
}

/** The type parameters that types mention, in order and without repeats, as `typing` collects them. */
function collectParameters(args: readonly PyValue[]): PyValue[] {
  const found: PyValue[] = [];
  for (const arg of args) {
    const params = arg instanceof PyTypeParam ? [arg] : arg instanceof PyTypingAlias ? arg.parameters : [];
    for (const param of params) if (!found.includes(param)) found.push(param);
  }
  return found;
}

/**
 * The classes a base of a class statement that `typing` defines stands for, as its `__mro_entries__` gives them: a
 * subscripted class stands for the class, and `Generic[...]` for Generic unless a later base is subscripted too.
 * Undefined for other bases.
 */
export function typingMroEntries(base: PyValue, bases: readonly PyValue[], className: string): PyValue[] | undefined {
  for (const hook of mroEntryHooks) {
    const entries = hook(base, className, bases);
    if (entries) return entries;
  }
  if (!(base instanceof PyTypingAlias) || base.isUnpack) return undefined;
  if (base.origin !== genericClass) return [base.origin];
  const later = bases.slice(bases.indexOf(base) + 1);
  if (bases.some((other) => other !== genericClass && declaresParameters(other))) return [];
  return later.some((other) => other instanceof PyTypingAlias) ? [] : [genericClass];
}

function declaresParameters(value: PyValue): boolean {
  return value instanceof PyClass && parameterDeclaringClasses.has(value);
}

/** The `__mro_entries__` of objects `typing` defines, such as `NamedTuple`, which give the classes they stand for. */
export const mroEntryHooks: ((base: PyValue, className: string, bases: readonly PyValue[]) => PyValue[] | undefined)[] =
  [];

/** Sets `__parameters__` of a class deriving from Generic, as `Generic.__init_subclass__` does. */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows Generic.__init_subclass__, which checks each way bases declare type parameters.
export function initGenericSubclass(cls: PyClass, originalBases: readonly PyValue[] | undefined): void {
  if (!cls.isSubclassOf(genericClass)) return;
  if (originalBases === undefined) {
    if (cls.bases.includes(genericClass)) throw typeError('Cannot inherit from plain Generic');
    return;
  }
  if (originalBases.includes(genericClass)) throw typeError('Cannot inherit from plain Generic');
  let params = collectParameters(originalBases);
  let declared: PyValue[] | undefined;
  for (const base of originalBases) {
    if (!(base instanceof PyTypingAlias) || !(base.origin instanceof PyClass)) continue;
    if (!parameterDeclaringClasses.has(base.origin)) continue;
    if (declared) throw typeError('Cannot inherit from Generic[...] multiple times.');
    declared = base.parameters;
  }
  if (declared) {
    const missing = params.filter((param) => !declared?.includes(param));
    if (missing.length > 0) {
      throw typeError(
        `Some type variables (${missing.map(typeText).join(', ')}) are not listed in Generic[${declared.map(typeText).join(', ')}]`
      );
    }
    params = declared;
  }
  cls.dict.set('__parameters__', newTuple(params));
}

// Methods -------------------------------------------------------------------------------------------------------------

function property(cls: PyClass, name: string, get: (self: PyValue) => PyValue): void {
  const getter = new PyBuiltinFunction(builtinClass('getter'), name, ([self]) => get(self));
  cls.dict.set(name, new PyDescriptor(propertyClass, getter));
}

for (const cls of [typeVarClass, typeVarTupleClass, paramSpecClass]) {
  method(cls, '__repr__', 'none', 0, 0, (self) => (self as PyTypeParam).text);
  method(cls, '__or__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(self, other));
  method(cls, '__ror__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(other, self));
  method(cls, 'has_default', 'none', 0, 0, (self) => (self as PyTypeParam).parts.default !== undefined);
  property(cls, '__name__', (self) => (self as PyTypeParam).name);
  property(cls, '__module__', () => '__main__');
  property(cls, '__default__', (self) => (self as PyTypeParam).part('default', NoDefault));
}
property(typeVarClass, '__bound__', (self) => (self as PyTypeParam).part('bound', None));
property(typeVarClass, '__constraints__', (self) => (self as PyTypeParam).part('constraints', newTuple([])));
for (const cls of [typeVarClass, paramSpecClass]) {
  property(cls, '__covariant__', (self) => (self as PyTypeParam).parts.covariant === true);
  property(cls, '__contravariant__', (self) => (self as PyTypeParam).parts.contravariant === true);
  property(cls, '__infer_variance__', (self) => (self as PyTypeParam).parts.inferVariance === true);
}
property(paramSpecClass, '__bound__', () => None);
property(paramSpecClass, 'args', (self) => new PyParamSpecPart(paramSpecArgsClass, self as PyTypeParam));
property(paramSpecClass, 'kwargs', (self) => new PyParamSpecPart(paramSpecKwargsClass, self as PyTypeParam));
for (const [cls, suffix] of [
  [paramSpecArgsClass, 'args'],
  [paramSpecKwargsClass, 'kwargs'],
] as const) {
  method(cls, '__repr__', 'none', 0, 0, (self) => {
    const { origin } = self as PyParamSpecPart;
    return `${origin instanceof PyTypeParam && origin.cls === paramSpecClass ? origin.name : pyRepr(origin)}.${suffix}`;
  });
  property(cls, '__origin__', (self) => (self as PyParamSpecPart).origin);
  method(cls, '__eq__', 'one', 1, 1, (self, [other]) =>
    other instanceof PyParamSpecPart && other.cls === (self as PyParamSpecPart).cls
      ? equals((self as PyParamSpecPart).origin, other.origin)
      : NotImplemented
  );
  cls.dict.set('__hash__', None);
  const spec = {
    qualified: `${cls.name.toLowerCase()}`,
    min: 0,
    max: 1,
    style: 'takes',
    keywords: ['origin'],
  } as const;
  cls.construct = (owner, args, kwargs) => {
    checkArgs(spec, args, kwargs);
    const origin = argument(args, kwargs, 0, 'origin');
    if (origin === undefined) throw typeError(`${spec.qualified}() missing required argument 'origin' (pos 1)`);
    return new PyParamSpecPart(owner, origin);
  };
}
method(typeVarTupleClass, '__iter__', 'none', 0, 0, (self) =>
  getIterator(newTuple([new PyTypingAlias(self, [], true)]))
);

method(noDefaultClass, '__repr__', 'none', 0, 0, () => 'typing.NoDefault');

method(typeAliasClass, '__repr__', 'none', 0, 0, (self) => (self as PyTypeAlias).name);
property(typeAliasClass, '__name__', (self) => (self as PyTypeAlias).name);
property(typeAliasClass, '__value__', (self) => (self as PyTypeAlias).aliased);
property(typeAliasClass, '__type_params__', (self) => newTuple((self as PyTypeAlias).typeParams));
property(typeAliasClass, '__parameters__', (self) => newTuple((self as PyTypeAlias).typeParams.map(unpackedIfTuple)));
property(typeAliasClass, '__module__', (self) => (self as PyTypeAlias).module);
method(typeAliasClass, '__getitem__', 'one', 1, 1, (self, [key]) => {
  const alias = self as PyTypeAlias;
  if (alias.typeParams.length === 0) throw typeError('Only generic type aliases are subscriptable');
  return newGenericAlias(alias, key);
});
method(typeAliasClass, '__or__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(self, other));
method(typeAliasClass, '__ror__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(other, self));
typeAliasClass.construct = (_cls, args, kwargs) => {
  checkArgs(
    { qualified: 'TypeAliasType', min: 2, max: 2, style: 'takes', keywords: ['name', 'value', 'type_params'] },
    args,
    kwargs
  );
  const name = argument(args, kwargs, 0, 'name');
  const value = argument(args, kwargs, 1, 'value') ?? None;
  if (typeof name !== 'string') {
    throw typeError(`TypeAliasType.__new__() argument 'name' must be str, not ${typeName(name ?? None)}`);
  }
  return new PyTypeAlias(name, toArray(kwargs?.get('type_params') ?? newTuple([])), () => value, '__main__');
};

method(aliasClass, '__repr__', 'none', 0, 0, (self) => aliasText(self as PyTypingAlias));
method(aliasClass, '__call__', 'expected', 0, Number.POSITIVE_INFINITY, (self, args, kwargs) =>
  callAlias(self as PyTypingAlias, args, kwargs)
);
method(aliasClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  const alias = self as PyTypingAlias;
  if (!(other instanceof PyTypingAlias)) return false;
  return (
    alias.origin === other.origin &&
    alias.args.length === other.args.length &&
    alias.args.every((arg, index) => arg === other.args[index])
  );
});
method(aliasClass, '__hash__', 'none', 0, 0, (self) => identityHash((self as PyTypingAlias).origin as PyObject));
method(aliasClass, '__or__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(self, other));
method(aliasClass, '__ror__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(other, self));
method(aliasClass, '__instancecheck__', 'one', 1, 1, () => {
  throw typeError('Subscripted generics cannot be used with class and instance checks');
});
property(aliasClass, '__origin__', (self) => (self as PyTypingAlias).origin);
property(aliasClass, '__args__', (self) => newTuple((self as PyTypingAlias).args));
property(aliasClass, '__parameters__', (self) => newTuple((self as PyTypingAlias).parameters));

function aliasText(alias: PyTypingAlias): string {
  if (alias.isUnpack) return `typing.Unpack[${typeText(alias.origin)}]`;
  return `${typeText(alias.origin)}[${alias.args.map(typeText).join(', ')}]`;
}

function callAlias(alias: PyTypingAlias, args: PyValue[], kwargs: Kwargs): PyValue {
  const { origin } = alias;
  if (origin === genericClass || alias.isUnpack) {
    throw typeError(`Type ${typeText(origin)} cannot be instantiated; it can be used only as a base class`);
  }
  const instance = callValue(origin, args, kwargs);
  try {
    setAttribute(instance, '__orig_class__', alias);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
  }
  return instance;
}
