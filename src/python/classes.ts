import { abcMetaClass, abstractInstantiationError, initAbstractClass } from './abstractClasses';
import type { Argument, ClassDef } from './ast';
import { pyRepr } from './conversions';
import { method } from './define';
import { createEnumMembers, enumLookup, EnumNamespace, isEnumClass, newEnumNamespace } from './enums';
import type { Evaluator } from './evaluator';
import { Frame } from './frame';
import { bindValue, callValue } from './objects';
import { currentRuntime } from './runtimeContext';
import { builtinClass, classOf, newTuple, None, objectClass, typeClass, typeError, typeName } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { AttributeMap, type Kwargs, PyCell, PyClass, PyInstance, PyOpaque, PyTuple, type PyValue } from './values';

/** The class of the `__dict__` and `__weakref__` entries a class defines for its instances. */
const attributeDescriptorClass = builtinClass('getset_descriptor');
method(attributeDescriptorClass, '__repr__', 'none', 0, 0, (self) => (self as PyOpaque).text);

/** Computes the C3 linearization of a class, raising TypeError when a base repeats or its bases admit none. */
export function computeMro(cls: PyClass): PyClass[] {
  const duplicate = cls.bases.find((base, index) => cls.bases.includes(base, index + 1));
  if (duplicate) throw typeError(`duplicate base class ${duplicate.name}`);
  const sequences = [...cls.bases.map((base) => [...base.mro]), [...cls.bases]];
  const result: PyClass[] = [cls];
  for (;;) {
    const nonEmpty = sequences.filter((sequence) => sequence.length > 0);
    if (nonEmpty.length === 0) return result;
    const head = nonEmpty
      .map((sequence) => sequence[0])
      .find((candidate) => nonEmpty.every((sequence) => !sequence.slice(1).includes(candidate)));
    if (!head) {
      throw typeError(
        `Cannot create a consistent method resolution order (MRO) for bases ${cls.bases.map((base) => base.name).join(', ')}`
      );
    }
    result.push(head);
    for (const sequence of nonEmpty) if (sequence[0] === head) sequence.shift();
  }
}

/** The attributes a class body may not define, which this grader does not support. */
const FORBIDDEN_CLASS_ATTRIBUTES = [
  '__new__',
  '__slots__',
  '__init_subclass__',
  '__class_getitem__',
  '__getattribute__',
  '__get__',
  '__set__',
  '__set_name__',
];

/**
 * Runs a class statement: evaluates the decorators and bases, runs the body in a namespace, and creates the class. The
 * defining frame holds the decorators and bases as temporaries until the class is decorated, so that a step taken
 * meanwhile still sees the turtles they reference.
 */
export function createClass(evaluator: Evaluator, def: ClassDef, frame: Frame): PyValue {
  const length = frame.temporaries.length;
  try {
    return buildClass(evaluator, def, frame);
  } finally {
    frame.temporaries.length = length;
  }
}

// code-gauge-allow functionNcss 38 -- Follows the steps of a class statement.
function buildClass(evaluator: Evaluator, def: ClassDef, frame: Frame): PyValue {
  const runtime = currentRuntime();
  const decorators = def.decorators.map((decorator) => {
    const value = evaluator.evaluate(decorator, frame);
    frame.temporaries.push(value);
    return value;
  });
  const { bases, hasAbcMetaclass, boundary } = evaluateClassArguments(evaluator, def, frame);
  const effectiveBases = bases.length > 0 ? bases : [objectClass];
  checkLayout(effectiveBases);
  const isLibrary = moduleNameOf(frame) !== '__main__';
  const namespace = bases.some((base) => base.flags.isEnum)
    ? newEnumNamespace(def.name, bases, isLibrary)
    : new Map<string, PyValue>();
  namespace.set('__module__', moduleNameOf(frame));
  namespace.set('__qualname__', def.qualifiedName);
  namespace.set('__firstlineno__', BigInt(def.row + 1));
  if (def.doc !== undefined) namespace.set('__doc__', def.doc);
  const classCell = new PyCell();
  const body = runClassBody(evaluator, def, frame, namespace, classCell);
  namespace.delete('__qualname__');
  for (const forbidden of FORBIDDEN_CLASS_ATTRIBUTES) {
    if (namespace.has(forbidden) && !(isLibrary && LIBRARY_CLASS_ATTRIBUTES.has(forbidden))) {
      throw new UnsupportedFeatureError(`クラスの ${forbidden} の定義`);
    }
  }
  const cls = newClass(def, effectiveBases, namespace, moduleNameOf(frame));
  if (hasAbcMetaclass) initAbstractClass(cls, abcMetaClass);
  else if (effectiveBases.some((base) => base.abc)) initAbstractClass(cls);
  cls.annotationNames = body.annotations.map(([name]) => name);
  runtime.classAnnotationThunks.set(cls, body.annotations);
  classCell.value = cls;
  setNames(cls);
  if (namespace instanceof EnumNamespace) createEnumMembers(cls, namespace, boundary);
  let result: PyValue = cls;
  for (const decorator of decorators.toReversed()) result = callValue(decorator, [result]);
  return result;
}

