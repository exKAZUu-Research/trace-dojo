import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { Module } from './ast';
import { describeException } from './describe';
import { SAFE_NESTING_DEPTH } from './hostStack';
import { runExitCallbacks } from './modules/atexit';
import { builtinImporterClass } from './modules/sysInfo';
import { callValue, isExceptionOf } from './objects';
import { parsePython } from './parse';
import { programSourceOf } from './programSource';
import { Frame, hostRefusal, Runtime } from './runtime';
import { withRuntime } from './runtimeContext';
import { DeadlockError, WaitRequest } from './threads';
import { None } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyError, type PyValue } from './values';

import './library';

// code-gauge-allow duplicateLines 15 -- Each language's runner wraps its own parser and runtime.
export function executePythonProgram(source: string, input?: ProgramInput): ProgramExecution {
  let module: Module;
  try {
    module = parsePython(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runModule(new Runtime(input), module) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs a module to its end or to an exception that escapes it.
 *
 * @param onEnd Called when the module ends, while its frame still holds its variables.
 */
// code-gauge-allow duplicateLines 15 -- Each language's runner wraps its own runtime and collects the same output contract.
export function runModule(runtime: Runtime, module: Module, onEnd?: (frame: Frame) => void): ProgramRun {
  return withRuntime(runtime, () => {
    const globals = mainGlobals(runtime, module);
    runtime.mainGlobals = globals;
    if (module.source !== undefined) runtime.program = programSourceOf(module, module.source);
    runtime.deepNesting = (module.nestingDepth ?? 0) > SAFE_NESTING_DEPTH;
    const frame = new Frame('module', globals, new Map(), globals, undefined, false, module.scope);
    runtime.pushFrame(frame);
    try {
      let uncaughtException: string | undefined;
      try {
        uncaughtException = runPython(runtime, () => runtime.evaluator.runModule(module.body, frame));
        uncaughtException = runPython(runtime, () => joinThreads(runtime)) ?? uncaughtException;
        const exitError = runPython(runtime, () => runExitCallbacks(runtime));
        uncaughtException ??= exitError;
        const finalizerError = runPython(runtime, () => runtime.finalizer.closeAll(globals));
        uncaughtException ??= finalizerError;
      } catch (error) {
        if (!(error instanceof UnsupportedFeatureError || error instanceof DeadlockError)) throw error;
        uncaughtException = error.message;
      }
      onEnd?.(frame);
      runtime.collectGarbage();
      return {
        finalBoard: runtime.world.boardText(),
        finalTurtles: runtime.world.turtleTraces(),
        uncaughtException,
        ...runtime.io.output(),
      };
    } finally {
      runtime.popFrame();
    }
  });
}

function runPython(runtime: Runtime, run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    const raised = hostRefusal(error, runtime.deepNesting) ?? error;
    if (!(raised instanceof PyError)) throw raised;
    if (!isExceptionOf(raised, 'SystemExit')) return describeException(raised.exception);
  }
  return undefined;
}

/** Waits for non-daemon threads before shutdown, including thread-pool exit callbacks. */
function joinThreads(runtime: Runtime): void {
  const scheduler = runtime.threads;
  if (!scheduler) return;
  const shutdown = runtime.modules.get('threading')?.dict.get('_shutdown');
  if (shutdown) callValue(shutdown, []);
  scheduler.waitFor(
    new WaitRequest(() => scheduler.alive.every((thread) => thread.daemon || thread === scheduler.main))
  );
}

/** The variables CPython gives the `__main__` module of a program run with `python -c`, in its order. */
function mainGlobals(runtime: Runtime, module: Module): Map<string, PyValue> {
  return new Map<string, PyValue>([
    ['__name__', '__main__'],
    ['__doc__', module.doc ?? None],
    ['__package__', None],
    ['__loader__', builtinImporterClass],
    ['__spec__', None],
    ['__builtins__', runtime.importModule('builtins')],
  ]);
}
