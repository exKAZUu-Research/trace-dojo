import type { ClassDef } from './ast';
import { method } from './define';
import { createEnumMembers } from './enums';
import type { Evaluator } from './evaluator';
import { Frame } from './frame';
import { bindValue, callValue, deleteItem, getAttributeOrUndefined, getItem, lookupSpecial, setItem } from './objects';
import { currentRuntime } from './runtimeContext';
import { defineClassSlots, slotNamesOf } from './slots';
import { initGenericSubclass, typingMroEntries } from './typeParams';
import {
  builtinClass,
  builtinFunctionClass,
  classmethodClass,
  classOf,
  exceptionClassNamed,
  newDict,
  newTuple,
  None,
  objectClass,
  staticmethodClass,
  typeClass,
  typeError,
  typeName,
  typingClass,
} from './types';
import { UnsupportedFeatureError } from './unsupported';
import {
  type Kwargs,
  PyBuiltinFunction,
  PyCell,
  PyClass,
  PyDescriptor,
  PyDict,
  PyError,
  PyFunction,
  PyOpaque,
  PyTuple,
  type PyValue,
} from './values';

/** The class of the `__dict__` and `__weakref__` entries a class defines for its instances. */
const attributeDescriptorClass = builtinClass('getset_descriptor');
method(attributeDescriptorClass, '__repr__', 'none', 0, 0, (self) => (self as PyOpaque).text);

/** What a class body leaves for `type.__new__` besides its namespace, keyed by that namespace. */
interface ClassBody {
  classCell: PyCell;
  annotations: [string, () => PyValue][];
}

const pendingBodies = new WeakMap<object, ClassBody>();

// The class statement -----------------------------------------------------------------------------------------------

/** Runs a class statement: evaluates the bases, runs the body in a namespace, and calls the metaclass. */
// code-gauge-allow functionNcss 31 -- Follows how a class statement prepares its namespace and calls its metaclass.
export function createClass(
  evaluator: Evaluator,
  def: ClassDef,
  frame: Frame,
  decorators: PyValue[] = def.decorators.map((decorator) => evaluator.evaluate(decorator, frame))
): PyValue {
  const { args: originalBases, kwargs } = evaluator.arguments(def.bases, frame, buildClass, 2);
  const bases = resolveBases(originalBases, def.name);
  const keywords = new Map(kwargs);
  const explicit = keywords.get('metaclass');
  keywords.delete('metaclass');
  const meta =
    explicit === undefined || explicit instanceof PyClass
      ? winningMeta(explicit ?? metaOfBases(bases), bases)
      : explicit;
  const prepared = meta === typeClass ? undefined : prepare(meta, def.name, bases, keywords);
  const namespace = prepared === undefined ? new Map<string, PyValue>() : new MappingNamespace(prepared);
  // A class body reads `__module__` from `__name__`, which code `exec` runs in fresh globals finds in builtins.
  namespace.set('__module__', frame.globals.get('__name__') ?? currentRuntime().builtins.get('__name__') ?? None);
  namespace.set('__qualname__', def.qualifiedName);
  namespace.set('__firstlineno__', BigInt(def.row + 1));
  if (def.doc !== undefined) namespace.set('__doc__', def.doc);
  if (bases !== originalBases) namespace.set('__orig_bases__', newTuple(originalBases));
  const classCell = new PyCell();
  const body = runClassBody(evaluator, def, frame, namespace, classCell);
  namespace.set('__static_attributes__', newTuple(def.staticAttributes));
  const factory = bases.find(
    (base): base is PyClass => base instanceof PyClass && base.classFactory !== undefined
  )?.classFactory;
  if (factory) {
    const cls = factory(def, namespace, body.annotations, keywords.size > 0 ? keywords : undefined, bases as PyClass[]);
    classCell.value = cls;
    let decorated: PyValue = cls;
    for (const decorator of decorators.toReversed()) decorated = callValue(decorator, [decorated]);
    return decorated;
  }
  let result = callMeta(meta, def.name, bases, prepared ?? namespace, keywords, {
    classCell,
    annotations: body.annotations,
  });
  for (const decorator of decorators.toReversed()) result = callValue(decorator, [result]);
  return result;
}

