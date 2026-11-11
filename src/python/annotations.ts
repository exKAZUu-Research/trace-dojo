import { Frame } from './frame';
import { callValue, getItem, isCallable, isTruthy, setItem } from './objects';
import { compareOp } from './operators';
import { currentRuntime } from './runtimeContext';
import { builtinFunctionClass, newDict, None, pyError, typeError, typeName } from './types';
import {
  type Annotation,
  PyBuiltinFunction,
  PyCell,
  type PyClass,
  PyDict,
  PyFunction,
  type PyModule,
  type PyValue,
} from './values';

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

/** What each `__annotate__` that this interpreter creates, as CPython's compiler does, evaluates, and its globals. */
const annotateSources = new WeakMap<
  PyBuiltinFunction,
  { annotations: () => readonly Annotation[]; globals: Map<string, PyValue> }
>();

/** Creates the `__annotate__` of a function, class, or module, which evaluates `annotations` for formats 1 and 2. */
export function newAnnotate(
  ownerName: string | undefined,
  globals: Map<string, PyValue>,
  annotations: () => readonly Annotation[]
): PyValue {
  const annotate = new PyBuiltinFunction(
    builtinFunctionClass,
    '__annotate__',
    (args, kwargs) => {
      if ((kwargs?.size ?? 0) > 0) throw typeError('__annotate__() takes no keyword arguments');
      if (args.length !== 1) {
        throw typeError(`__annotate__() takes exactly one argument (${args.length} given)`);
      }
      // The compiler's `if format > VALUE_WITH_FAKE_GLOBALS: raise NotImplementedError`.
      if (isTruthy(compareOp('>', args[0], 2n))) throw pyError('NotImplementedError');
      return evaluateAnnotations(annotations());
    },
    undefined,
    'method',
    ownerName
  );
  annotateSources.set(annotate, { annotations, globals });
  return annotate;
}

/** The globals an `__annotate__` evaluates names in, which annotationlib reads as its `__globals__`. */
export function annotateGlobals(annotate: PyValue): Map<string, PyValue> {
  const source = annotate instanceof PyBuiltinFunction ? annotateSources.get(annotate) : undefined;
  if (source) return source.globals;
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
  runtime.allocate(dict.store.size + 1);
  return dict;
}

/**
 * Calls an `__annotate__` with the format VALUE_WITH_FAKE_GLOBALS in the namespace `fake` describes, as annotationlib
 * does by rebuilding the function from its code object with other globals and closure cells.
 */
export function callAnnotateWithFakeGlobals(annotate: PyValue, fake: FakeNames): PyValue {
  const source = annotate instanceof PyBuiltinFunction ? annotateSources.get(annotate) : undefined;
  if (source) return evaluateAnnotations(source.annotations(), fake);
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
  return new Frame(frame.kind, locals, cells, globals, undefined, false, frame.scope, frame.fn, frame.classCell);
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
    state.annotate = annotations.length === 0 ? None : newAnnotate(fn.qualifiedName, fn.globals, () => annotations);
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
  if (name === '__annotations__') {
    if (value !== undefined && value !== None && !(value instanceof PyDict)) {
      throw typeError('__annotations__ must be set to a dict object');
    }
    state.annotations = value instanceof PyDict ? value : undefined;
    state.annotate = None;
    return;
  }
  if (value === undefined) throw typeError('__annotate__ cannot be deleted');
  if (value !== None && !isCallable(value)) throw typeError('__annotate__ must be callable or None');
  state.annotate = value;
  if (value !== None) state.annotations = undefined;
}

/** Calls `__annotate__(1)` as reading `__annotations__` does, or gives `{}` when it is None. */
function callAnnotate(annotate: PyValue): PyDict {
  if (annotate === None) return newDict();
  const result = callValue(annotate, [1n]);
  if (!(result instanceof PyDict)) throw typeError(`__annotate__ returned non-dict of type '${typeName(result)}'`);
  return result;
}

// Classes -------------------------------------------------------------------------------------------------------------

/** The annotations of each class body, which its `__annotate__` evaluates. */
export const classAnnotationLists = new WeakMap<PyClass, readonly Annotation[]>();

/** `type.__annotate__`, which a class without annotations of its own records as None. */
export function classAnnotate(cls: PyClass): PyValue {
  if (cls.isBuiltin) throw pyError('AttributeError', `type object '${cls.name}' has no attribute '__annotate__'`);
  const own = cls.dict.get('__annotate__') ?? cls.dict.get('__annotate_func__');
  if (own !== undefined) return own;
  cls.dict.set('__annotate_func__', None);
  return None;
}

/** `type.__annotations__`: the class's own annotations, cached in its dict on the first read. */
export function classAnnotations(cls: PyClass): PyValue {
  if (cls.isBuiltin) throw pyError('AttributeError', `type object '${cls.name}' has no attribute '__annotations__'`);
  const own = cls.dict.get('__annotations__') ?? cls.dict.get('__annotations_cache__');
  if (own !== undefined) return own;
  const annotations = callAnnotate(classAnnotate(cls));
  cls.dict.set('__annotations_cache__', annotations);
  return annotations;
}

export function setClassAnnotate(cls: PyClass, value: PyValue): void {
  if (value !== None && !isCallable(value)) throw typeError('__annotate__ must be callable or None');
  cls.dict.set('__annotate_func__', value);
  if (value !== None) cls.dict.delete('__annotations_cache__');
}

export function setClassAnnotations(cls: PyClass, value: PyValue | undefined): void {
  if (value === undefined) {
    if (!cls.dict.delete('__annotations__') && !cls.dict.delete('__annotations_cache__')) {
      throw pyError('AttributeError', '__annotations__');
    }
  } else {
    cls.dict.set('__annotations__', value);
    cls.dict.delete('__annotations_cache__');
  }
  cls.dict.set('__annotate_func__', None);
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
