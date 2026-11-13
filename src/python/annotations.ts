import type { FunctionDef, NameRef, Statement } from './ast';
import { Frame } from './frame';
import { callValue, getItem, isCallable, isTruthy, setItem } from './objects';
import { compareOp } from './operators';
import { parseDynamicCode } from './parse';
import { currentRuntime } from './runtimeContext';
import { functionClass, newDict, None, pyError, typeError, typeName } from './types';
import { type Annotation, PyCell, type PyClass, PyDict, PyFunction, type PyModule, type PyValue } from './values';

// The lazy annotations of Python 3.14 (PEP 649 and PEP 749): a function, class, or module evaluates its annotations
// only when its `__annotate__` is called, which reading `__annotations__` does once and caches.

/**
 * How `__annotate__` evaluates a name of an annotation when annotationlib calls it in a fake namespace for the
 * FORWARDREF and STRING formats: the value, or the stand-in that records the operations applied to the name.
 */
export interface FakeNames {
  globals: PyValue;
  /** Whether names of enclosing functions and the class body that have values evaluate to them. */
  allowEvaluation: boolean;
  stringifier: (name: string) => PyValue;
}

/**
 * The `__annotate__` function the compiler gives a function, class, or module: a Python function of one positional-only
 * parameter, as CPython's, whose body this interpreter runs natively, evaluating the annotations for formats 1 and 2.
 */
export class PyAnnotateFunction extends PyFunction {
  constructor(
    qualifiedName: string,
    globals: Map<string, PyValue>,
    closure: Map<string, PyCell>,
    readonly annotations: () => readonly Annotation[]
  ) {
    // Each has a definition of its own, as its code object's `co_qualname` names its owner.
    super(functionClass, { ...annotateDefinition(), qualifiedName }, globals, closure, [], new Map(), undefined);
  }

  /** The body: `if format > VALUE_WITH_FAKE_GLOBALS: raise NotImplementedError`, then the annotations' values. */
  run(format: PyValue): PyValue {
    if (isTruthy(compareOp('>', format, 2n))) throw pyError('NotImplementedError');
    return evaluateAnnotations(this.annotations());
  }
}

let annotateDef: FunctionDef | undefined;

/** The definition every `__annotate__` shares, whose parameters bind the call's arguments as CPython's do. */
function annotateDefinition(): FunctionDef {
  if (!annotateDef) {
    const [statement] = parseDynamicCode('def __annotate__(format, /):\n    pass\n').body;
    annotateDef = (statement as Extract<Statement, { kind: 'functionDef' }>).fn;
  }
  return annotateDef;
}

/** Creates the `__annotate__` of a function, class, or module, which evaluates `annotations` for formats 1 and 2. */
export function newAnnotate(
  ownerName: string | undefined,
  globals: Map<string, PyValue>,
  annotations: () => readonly Annotation[],
  closure = new Map<string, PyCell>(),
  /** The `co_qualname`, which for a function's `__annotate__` names the scope the function is defined in. */
  codeName = ownerName === undefined ? '__annotate__' : `${ownerName}.__annotate__`
): PyValue {
  const annotate = new PyAnnotateFunction(codeName, globals, closure, annotations);
  annotate.qualifiedName = ownerName === undefined ? '__annotate__' : `${ownerName}.__annotate__`;
  annotate.doc = None;
  annotate.module = globals.get('__name__') ?? None;
  return annotate;
}

/**
 * The cells CPython's `__annotate__` closes over: the variables of enclosing functions its annotations name. A cell the
 * enclosing frame does not share holds the variable's value when the annotations were recorded.
 */
export function annotationClosure(annotations: readonly Annotation[]): Map<string, PyCell> {
  const closure = new Map<string, PyCell>();
  for (const { expression, frame } of annotations) {
    for (const { name, access } of nameReferences(expression)) {
      if (access === 'cell') closure.set(name, frame.cells.get(name) ?? new PyCell());
      else if (frame.kind === 'function' && access === 'local' && !closure.has(name)) {
        closure.set(name, new PyCell(frame.locals.get(name)));
      } else if (frame.kind === 'class' && access === 'classCell' && !frame.locals.has(name)) {
        const cell = frame.cells.get(name);
        if (cell) closure.set(name, cell);
      }
    }
  }
  return closure;
}