/** Creates the class of a class statement by calling its metaclass, which `type` does without a dict. */
function callMeta(
  meta: PyValue,
  name: string,
  bases: PyValue[],
  namespace: PyValue | Map<string, PyValue>,
  keywords: Map<string, PyValue>,
  body: ClassBody
): PyValue {
  if (meta === typeClass && namespace instanceof Map) {
    pendingBodies.set(namespace, body);
    return typeNew(typeClass, name, bases, namespace, keywords);
  }
  const container = namespace instanceof Map ? newDict(namespace) : namespace;
  if (typeof container === 'object') pendingBodies.set(container, body);
  const result = callValue(meta, [name, newTuple(bases), container], keywords.size > 0 ? keywords : undefined);
  // A metaclass may pass type.__new__ a copy of the namespace, which CPython's __classcell__ entry follows.
  if (result instanceof PyClass && body.classCell.value === undefined) applyBody(result, body);
  return result;
}

/** Replaces the bases that are not classes but define `__mro_entries__`, such as `list[int]`, by its result. */
function resolveBases(bases: PyValue[], name: string): PyValue[] {
  if (bases.every((base) => base instanceof PyClass)) return bases;
  const resolved: PyValue[] = [];
  for (const base of bases) {
    const typing = typingMroEntries(base, bases, name);
    if (typing) {
      resolved.push(...typing);
      continue;
    }
    const entries = base instanceof PyClass ? undefined : lookupSpecial(base, '__mro_entries__');
    if (entries === undefined) {
      resolved.push(base);
      continue;
    }
    const result = callValue(bindValue(entries, base), [newTuple(bases)]);
    if (!(result instanceof PyTuple)) throw typeError('__mro_entries__ must return a tuple');
    resolved.push(...result.items);
  }
  return resolved;
}

/** Stands for `__build_class__` in the errors about unpacking a class statement's arguments. */
const buildClass = new PyBuiltinFunction(builtinFunctionClass, '__build_class__', () => None);

function metaOfBases(bases: PyValue[]): PyClass {
  return bases.length === 0 ? typeClass : classOf(bases[0]);
}

/** The most derived of a metaclass and the metaclasses of the bases, raising TypeError when there is none. */
function winningMeta(meta: PyClass, bases: readonly PyValue[]): PyClass {
  let winner = meta;
  for (const base of bases) {
    const candidate = classOf(base);
    if (winner.isSubclassOf(candidate)) continue;
    if (candidate.isSubclassOf(winner)) {
      winner = candidate;
      continue;
    }
    throw typeError(
      'metaclass conflict: the metaclass of a derived class must be a (non-strict) subclass of the metaclasses of all its bases'
    );
  }
  return winner;
}

/** Calls the metaclass's `__prepare__`, unless it is `type`'s, returning the mapping the class body fills. */
function prepare(meta: PyValue, name: string, bases: PyValue[], keywords: Map<string, PyValue>): PyValue | undefined {
  if (meta instanceof PyClass && meta.lookup('__prepare__') === typeClass.dict.get('__prepare__')) return undefined;
  const prepareMethod = getAttributeOrUndefined(meta, '__prepare__');
  if (prepareMethod === undefined) return undefined;
  const mapping = callValue(prepareMethod, [name, newTuple(bases)], keywords.size > 0 ? keywords : undefined);
  if (lookupSpecial(mapping, '__getitem__') === undefined) {
    const owner = meta instanceof PyClass ? meta.name : '<metaclass>';
    throw typeError(`${owner}.__prepare__() must return a mapping, not ${typeName(mapping)}`);
  }
  return mapping;
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

/** A class body's namespace that a metaclass's `__prepare__` returned, read and written through its item methods. */
class MappingNamespace extends Map<string, PyValue> {
  constructor(private readonly mapping: PyValue) {
    super();
  }

  override get(name: string): PyValue | undefined {
    try {
      return getItem(this.mapping, name);
    } catch (error) {
      if (isKeyError(error)) return undefined;
      throw error;
    }
  }

  override has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  override set(name: string, value: PyValue): this {
    setItem(this.mapping, name, value);
    return this;
  }

  override delete(name: string): boolean {
    try {
      deleteItem(this.mapping, name);
      return true;
    } catch (error) {
      if (isKeyError(error)) return false;
      throw error;
    }
  }

  override *[Symbol.iterator](): MapIterator<[string, PyValue]> {
    if (!(this.mapping instanceof PyDict)) return;
    for (const entry of this.mapping.store.ordered()) {
      if (typeof entry.key === 'string') yield [entry.key, entry.value];
    }
  }
}

function isKeyError(error: unknown): boolean {
  return error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('KeyError'));
}

