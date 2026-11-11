import type { ClassDef } from '../ast';
import { pyRepr } from '../conversions';
import { builtin } from '../define';
import { getAttributeOrUndefined, isCallable } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { genericClass, mroEntryHooks, parameterDeclaringClasses } from '../typeParams';
import { builtinClass, classOf, dictClass, newDict, newSet, None, objectClass, typeClass, typeError } from '../types';
import { type ClassAnnotations, type Kwargs, PyClass, type PyValue } from '../values';
import { namedTupleClass } from './collections';
import { PyNewType } from './typingTypeVars';

// Protocol -------------------------------------------------------------------------------------------------------------

/** `typing.Protocol`, whose direct subclasses are protocols: classes that only describe what their instances have. */
export const protocolClass = new PyClass('Protocol', [genericClass], typeClass);
protocolClass.mro = [protocolClass, ...genericClass.mro];
protocolClass.module = 'typing';
protocolClass.layout = { base: 'object' };
protocolClass.isBaseType = true;
parameterDeclaringClasses.add(protocolClass);

const runtimeProtocols = new WeakSet<PyClass>();
const protocols = new WeakSet<PyClass>();

/** The attributes of a class that `_get_protocol_attrs` leaves out, being typing's own or every class's. */
const NON_MEMBERS = new Set([
  '__module__',
  '__qualname__',
  '__doc__',
  '__dict__',
  '__weakref__',
  '__init__',
  '__new__',
  '__slots__',
  '__annotations__',
  '__annotate__',
  '__parameters__',
  '__orig_bases__',
  '__type_params__',
  '__static_attributes__',
  '__firstlineno__',
  '__match_args__',
  '__subclasshook__',
  '__class_getitem__',
  '__abstractmethods__',
  '__protocol_attrs__',
  '__non_callable_proto_members__',
]);

protocolClass.subclassHook = (cls) => {
  if (!cls.bases.includes(protocolClass)) return;
  const other = cls.bases.find((base) => base !== protocolClass && base !== genericClass && !protocols.has(base));
  if (other) throw typeError(`Protocols can only inherit from other protocols, got ${classText(other)}`);
  protocols.add(cls);
  cls.construct = () => {
    throw typeError('Protocols cannot be instantiated');
  };
  cls.instanceCheck = (value) => protocolInstanceCheck(cls, value);
};

function protocolInstanceCheck(cls: PyClass, value: PyValue): boolean {
  if (!runtimeProtocols.has(cls)) {
    throw typeError('Instance and class checks can only be used with @runtime_checkable protocols');
  }
  if (classOf(value).isSubclassOf(cls)) return true;
  for (const name of protocolMembers(cls)) {
    const member = getAttributeOrUndefined(value, name);
    if (member === undefined) return false;
    if (member === None && isCallable(cls.lookup(name) ?? None)) return false;
  }
  return true;
}

/** The names a protocol requires: those its protocol classes define or annotate. */
function protocolMembers(cls: PyClass): string[] {
  const names = new Set<string>();
  for (const base of cls.mro.slice(0, -1)) {
    if (base === protocolClass || base === genericClass) continue;
    for (const name of [...base.dict.keys(), ...base.annotationNames]) {
      if (!NON_MEMBERS.has(name) && !name.startsWith('_abc_')) names.add(name);
    }
  }
  return [...names];
}

const runtimeCheckable = builtin('runtime_checkable', 'one', 1, 1, ([cls]) => {
  if (!(cls instanceof PyClass) || !protocols.has(cls)) {
    throw typeError(
      `@runtime_checkable can be only applied to protocol classes, got ${cls instanceof PyClass ? classText(cls) : pyRepr(cls)}`
    );
  }
  runtimeProtocols.add(cls);
  return cls;
});

function classText(cls: PyClass): string {
  return `<class '${cls.module === 'builtins' ? '' : `${cls.module}.`}${cls.qualifiedName}'>`;
}

// NamedTuple ------------------------------------------------------------------------------------------------------------

/** What a class statement deriving from `typing.NamedTuple` derives from, which creates a namedtuple class instead. */
const namedTupleBase = builtinClass('NamedTuple');
namedTupleBase.module = 'typing';
namedTupleBase.layout = { base: 'object' };
namedTupleBase.isBaseType = true;

/** The attributes of a NamedTuple class body that the namedtuple class does not take. */
const NAMED_TUPLE_SPECIAL = new Set([
  '__module__',
  '__name__',
  '__annotations__',
  '__qualname__',
  '__firstlineno__',
  '__static_attributes__',
]);