/**
 * The attributes standard library code written in Python may define, whose protocols the interpreter runs for the
 * classes of that code only: a descriptor's `__get__` and `__set_name__` (as functools.cached_property has) and
 * `__class_getitem__`.
 */
const LIBRARY_CLASS_ATTRIBUTES = new Set(['__class_getitem__', '__get__', '__set_name__']);

/** Calls `__set_name__` of the class attributes that define it, as `type.__new__` does. */
function setNames(cls: PyClass): void {
  for (const [name, value] of cls.dict) {
    if (!(value instanceof PyInstance)) continue;
    const setName = value.cls.lookup('__set_name__');
    if (setName !== undefined) callValue(bindValue(setName, value), [cls, name]);
  }
}

/** The name of the module whose code runs in a frame: the program's, or a standard library module written in Python. */
export function moduleNameOf(frame: Frame): string {
  const name = frame.globals.get('__name__');
  return typeof name === 'string' ? name : '__main__';
}

/** Runs a class body in a frame of its own, filling `namespace`, and returns that frame. */
function runClassBody(
  evaluator: Evaluator,
  def: ClassDef,
  frame: Frame,
  namespace: Map<string, PyValue>,
  classCell: PyCell
): Frame {
  const runtime = currentRuntime();
  const cells = new Map<string, PyCell>();
  for (const name of def.scope.frees) cells.set(name, frame.cells.get(name) ?? new PyCell());
  cells.set('__class__', classCell);
  const body = new Frame('class', namespace, cells, frame.globals, undefined, false, def.scope, undefined, classCell);
  runtime.pushFrame(body);
  try {
    evaluator.runModule(def.body, body);
  } finally {
    runtime.popFrame();
  }
  return body;
}

/**
 * Evaluates the arguments of a class statement: the bases, and the two keywords this grader runs, which are
 * `metaclass=ABCMeta` and the `boundary=` of a Flag class.
 */
function evaluateClassArguments(
  evaluator: Evaluator,
  def: ClassDef,
  frame: Frame
): { bases: PyClass[]; hasAbcMetaclass: boolean; boundary?: PyValue } {
  const bases: PyClass[] = [];
  let hasAbcMetaclass = false;
  let boundary: PyValue | undefined;
  for (const argument of def.bases) {
    if (isAbcMetaclass(evaluator, argument, frame)) hasAbcMetaclass = true;
    else if (argument.kind === 'keyword' && argument.name === 'boundary' && bases.some((base) => base.flags.isEnum)) {
      boundary = evaluator.evaluate(argument.value, frame);
    } else {
      const base = evaluateBase(evaluator, def, argument, frame);
      frame.temporaries.push(base);
      bases.push(base);
    }
  }
  return { bases, hasAbcMetaclass, boundary };
}

/** Whether an argument of a class statement is `metaclass=ABCMeta`, the one metaclass this grader runs. */
function isAbcMetaclass(evaluator: Evaluator, argument: Argument, frame: Frame): boolean {
  return (
    argument.kind === 'keyword' &&
    argument.name === 'metaclass' &&
    evaluator.evaluate(argument.value, frame) === abcMetaClass
  );
}

function evaluateBase(evaluator: Evaluator, def: ClassDef, argument: Argument, frame: Frame): PyClass {
  if (argument.kind === 'keyword') {
    if (argument.name === 'metaclass') throw new UnsupportedFeatureError('メタクラス（metaclass=）');
    throw new UnsupportedFeatureError('クラスの定義のキーワード引数（__init_subclass__）');
  }
  if (argument.kind !== 'positional') throw new UnsupportedFeatureError('クラスの基底クラスの * や **');
  const base = evaluator.evaluate(argument.value, frame);
  if (!(base instanceof PyClass)) throw typeError(`bases must be types`);
  if (base.isBuiltin && !base.isBaseType) throw typeError(`type '${base.name}' is not an acceptable base type`);
  if (base.flags.isEnum && base.enumMembers && base.enumMembers.length > 0) {
    throw typeError(`<enum '${def.name}'> cannot extend ${pyRepr(base)}`);
  }
  return base;
}

/** Creates a class from the namespace its body filled. */
function newClass(def: ClassDef, bases: PyClass[], namespace: Map<string, PyValue>, module: string): PyClass {
  namespace.set('__static_attributes__', newTuple(def.staticAttributes));
  const cls = newClassFromNamespace(def.name, bases, namespace, module);
  cls.qualifiedName = def.qualifiedName;
  cls.definition = def;
  return cls;
}

