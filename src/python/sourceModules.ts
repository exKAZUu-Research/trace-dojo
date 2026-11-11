import type { Module } from './ast';
import { builtin } from './define';
import { Frame } from './frame';
import { registerModule } from './modules';
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
  let parsed: Module | undefined;
  registerModule(
    name,
    (runtime, namespace) => {
      parsed ??= parseSourceModule(source, blocks);
      namespace.set('__doc__', None);
      for (const [key, value] of [...commonNatives(runtime), ...natives(runtime)]) namespace.set(key, value);
      runtime.addLibraryNamespace(namespace);
      const frame = new Frame('module', namespace, new Map(), namespace, undefined, false, parsed.scope);
      runtime.pushFrame(frame);
      try {
        runtime.evaluator.runModule(parsed.body, frame);
      } finally {
        runtime.popFrame();
      }
      return new Map();
    },
    unsupported
  );
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
    ['_standard_stderr', builtin('_standard_stderr', 'none', 0, 0, () => runtime.standardStream('stderr'))],
    [
      '_handled_exception',
      builtin('_handled_exception', 'none', 0, 0, () => runtime.evaluator.handledException ?? None),
    ],
  ];
}