/** The values and cells that evaluating `annotations` reads from the enclosing frames, without keeping unused locals. */
// code-gauge-allow functionCognitiveComplexity 27 -- One case per way a name an annotation reads is bound in its frame.
export function annotationReferences(annotations: readonly Annotation[]): (PyValue | PyCell)[] {
  const refs: (PyValue | PyCell)[] = [];
  for (const { expression, frame, value } of annotations) {
    if (value !== undefined) refs.push(value);
    for (const { name, access } of nameReferences(expression)) {
      const ref =
        access === 'cell'
          ? frame.cells.get(name)
          : access === 'local' || access === 'name'
            ? frame.locals.get(name)
            : access === 'classCell'
              ? (frame.locals.get(name) ?? frame.cells.get(name))
              : access === 'global'
                ? frame.globals.get(name)
                : undefined;
      if (ref !== undefined) refs.push(ref);
    }
  }
  return refs;
}

function nameReferences(node: unknown, found: NameRef[] = []): NameRef[] {
  if (Array.isArray(node)) {
    for (const item of node) nameReferences(item, found);
  } else if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>;
    if (record.kind === 'name' && typeof record.name === 'string' && typeof record.access === 'string') {
      found.push(node as NameRef);
    }
    for (const value of Object.values(record)) nameReferences(value, found);
  }
  return found;
}

/** The globals an `__annotate__` evaluates names in, which annotationlib reads as its `__globals__`. */
export function annotateGlobals(annotate: PyValue): Map<string, PyValue> {
  if (annotate instanceof PyFunction) return annotate.globals;
  throw pyError('AttributeError', `'${typeName(annotate)}' object has no attribute '__globals__'`);
}

/** Adds an annotation a module or class body ran, once, keeping them in the order of the source. */
export function recordAnnotation(frame: Frame, annotation: Annotation): void {
  const { annotations } = frame;
  if (annotations.some((each) => each.expression === annotation.expression)) return;
  let index = annotations.length;
  while (index > 0 && annotations[index - 1].expression.row > annotation.expression.row) index--;
  annotations.splice(index, 0, annotation);
}

export function evaluateAnnotations(annotations: readonly Annotation[], fake?: FakeNames): PyDict {
  const runtime = currentRuntime();
  const dict = newDict();
  for (const { name, expression, frame, value: given } of annotations) {
    const value = given ?? runtime.evaluator.evaluate(expression, fake ? fakeFrame(frame, fake) : frame);
    dict.store.set(name, value);
  }
  return dict;
}

/**
 * Calls an `__annotate__` with the format VALUE_WITH_FAKE_GLOBALS in the namespace `fake` describes, as annotationlib
 * does by rebuilding the function from its code object with other globals and closure cells.
 */
export function callAnnotateWithFakeGlobals(annotate: PyValue, fake: FakeNames): PyValue {
  if (annotate instanceof PyAnnotateFunction) return evaluateAnnotations(annotate.annotations(), fake);
  if (!(annotate instanceof PyFunction)) {
    throw pyError('AttributeError', `'${typeName(annotate)}' object has no attribute '__code__'`);
  }
  const closure = new Map<string, PyCell>();
  for (const [name, cell] of annotate.closure) {
    const bound = fake.allowEvaluation && cell.value !== undefined;
    closure.set(name, bound ? cell : new PyCell(fake.stringifier(name)));
  }
  const fn = new PyFunction(
    annotate.cls,
    annotate.def,
    new FakeGlobals(fake.globals),
    closure,
    annotate.defaults,
    annotate.keywordDefaults,
    annotate.classCell
  );
  fn.module = annotate.module;
  return callValue(fn, [2n]);
}

/** The frame an annotation evaluates in for annotationlib: its names come from `fake`, as described there. */
function fakeFrame(frame: Frame, fake: FakeNames): Frame {
  const globals = new FakeGlobals(fake.globals);
  let locals: Map<string, PyValue> = globals;
  if (frame.kind === 'function') locals = new FakeLocals(frame.locals, fake);
  else if (frame.kind !== 'module') locals = fake.allowEvaluation ? frame.locals : new Map();
  const cells = new Map<string, PyCell>();
  for (const [name, cell] of frame.cells) {
    cells.set(name, fake.allowEvaluation && cell.value !== undefined ? cell : new PyCell(fake.stringifier(name)));
  }
  const inner = new Frame(frame.kind, locals, cells, globals, undefined, false, frame.scope, frame.fn, frame.classCell);
  if (!globals.has('__builtins__')) inner.builtins = frame.builtins;
  return inner;
}

/** Globals read through a mapping, whose `__missing__` gives annotationlib's stand-ins for undefined names. */
class FakeGlobals extends Map<string, PyValue> {
  constructor(private readonly mapping: PyValue) {
    super();
  }