/** Creates a class without a class statement, as `types.new_class` does for `dataclasses.make_dataclass`. */
export function createDynamicClass(
  name: string,
  bases: PyClass[],
  namespace: Map<string, PyValue>,
  module: string
): PyClass {
  const effectiveBases = bases.length > 0 ? bases : [objectClass];
  checkLayout(effectiveBases);
  namespace.set('__module__', module);
  const cls = newClassFromNamespace(name, effectiveBases, namespace, module);
  if (effectiveBases.some((base) => base.abc)) initAbstractClass(cls);
  return cls;
}

function newClassFromNamespace(
  name: string,
  bases: PyClass[],
  namespace: Map<string, PyValue>,
  module: string
): PyClass {
  const cls = new PyClass(name, bases, typeClass);
  cls.isBuiltin = false;
  cls.isBaseType = true;
  cls.module = module;
  cls.mro = computeMro(cls);
  const runtime = currentRuntime();
  for (const base of bases) runtime.subclassesOf(base).push(cls);
  cls.layout = { base: layoutOf(bases) };
  if (!namespace.has('__doc__')) namespace.set('__doc__', None);
  if (bases.every((base) => base.isBuiltin)) {
    for (const name of ['__dict__', '__weakref__']) {
      namespace.set(name, new PyOpaque(attributeDescriptorClass, `<attribute '${name}' of '${cls.name}' objects>`));
    }
  }
  for (const [name, value] of namespace) cls.dict.set(name, value);
  if (cls.dict.has('__eq__') && !cls.dict.has('__hash__')) cls.dict.set('__hash__', None);
  return cls;
}

function layoutOf(bases: PyClass[]): PyClass['layout']['base'] {
  for (const base of bases) if (base.layout.base !== 'object') return base.layout.base;
  return 'object';
}

/** Rejects bases whose instances could not be one object, and the builtin types this grader does not let programs extend. */
function checkLayout(bases: PyClass[]): void {
  const layouts = new Set(bases.map((base) => base.layout.base).filter((layout) => layout !== 'object'));
  for (const base of bases) {
    if (base.layout.base === 'native' && base.isBuiltin) {
      throw new UnsupportedFeatureError(`組み込み型 ${base.name} を継承するクラス`);
    }
  }
  if (layouts.size > 1) throw typeError('multiple bases have instance lay-out conflict');
}

type Construct = NonNullable<PyClass['construct']>;

/** Calls a class: creates an instance and runs its `__init__`. */
// code-gauge-allow functionCognitiveComplexity 21 -- Follows how calling a class creates and initializes an instance.
export function instantiate(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  if (cls === typeClass && args.length === 1 && !kwargs) return classOf(args[0]);
  if (isEnumClass(cls)) return enumLookup(cls, args, kwargs);
  if (cls.construct) return currentRuntime().runNative(() => (cls.construct as Construct)(cls, args, kwargs));
  // The nearest base that constructs its instances natively: a builtin type, or a class namedtuple created.
  const builtinBase = cls.mro.find((base) => base.construct);
  if (cls.isBuiltin && !builtinBase) throw typeError(`cannot create '${cls.qualifiedName}' instances`);
  const abstract = abstractInstantiationError(cls);
  if (abstract) throw abstract;
  const instance =
    builtinBase && builtinBase !== objectClass && builtinBase.construct && !cls.isBuiltin
      ? currentRuntime().runNative(() => (builtinBase.construct as Construct)(cls, args, kwargs))
      : new PyInstance(cls);
  if (instance instanceof PyTuple && hasInstanceDict(cls, builtinBase as PyClass))
    instance.attributes = new AttributeMap();
  const init = cls.lookup('__init__');
  const hasArguments = args.length > 0 || (kwargs !== undefined && kwargs.size > 0);
  if (init === objectClass.dict.get('__init__')) {
    if (hasArguments && (builtinBase === undefined || builtinBase === objectClass)) {
      throw typeError(`${cls.qualifiedName}() takes no arguments`);
    }
    return instance;
  }
  if (init !== undefined) {
    const result = callValue(bindValue(init, instance), args, kwargs);
    if (result !== None) throw typeError(`__init__() should return None, not '${typeName(result)}'`);
  }
  return instance;
}

/** Whether instances of a subclass of a native class get a `__dict__`: some class below the native one has no `__slots__`. */
function hasInstanceDict(cls: PyClass, nativeBase: PyClass): boolean {
  return cls.mro.slice(0, cls.mro.indexOf(nativeBase)).some((each) => !each.dict.has('__slots__'));
}
