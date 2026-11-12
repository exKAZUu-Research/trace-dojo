import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { Module } from './ast';
import { describeException } from './describe';
import { isExceptionOf } from './objects';
import { parsePython } from './parse';
import { Frame, hostRefusal, Runtime } from './runtime';
import { withRuntime } from './runtimeContext';
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
// code-gauge-allow duplicateLines 22 -- Each language's runner wraps its own parser and runtime.
export function runModule(runtime: Runtime, module: Module, onEnd?: (frame: Frame) => void): ProgramRun {
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
        ...runtime.io.output(),
      };
    } finally {
      runtime.popFrame();
    }
  });
}

function describeUncaught(error: unknown): string | undefined {
  if (error instanceof UnsupportedFeatureError) return error.message;
  const raised = hostRefusal(error) ?? error;
  if (!(raised instanceof PyError)) throw raised;
  if (isExceptionOf(raised, 'SystemExit')) return undefined;
  return describeException(raised.exception);
}
