import type { Argument, ClassDef } from './ast';
import { method } from './define';
import { createEnumMembers, enumLookup, isEnumClass } from './enums';
import type { Evaluator } from './evaluator';
import { Frame } from './frame';
import { bindValue, callValue } from './objects';
import { currentRuntime } from './runtimeContext';
import { builtinClass, classOf, newTuple, None, objectClass, typeClass, typeError, typeName } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { type Kwargs, PyCell, PyClass, PyInstance, PyOpaque, type PyValue } from './values';

/** The class of the `__dict__` and `__weakref__` entries a class defines for its instances. */
const attributeDescriptorClass = builtinClass('getset_descriptor');
method(attributeDescriptorClass, '__repr__', 'none', 0, 0, (self) => (self as PyOpaque).text);

/** Computes the C3 linearization of a class, raising TypeError when its bases admit none. */
export function computeMro(cls: PyClass): PyClass[] {
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

/** Runs a class statement: evaluates the bases, runs the body in a namespace, and creates the class. */
export function createClass(evaluator: Evaluator, def: ClassDef, frame: Frame): PyValue {
  const runtime = currentRuntime();
  const decorators = def.decorators.map((decorator) => evaluator.evaluate(decorator, frame));
  const bases = def.bases.map((argument) => evaluateBase(evaluator, def, argument, frame));
  const effectiveBases = bases.length > 0 ? bases : [objectClass];
  checkLayout(effectiveBases);
  const namespace = new Map<string, PyValue>([
    ['__module__', '__main__'],
    ['__qualname__', def.qualifiedName],
    ['__firstlineno__', BigInt(def.row + 1)],
  ]);
  if (def.doc !== undefined) namespace.set('__doc__', def.doc);
  const classCell = new PyCell();
  const body = runClassBody(evaluator, def, frame, namespace, classCell);
  namespace.delete('__qualname__');
  for (const forbidden of FORBIDDEN_CLASS_ATTRIBUTES) {
    if (namespace.has(forbidden)) throw new UnsupportedFeatureError(`クラスの ${forbidden} の定義`);
  }
  const cls = newClass(def, effectiveBases, namespace);
  cls.annotationNames = body.annotations.map(([name]) => name);
  runtime.classAnnotationThunks.set(cls, body.annotations);
  classCell.value = cls;
  if (bases.some((base) => base.flags.isEnum)) createEnumMembers(cls);
  let result: PyValue = cls;
  for (const decorator of decorators.toReversed()) result = callValue(decorator, [result]);
  return result;
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
  const body = new Frame('class', namespace, cells, frame.globals, undefined, false, def.scope, undefined, classCell);
  runtime.pushFrame(body);
  try {
    evaluator.runModule(def.body, body);
  } finally {
    runtime.popFrame();
  }
  return body;
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
    throw typeError(`${def.name}: cannot extend ${base.qualifiedName}`);
  }
  return base;
}

/** Creates a class from the namespace its body filled. */
function newClass(def: ClassDef, bases: PyClass[], namespace: Map<string, PyValue>): PyClass {
  const cls = new PyClass(def.name, bases, typeClass);
  cls.isBuiltin = false;
  cls.isBaseType = true;
  cls.module = '__main__';
  cls.qualifiedName = def.qualifiedName;
  cls.definition = def;
  cls.mro = computeMro(cls);
  cls.layout = { base: layoutOf(bases) };
  namespace.set('__static_attributes__', newTuple(def.staticAttributes));
  if (!namespace.has('__doc__')) namespace.set('__doc__', None);
  if (bases.every((base) => base.isBuiltin)) {
    for (const name of ['__dict__', '__weakref__']) {
      namespace.set(name, new PyOpaque(attributeDescriptorClass, `<attribute '${name}' of '${def.name}' objects>`));
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

/** Calls a class: creates an instance and runs its `__init__`. */
// code-gauge-allow functionCognitiveComplexity 20 -- Follows how calling a class creates and initializes an instance.
export function instantiate(cls: PyClass, args: PyValue[], kwargs: Kwargs): PyValue {
  const runtime = currentRuntime();
  if (cls === typeClass && args.length === 1 && !kwargs) return classOf(args[0]);
  if (isEnumClass(cls)) return enumLookup(cls, args, kwargs);
  if (cls.construct) return cls.construct(cls, args, kwargs);
  const builtinBase = cls.mro.find((base) => base.isBuiltin && base.construct);
  if (cls.isBuiltin && !builtinBase) throw typeError(`cannot create '${cls.qualifiedName}' instances`);
  let instance: PyValue;
  if (builtinBase && builtinBase !== objectClass && builtinBase.construct && !cls.isBuiltin) {
    instance = builtinBase.construct(cls, args, kwargs);
  } else {
    runtime.allocate(1);
    instance = new PyInstance(cls);
  }
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