// A generic alias such as `list[int]` stands for its class among the bases of a class statement.
method(typingClass, '__mro_entries__', 'one', 1, 1, (self) => {
  const origin = (self as PyOpaque).data;
  if (!(origin instanceof PyClass))
    throw new UnsupportedFeatureError(`${(self as PyOpaque).text} を基底クラスにすること`);
  return newTuple([origin]);
});

// type.__new__ ------------------------------------------------------------------------------------------------------

/** `type.__new__(meta, name, bases, namespace, **kwargs)`: creates a class and runs the hooks its bases define. */
export function typeNew(
  meta: PyClass,
  name: string,
  bases: readonly PyValue[],
  namespace: Map<string, PyValue> | PyDict,
  kwargs: Map<string, PyValue>
): PyClass {
  const winner = winningMeta(meta, bases);
  const classBases = checkBases(name, bases);
  const effectiveBases = classBases.length > 0 ? classBases : [objectClass];
  checkLayout(effectiveBases);
  const entries = namespaceEntries(namespace);
  const cls = new PyClass(name, effectiveBases, winner);
  cls.isBuiltin = false;
  cls.isBaseType = true;
  cls.layout = { base: layoutOf(effectiveBases) };
  cls.mro = computeMro(cls);
  cls.module = typeof entries.get('__module__') === 'string' ? (entries.get('__module__') as string) : '__main__';
  cls.qualifiedName = qualifiedNameOf(entries, name);
  entries.delete('__qualname__');
  cls.flags.definesGetattribute =
    entries.has('__getattribute__') || classBases.some((base) => base.flags.definesGetattribute);
  fillClassDict(cls, entries);
  const body = pendingBodies.get(namespace);
  if (body) {
    pendingBodies.delete(namespace);
    applyBody(cls, body);
  }
  if (effectiveBases.some((base) => base.flags.isEnum)) createEnumMembers(cls);
  const originalBases = cls.dict.get('__orig_bases__');
  initGenericSubclass(cls, originalBases instanceof PyTuple ? originalBases.items : undefined);
  for (const base of cls.mro.slice(1)) base.subclassHook?.(cls);
  setNames(cls);
  initSubclass(cls, kwargs);
  return cls;
}

/** Gives a class what its class statement's body left besides its namespace. */
function applyBody(cls: PyClass, body: ClassBody): void {
  cls.annotationNames = body.annotations.map(([annotated]) => annotated);
  currentRuntime().classAnnotationThunks.set(cls, body.annotations);
  body.classCell.value = cls;
}

/** Checks the bases a class statement or `type()` passes, as `type.__new__` does. */
function checkBases(name: string, bases: readonly PyValue[]): PyClass[] {
  const seen = new Set<PyClass>();
  return bases.map((base) => {
    if (!(base instanceof PyClass)) throw typeError('bases must be types');
    if (base.isBuiltin && !base.isBaseType) throw typeError(`type '${base.name}' is not an acceptable base type`);
    if (base.flags.isEnum && base.enumMembers && base.enumMembers.length > 0) {
      throw typeError(`${name}: cannot extend ${base.qualifiedName}`);
    }
    if (seen.has(base)) throw typeError(`duplicate base class ${base.name}`);
    seen.add(base);
    return base;
  });
}

function namespaceEntries(namespace: Map<string, PyValue> | PyDict): Map<string, PyValue> {
  if (!(namespace instanceof PyDict)) return new Map(namespace);
  const entries = new Map<string, PyValue>();
  for (const entry of namespace.store.ordered()) if (typeof entry.key === 'string') entries.set(entry.key, entry.value);
  return entries;
}

function qualifiedNameOf(entries: Map<string, PyValue>, name: string): string {
  const qualified = entries.get('__qualname__');
  if (qualified === undefined) return name;
  if (typeof qualified !== 'string') throw typeError(`type __qualname__ must be a str, not ${typeName(qualified)}`);
  return qualified;
}