  override get(name: string): PyValue | undefined {
    try {
      return getItem(this.mapping, name);
    } catch (error) {
      if (currentRuntime().isLookupError(error)) return undefined;
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
}

/** The variables of an enclosing function, which CPython's `__annotate__` reads as closure cells. */
class FakeLocals extends Map<string, PyValue> {
  constructor(
    private readonly real: Map<string, PyValue>,
    private readonly fake: FakeNames
  ) {
    super();
  }

  override get(name: string): PyValue | undefined {
    const value = this.fake.allowEvaluation ? this.real.get(name) : undefined;
    return value ?? this.fake.stringifier(name);
  }

  override has(): boolean {
    return true;
  }
}

// Functions -----------------------------------------------------------------------------------------------------------

/** What a function's `__annotate__` and `__annotations__` hold once read or assigned. */
interface FunctionAnnotationState {
  /** The `__annotate__`: the one the definition created, None, or one the program assigned. */
  annotate?: PyValue;
  annotations?: PyDict;
}

const functionStates = new WeakMap<PyFunction, FunctionAnnotationState>();

export function functionAnnotationReferences(fn: PyFunction): (PyValue | PyCell)[] {
  const state = functionStates.get(fn);
  if (!state || state.annotate === undefined) {
    return [
      ...(state?.annotations === undefined ? [] : [state.annotations]),
      ...annotationReferences(functionAnnotationList(fn)),
    ];
  }
  const refs: (PyValue | PyCell)[] = [];
  if (state.annotations !== undefined) refs.push(state.annotations);
  if (state.annotate !== undefined) refs.push(state.annotate);
  if (state.annotate instanceof PyAnnotateFunction) {
    refs.push(...annotationReferences(state.annotate.annotations()));
  }
  return refs;
}

function functionState(fn: PyFunction): FunctionAnnotationState {
  let state = functionStates.get(fn);
  if (!state) {
    state = {};
    functionStates.set(fn, state);
  }
  return state;
}

export function functionAnnotate(fn: PyFunction): PyValue {
  const state = functionState(fn);
  if (state.annotate === undefined) {
    const annotations = functionAnnotationList(fn);
    state.annotate =
      annotations.length === 0
        ? None
        : newAnnotate(
            fn.qualifiedName,
            fn.globals,
            () => annotations,
            annotationClosure(annotations),
            `${fn.def.qualifiedName.slice(0, fn.def.qualifiedName.lastIndexOf('.') + 1)}__annotate__`
          );
  }
  return state.annotate;
}

function functionAnnotationList(fn: PyFunction): Annotation[] {
  const frame = fn.annotationFrame as Frame | undefined;
  if (!frame) return [];
  const annotations: Annotation[] = [];
  for (const param of fn.def.params) {
    if (param.annotation) annotations.push({ name: param.name, expression: param.annotation, frame });
  }
  if (fn.def.returns) annotations.push({ name: 'return', expression: fn.def.returns, frame });
  return annotations;
}

export function functionAnnotations(fn: PyFunction): PyDict {
  const state = functionState(fn);
  state.annotations ??= callAnnotate(functionAnnotate(fn));
  return state.annotations;
}

/** Assigns or deletes (`value` undefined) a function's `__annotations__` or `__annotate__`. */
export function setFunctionAnnotationAttribute(fn: PyFunction, name: string, value: PyValue | undefined): void {
  const state = functionState(fn);
  const droppedValues = (): (PyValue | undefined)[] =>
    functionAnnotationReferences(fn).map((ref) => (ref instanceof PyCell ? ref.value : ref));
  if (name === '__annotations__') {
    if (value !== undefined && value !== None && !(value instanceof PyDict)) {
      throw typeError('__annotations__ must be set to a dict object');
    }
    const dropped = droppedValues();
    state.annotations = value instanceof PyDict ? value : undefined;
    state.annotate = None;
    fn.annotationFrame = undefined;
    currentRuntime().finalizer.release(dropped, [value]);
    return;
  }
  if (value === undefined) throw typeError('__annotate__ cannot be deleted');
  if (value !== None && !isCallable(value)) throw typeError('__annotate__ must be callable or None');
  const dropped = droppedValues();
  state.annotate = value;
  if (value !== None) state.annotations = undefined;
  fn.annotationFrame = undefined;
  currentRuntime().finalizer.release(dropped, [value]);
}

/** Calls `__annotate__(1)` as reading `__annotations__` does, or gives `{}` when it is None. */
function callAnnotate(annotate: PyValue): PyDict {
  if (annotate === None) return newDict();
  const result = callValue(annotate, [1n]);
  if (!(result instanceof PyDict)) throw typeError(`__annotate__ returned non-dict of type '${typeName(result)}'`);
  return result;
}

// Classes -------------------------------------------------------------------------------------------------------------

/**
 * The classes every run shares that CPython writes in Python without annotations, such as `abc.ABCMeta` and the
 * numbers ABCs, whose `__annotate__` is None and whose `__annotations__` an empty dict, which each run keeps its own of.
 */
export const sharedPythonClasses = new WeakSet<PyClass>();

/**
 * The staticmethods and classmethods a class body's `__new__`, `__init_subclass__`, and `__class_getitem__` became,
 * which CPython creates without copying the function's attributes, so that they have no `__name__` or `__wrapped__`.
 */
export const implicitlyWrapped = new WeakSet<object>();
const sharedAnnotations = new WeakMap<object, Map<PyClass, PyDict>>();

function sharedClassAnnotations(cls: PyClass): PyDict {
  const runtime = currentRuntime();
  let byClass = sharedAnnotations.get(runtime);
  if (!byClass) {
    byClass = new Map();
    sharedAnnotations.set(runtime, byClass);
  }
  let annotations = byClass.get(cls);
  if (!annotations) {
    annotations = newDict();
    byClass.set(cls, annotations);
  }
  return annotations;
}

/** The annotations of each class body, which its `__annotate__` evaluates. */
export const classAnnotationLists = new WeakMap<PyClass, readonly Annotation[]>();

/** `type.__annotate__`, which a class without annotations of its own records as None. */
export function classAnnotate(cls: PyClass): PyValue {
  if (sharedPythonClasses.has(cls)) return None;
  if (cls.isBuiltin) throw pyError('AttributeError', `type object '${cls.name}' has no attribute '__annotate__'`);
  const own = cls.dict.get('__annotate__') ?? cls.dict.get('__annotate_func__');
  if (own !== undefined) return own;
  cls.dict.set('__annotate_func__', None);
  return None;
}

/** `type.__annotations__`: the class's own annotations, cached in its dict on the first read. */
export function classAnnotations(cls: PyClass): PyValue {
  if (sharedPythonClasses.has(cls)) return sharedClassAnnotations(cls);
  if (cls.isBuiltin) throw pyError('AttributeError', `type object '${cls.name}' has no attribute '__annotations__'`);
  const own = cls.dict.get('__annotations__') ?? cls.dict.get('__annotations_cache__');
  if (own !== undefined) return own;
  const annotations = callAnnotate(classAnnotate(cls));
  cls.dict.set('__annotations_cache__', annotations);
  return annotations;
}

export function setClassAnnotate(cls: PyClass, value: PyValue): void {
  if (value !== None && !isCallable(value)) throw typeError('__annotate__ must be callable or None');
  const dropped = [
    cls.dict.get('__annotate_func__'),
    value !== None ? cls.dict.get('__annotations_cache__') : undefined,
  ];
  cls.dict.set('__annotate_func__', value);
  if (value !== None) cls.dict.delete('__annotations_cache__');
  currentRuntime().finalizer.release(dropped, [value]);
}

export function setClassAnnotations(cls: PyClass, value: PyValue | undefined): void {
  const dropped = [
    cls.dict.get('__annotations__'),
    cls.dict.get('__annotations_cache__'),
    cls.dict.get('__annotate_func__'),
  ];
  if (value === undefined) {
    if (!cls.dict.delete('__annotations__') && !cls.dict.delete('__annotations_cache__')) {
      throw pyError('AttributeError', '__annotations__');
    }
  } else {
    cls.dict.set('__annotations__', value);
    cls.dict.delete('__annotations_cache__');
  }
  cls.dict.set('__annotate_func__', None);
  currentRuntime().finalizer.release(dropped, [value]);
}

// Modules -------------------------------------------------------------------------------------------------------------

/** `module.__annotations__`: computed from the module's `__annotate__` and cached in its dict on the first read. */
export function moduleAnnotations(module: PyModule): PyValue {
  const own = module.dict.get('__annotations__');
  if (own !== undefined) return own;
  const annotate = module.dict.get('__annotate__');
  const annotations = annotate === undefined || annotate === None ? newDict() : callAnnotate(annotate);
  module.dict.set('__annotations__', annotations);
  return annotations;
}