// code-gauge-allow functionCognitiveComplexity 16 -- Follows how NamedTupleMeta builds the namedtuple class from the class body.
namedTupleBase.classFactory = (def, namespace, annotations, keywords) => {
  if (keywords && keywords.size > 0) throw typeError('NamedTuple() takes no keyword arguments');
  const fields = annotations.map(([name]) => name);
  const defaults: PyValue[] = [];
  const defaultNames: string[] = [];
  for (const name of fields) {
    const value = namespace.get(name);
    if (value !== undefined) {
      defaults.push(value);
      defaultNames.push(name);
    } else if (defaultNames.length > 0) {
      const plural = defaultNames.length > 1 ? 's' : '';
      throw typeError(
        `Non-default namedtuple field ${name} cannot follow default field${plural} ${defaultNames.join(', ')}`
      );
    }
  }
  const cls = namedTupleClass(def.name, fields, defaults);
  cls.qualifiedName = def.qualifiedName;
  cls.dict.set('__annotations__', newDict(annotations.map(([name, evaluate]) => [name, evaluate()])));
  cls.annotationNames = fields;
  for (const [name, value] of namespace) {
    if (NAMED_TUPLE_SPECIAL.has(name) || fields.includes(name)) continue;
    if (
      name === '_fields' ||
      name === '_make' ||
      name === '_replace' ||
      name === '_asdict' ||
      name === '_field_defaults' ||
      name === '__new__' ||
      name === '__init__' ||
      name === '__getnewargs__'
    ) {
      throw typeError(`Cannot overwrite NamedTuple attribute ${name}`);
    }
    cls.dict.set(name, value);
  }
  return cls;
};

const namedTuple = builtin('NamedTuple', 'takes', 1, 2, () => {
  throw currentRuntime().unsupported('関数の形の NamedTuple()');
});

// TypedDict -------------------------------------------------------------------------------------------------------------

/** What a class statement deriving from `typing.TypedDict` derives from, which creates a TypedDict class instead. */
const typedDictBase = builtinClass('TypedDict');
typedDictBase.module = 'typing';
typedDictBase.layout = { base: 'object' };
typedDictBase.isBaseType = true;

/** The keys of each TypedDict class, which the TypedDicts deriving from it inherit. */
const typedDicts = new WeakMap<
  PyClass,
  { annotations: ClassAnnotations; required: Set<string>; optional: Set<string> }
>();

typedDictBase.classFactory = createTypedDict;

// code-gauge-allow functionNcss 43 -- Follows how typing._TypedDictMeta creates the class and merges the keys of its bases.
// code-gauge-allow functionCognitiveComplexity 18 -- Follows how typing._TypedDictMeta merges the keys of its bases.
function createTypedDict(
  def: ClassDef,
  namespace: Map<string, PyValue>,
  own: ClassAnnotations,
  keywords: Kwargs,
  bases: PyClass[]
): PyClass {
  for (const key of keywords?.keys() ?? []) {
    if (key !== 'total') throw typeError(`__init_subclass__() takes no keyword arguments`);
  }
  for (const [name, value] of namespace) {
    if (typeof value === 'object' && isCallable(value) && !name.startsWith('__')) {
      throw typeError('TypedDict classes can contain only type annotations');
    }
  }
  const total = keywords?.get('total') ?? true;
  const cls = new PyClass(def.name, [dictClass], typeClass);
  cls.isBuiltin = false;
  cls.module = '__main__';
  cls.qualifiedName = def.qualifiedName;
  cls.mro = [cls, dictClass, objectClass];
  cls.layout = { base: 'native' };
  cls.construct = (_cls, args, kwargs) =>
    (dictClass.construct as NonNullable<PyClass['construct']>)(dictClass, args, kwargs);
  cls.instanceCheck = () => {
    throw typeError('TypedDict does not support instance and class checks');
  };
  const required = new Set<string>();
  const optional = new Set<string>();
  const annotations: ClassAnnotations = [];
  for (const base of bases) {
    const inherited = typedDicts.get(base);
    if (!inherited) continue;
    annotations.push(...inherited.annotations);
    for (const name of inherited.required) required.add(name);
    for (const name of inherited.optional) optional.add(name);
  }
  for (const [name, evaluate] of own) {
    annotations.push([name, evaluate]);
    required.delete(name);
    optional.delete(name);
    (total === false ? optional : required).add(name);
  }
  typedDicts.set(cls, { annotations, required, optional });
  cls.classFactory = createTypedDict;
  cls.dict.set('__annotations__', newDict(annotations.map(([name, evaluate]) => [name, evaluate()])));
  cls.dict.set('__required_keys__', newSet(required, true));
  cls.dict.set('__optional_keys__', newSet(optional, true));
  cls.dict.set('__total__', total);
  cls.dict.set('__doc__', namespace.get('__doc__') ?? None);
  cls.annotationNames = annotations.map(([name]) => name);
  return cls;
}

const typedDict = builtin('TypedDict', 'takes', 1, 2, () => {
  throw currentRuntime().unsupported('関数の形の TypedDict()');
});

mroEntryHooks.push((base, className) => {
  if (base === namedTuple) return [namedTupleBase];
  if (base === typedDict) return [typedDictBase];
  if (base instanceof PyNewType) {
    throw typeError(
      `Cannot subclass an instance of NewType. Perhaps you were looking for: \`${className} = NewType('${className}', ${base.name})\``
    );
  }
  return;
});

/** The names `typing` exports for protocols, named tuples, and typed dicts. */
export const TYPING_CLASSES: [string, PyValue][] = [
  ['Protocol', protocolClass],
  ['runtime_checkable', runtimeCheckable],
  ['NamedTuple', namedTuple],
  ['TypedDict', typedDict],
];
