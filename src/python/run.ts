import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { Module } from './ast';
import { describeException } from './describe';
import { recordFutureFeatures } from './dynamicCode';
import { SAFE_NESTING_DEPTH } from './hostStack';
import { runExitCallbacks } from './modules/atexit';
import { callValue, isExceptionOf } from './objects';
import { parsePython } from './parse';
import { programSourceOf } from './programSource';
import { Frame, hostRefusal, Runtime } from './runtime';
import { withRuntime } from './runtimeContext';
import { DeadlockError, WaitRequest } from './threads';
import { None } from './types';
import { unavailableValue } from './unavailableValues';
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
// code-gauge-allow duplicateLines 22 -- Each language's runner wraps its own parser and runtime.
export function runModule(runtime: Runtime, module: Module, onEnd?: (frame: Frame) => void): ProgramRun {
  return withRuntime(runtime, () => {
    const globals = mainGlobals(runtime, module);
    runtime.mainGlobals = globals;
    recordFutureFeatures(globals, module.futureFeatures);
    if (module.source !== undefined) runtime.program = programSourceOf(module, module.source);
    runtime.deepNesting = (module.nestingDepth ?? 0) > SAFE_NESTING_DEPTH;
    const frame = new Frame('module', globals, new Map(), globals, undefined, false, module.scope);
    runtime.pushFrame(frame);
    try {
      let uncaughtException: string | undefined;
      try {
        runtime.evaluator.runModule(module.body, frame);
      } catch (error) {
        uncaughtException = describeUncaught(error, runtime);
        if (error instanceof DeadlockError) runtime.threads = undefined;
      }
      // CPython waits for the threads that are no daemons before it shuts down, and runs the atexit functions after them.
      uncaughtException = joinThreads(runtime) ?? uncaughtException;
      try {
        runExitCallbacks(runtime);
      } catch (error) {
        uncaughtException ??= describeUncaught(error, runtime);
      }
      // CPython closes the generators still suspended when it shuts down, after reporting an uncaught exception.
      try {
        runtime.finalizer.closeAll(globals);
      } catch (error) {
        uncaughtException ??= describeUncaught(error, runtime);
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

/** Waits for the threads that are no daemons to end, returning how the program stopped if they could not. */
function joinThreads(runtime: Runtime): string | undefined {
  const scheduler = runtime.threads;
  if (!scheduler) return undefined;
  try {
    // The functions `threading._register_atexit` registers, which tell a pool's workers to end, run first.
    const shutdown = runtime.modules.get('threading')?.dict.get('_shutdown');
    if (shutdown) callValue(shutdown, []);
    scheduler.waitFor(
      new WaitRequest(() => scheduler.alive.every((thread) => thread.daemon || thread === scheduler.main))
    );
    return undefined;
  } catch (error) {
    return describeUncaught(error, runtime);
  }
}

/** The variables CPython gives the `__main__` module of a script, in its order. */
function mainGlobals(runtime: Runtime, module: Module): Map<string, PyValue> {
  return new Map<string, PyValue>([
    ['__name__', '__main__'],
    ['__doc__', module.doc ?? None],
    ['__package__', None],
    ['__loader__', unavailableValue('__loader__（スクリプトを読み込んだローダー）')],
    ['__spec__', None],
    ['__builtins__', runtime.importModule('builtins')],
    ['__file__', unavailableValue('__file__（スクリプトのファイルのパス）')],
    ['__cached__', None],
  ]);
}

function describeUncaught(error: unknown, runtime: Runtime): string | undefined {
  const raised = hostRefusal(error, runtime.deepNesting) ?? error;
  if (raised instanceof UnsupportedFeatureError || raised instanceof DeadlockError) return raised.message;
  if (!(raised instanceof PyError)) throw raised;
  if (isExceptionOf(raised, 'SystemExit')) return undefined;
  try {
    return describeException(raised.exception);
  } catch (describeError) {
    // An exception whose message this grader cannot reproduce stops the program when shown.
    if (describeError instanceof UnsupportedFeatureError) return describeError.message;
    throw describeError;
  }
}
