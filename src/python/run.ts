import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { Module } from './ast';
import { describeException } from './describe';
import { parsePython } from './parse';
import { Frame, isHostStackOverflow, Runtime } from './runtime';
import { withRuntime } from './runtimeContext';
import { None } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyError, type PyValue } from './values';

import './library';

// code-gauge-allow duplicateLines 15 -- Each language's runner wraps its own parser and runtime.
export function executePythonProgram(source: string): ProgramExecution {
  let module: Module;
  try {
    module = parsePython(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    const { output: _output, ...run } = runModule(new Runtime(), module);
    return { kind: 'executed', ...run };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/** The output of a run along with how it ended, which tests compare with CPython's. */
export interface PythonRun extends ProgramRun {
  output: string;
}

/**
 * Runs a module to its end or to an exception that escapes it.
 *
 * @param onEnd Called when the module ends, while its frame still holds its variables.
 */
// code-gauge-allow duplicateLines 20 -- Each language's runner wraps its own parser and runtime.
export function runModule(runtime: Runtime, module: Module, onEnd?: (frame: Frame) => void): PythonRun {
  return withRuntime(runtime, () => {
    const globals = new Map<string, PyValue>([
      ['__name__', '__main__'],
      ['__doc__', module.doc ?? None],
      ['__package__', None],
      ['__spec__', None],
    ]);
    const frame = new Frame('module', globals, new Map(), globals, undefined, false, module.scope);
    runtime.pushFrame(frame);
    try {
      let uncaughtException: string | undefined;
      try {
        runtime.evaluator.runModule(module.body, frame);
      } catch (error) {
        uncaughtException = describeUncaught(error);
      }
      onEnd?.(frame);
      runtime.collectGarbage();
      return {
        finalBoard: runtime.world.boardText(),
        finalTurtles: runtime.world.turtleTraces(),
        uncaughtException,
        output: runtime.budget.output,
      };
    } finally {
      runtime.popFrame();
    }
  });
}

function describeUncaught(error: unknown): string | undefined {
  if (error instanceof UnsupportedFeatureError) return error.message;
  if (isHostStackOverflow(error)) return 'RecursionError: maximum recursion depth exceeded';
  if (!(error instanceof PyError)) throw error;
  if (error.exception.cls.name === 'SystemExit' && error.exception.cls.isBuiltin) return undefined;
  return describeException(error.exception);
}