/** Fills a new class's dictionary from its namespace, adding what `type.__new__` adds. */
function fillClassDict(cls: PyClass, entries: Map<string, PyValue>): void {
  if (!entries.has('__module__')) entries.set('__module__', '__main__');
  wrapImplicitMethod(entries, '__new__', staticmethodClass);
  wrapImplicitMethod(entries, '__init_subclass__', classmethodClass);
  wrapImplicitMethod(entries, '__class_getitem__', classmethodClass);
  if (!entries.has('__doc__')) entries.set('__doc__', None);
  const slots = defineClassSlots(cls, entries);
  cls.slotNames = slotNamesOf(cls, slots);
  const plain = cls.bases.every((base) => base.isBuiltin);
  for (const name of ['__dict__', '__weakref__']) {
    if (slots === undefined ? plain : slots.includes(name)) {
      entries.set(name, new PyOpaque(attributeDescriptorClass, `<attribute '${name}' of '${cls.name}' objects>`));
    }
  }
  for (const [name, value] of entries) cls.dict.set(name, value);
  if (cls.dict.has('__eq__') && !cls.dict.has('__hash__')) cls.dict.set('__hash__', None);
}

/** Makes a plain function a static or class method, as CPython does for the methods it calls implicitly. */
function wrapImplicitMethod(entries: Map<string, PyValue>, name: string, kind: PyClass): void {
  const value = entries.get(name);
  if (value instanceof PyFunction) entries.set(name, new PyDescriptor(kind, value));
}

/** Calls `__set_name__` on the attributes of a new class that define it. */
function setNames(cls: PyClass): void {
  // The hooks may change the class's dictionary, so they run on the attributes it had when it was created.
  for (const [name, value] of new Map(cls.dict)) {
    if (typeof value !== 'object' || classOf(value).isBuiltin) continue;
    const setName = lookupSpecial(value, '__set_name__');
    if (setName !== undefined) callValue(bindValue(setName, value), [cls, name]);
  }
}

/** Calls the `__init_subclass__` of the new class's bases, with the class statement's keyword arguments. */
function initSubclass(cls: PyClass, kwargs: Map<string, PyValue>): void {
  for (const base of cls.mro.slice(1)) {
    const hook = base.dict.get('__init_subclass__');
    if (hook === undefined) continue;
    callValue(bindValue(hook, cls, cls), [], kwargs.size > 0 ? kwargs : undefined);
    return;
  }
}

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

function layoutOf(bases: PyClass[]): PyClass['layout']['base'] {
  for (const base of bases) if (base.layout.base !== 'object') return base.layout.base;
  return 'object';
}

/** Rejects bases whose instances could not be one object: those whose builtin layouts are not on one chain. */
function checkLayout(bases: PyClass[]): void {
  const solids = bases.map((base) => solidBase(base));
  let winner = solids[0];
  for (const solid of solids) if (solid.isSubclassOf(winner)) winner = solid;
  if (solids.some((solid) => !winner.isSubclassOf(solid))) {
    throw typeError('multiple bases have instance lay-out conflict');
  }
}

/** The nearest builtin class whose instances have a layout of their own, as CPython's solid_base finds. */
export function solidBase(cls: PyClass): PyClass {
  return cls.mro.find((each) => each.isBuiltin && each.newInstance !== undefined) ?? objectClass;
}

// type ---------------------------------------------------------------------------------------------------------------

/** `type(name, bases, namespace)` and `type.__new__(meta, name, bases, namespace)`. */
export function typeNewFromArguments(meta: PyClass, args: PyValue[], kwargs: Kwargs): PyClass {
  if (args.length !== 3) throw typeError(`type.__new__() takes exactly 3 arguments (${args.length} given)`);
  const [name, bases, namespace] = args;
  if (typeof name !== 'string') throw typeError(`type.__new__() argument 1 must be str, not ${typeName(name)}`);
  if (!(bases instanceof PyTuple)) throw typeError(`type.__new__() argument 2 must be tuple, not ${typeName(bases)}`);
  if (!(namespace instanceof PyDict)) {
    throw typeError(`type.__new__() argument 3 must be dict, not ${typeName(namespace)}`);
  }
  // As type_new does, a more derived metaclass of the bases with a `__new__` of its own, such as ABCMeta, creates it.
  const winner = winningMeta(meta, bases.items);
  if (winner !== meta && winner.newInstance && winner.lookup('__new__') !== typeClass.dict.get('__new__')) {
    return winner.newInstance(winner, args, kwargs) as PyClass;
  }
  return typeNew(meta, name, bases.items, namespace, new Map(kwargs));
}
