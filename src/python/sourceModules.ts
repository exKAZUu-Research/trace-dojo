import type { Module } from './ast';
import { allocateInstance, fieldsOf, makeCType } from './cTypes';
import { builtin } from './define';
import { Frame } from './frame';
import { registerModule } from './modules';
import { checkNamespaceView } from './namespaceDifferences';
import { parsePython } from './parse';
import type { Runtime } from './runtime';
import { markAllSuspending } from './suspension';
import { None } from './types';
import { UnsupportedFeatureError } from './unsupported';
import type { PyClass, PyValue } from './values';

/**
 * Registers a standard library module written in Python, as CPython writes it, so that its functions and classes
 * behave as CPython's do (reprs, argument errors). Its code runs in its own namespace when first imported; `natives`
 * adds the private helpers that code calls, which CPython writes in C or with `re`.
 *
 * The code must use only what this interpreter supports, and its frames stay out of the trace (see `Runtime.pushFrame`).
 */
export function registerSourceModule(
  name: string,
  source: string,
  natives: (runtime: Runtime) => Map<string, PyValue> = () => new Map(),
  { blocks = false, unsupported = {} }: SourceModuleOptions = {}
): void {
  registerModule(
    name,
    (runtime, namespace) => {
      for (const [key, value] of natives(runtime)) namespace.set(key, value);
      runModuleSource(runtime, namespace, source, blocks);
      return new Map();
    },
    unsupported,
    true
  );
}

const parsedSources = new Map<string, Module>();

/**
 * Runs the Python part of a standard library module in its namespace, which the native part may fill first, with the
 * private helpers every such module may call. Its frames stay out of the trace.
 */
export function runModuleSource(
  runtime: Runtime,
  namespace: Map<string, PyValue>,
  source: string,
  blocks = false
): void {
  let parsed = parsedSources.get(source);
  if (!parsed) {
    const { budget } = runtime;
    parsed = runtime.withoutCharge(() => budget.excludingTime(() => parseSourceModule(source, blocks)));
    parsedSources.set(source, parsed);
  }
  // Only the helpers the code uses, so that a module's namespace lists no others.
  for (const [key, value] of commonNatives(runtime)) {
    if (!namespace.has(key) && new RegExp(String.raw`\b${key}\b`).test(source)) namespace.set(key, value);
  }
  if (!namespace.has('__doc__')) namespace.set('__doc__', parsed.doc ?? None);
  runtime.addLibraryNamespace(namespace);
  const frame = new Frame('module', namespace, new Map(), namespace, undefined, false, parsed.scope);
  runtime.pushFrame(frame);
  try {
    runtime.evaluator.runModule(parsed.body, frame);
  } finally {
    runtime.popFrame();
  }
}

interface SourceModuleOptions {
  /** Whether every call may suspend the thread running it, as the blocking operations of threads need. */
  blocks?: boolean;
  /** The attributes this grader does not support, with the feature to name in the error. */
  unsupported?: Record<string, string>;
}

function parseSourceModule(source: string, blocks: boolean): Module {
  const parsed = parsePython(source, undefined, true);
  if (blocks) markAllSuspending(parsed.body);
  return parsed;
}

/** The private helpers every module written in Python may call. */
function commonNatives(runtime: Runtime): [string, PyValue][] {
  return [
    [
      '_unsupported',
      builtin('_unsupported', 'one', 1, 1, ([feature]) => {
        throw new UnsupportedFeatureError(feature as string);
      }),
    ],
    [
      '_c_type_name',
      // Gives a class the name its messages quote, as CPython's C types name themselves after their module.
      builtin('_c_type_name', 'expected', 2, 2, ([cls, name]) => {
        (cls as PyClass).typeName = name as string;
        return None;
      }),
    ],
    [
      '_c_type',
      // Makes a class the C type CPython's is (see makeCType); its objects keep their fields by _get_slot and _put_slot.
      builtin('_c_type', 'expected', 1, 2, ([cls, subclassable]) => {
        makeCType(cls as PyClass, subclassable !== false);
        return None;
      }),
    ],
    ['_allocate', builtin('_allocate', 'one', 1, 1, ([cls]) => allocateInstance(cls as PyClass))],
    ['_get_slot', builtin('_get_slot', 'expected', 2, 2, ([self, index]) => fieldsOf(self)[Number(index)] ?? None)],
    [
      '_put_slot',
      builtin('_put_slot', 'expected', 3, 3, ([self, index, value]) => {
        fieldsOf(self)[Number(index)] = value;
        return None;
      }),
    ],
    [
      '_check_namespace',
      // Refuses inspect.getmembers() and pydoc of an object whose namespace differs from CPython's.
      builtin('_check_namespace', 'expected', 2, 2, ([value, listing]) => {
        checkNamespaceView(value as PyValue, listing as string, true);
        return None;
      }),
    ],
    ['_standard_stderr', builtin('_standard_stderr', 'none', 0, 0, () => runtime.standardStream('stderr'))],
    [
      '_handled_exception',
      builtin('_handled_exception', 'none', 0, 0, () => runtime.evaluator.handledException ?? None),
    ],
  ];
}
