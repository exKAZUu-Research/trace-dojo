import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { Program } from './ast';
import { bootstrap } from './bootstrap';
import { describeException } from './describe';
import { evalBody, runToEnd, STACK_OVERFLOW } from './interp';
import { makeData, runAtExit } from './libEncoding';
import { parseRuby } from './parse';
import {
  BreakSignal,
  ExitSignal,
  Frame,
  NextSignal,
  RetrySignal,
  ReturnSignal,
  RubyError,
  Runtime,
  Scope,
  ThrowSignal,
  UnsupportedFeatureError,
  withRuntime,
} from './runtime';
import { isA } from './values';

import './library';

// code-gauge-allow duplicateLines 15 -- The interpreter entry points mirror the other languages so callers use one contract.
export function executeRubyProgram(source: string, input?: ProgramInput): ProgramExecution {
  let program: Program;
  try {
    program = parseRuby(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(input), program) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs a program to its end or to an exception that escapes it.
 *
 * @param onEnd Called when the program ends, while its frame still holds its variables.
 */
// code-gauge-allow duplicateLines 23 -- The interpreter entry points mirror the other languages so callers use one contract.
export function runProgram(runtime: Runtime, program: Program, onEnd?: (frame: Frame) => void): ProgramRun {
  return withRuntime(runtime, () => {
    bootstrap(runtime);
    const frame = new Frame('main', runtime.mainObject, new Scope(), [runtime.c.Object], undefined, false, false, {});
    frame.defaultVisibility = 'private';
    runtime.pushFrame(frame);
    try {
      let mainError: unknown;
      if (program.data !== undefined)
        runtime.c.Object.constants.set('DATA', makeData(program.data, program.dataFile ?? program.data));
      try {
        runToEnd(evalBody(program.body, frame));
      } catch (error) {
        if (error instanceof RubyError) runtime.globals.set('$!', error.exception);
        mainError = error;
      }
      let hookErrors: (RubyError | ExitSignal | UnsupportedFeatureError)[] = [];
      try {
        hookErrors = runToEnd(runAtExit());
      } catch (error) {
        if (error instanceof RubyError || error instanceof ExitSignal || error instanceof UnsupportedFeatureError)
          hookErrors.push(error);
        else throw error;
      }
      const messages = (mainError === undefined ? hookErrors : [...hookErrors, mainError])
        .map((error) => describeUncaught(runtime, error, frame))
        .filter(Boolean);
      const uncaughtException = messages.length > 0 ? messages.join('\n') : undefined;
      onEnd?.(frame);
      runtime.collectGarbage();
      return {
        finalBoard: runtime.world.boardText(),
        finalTurtles: runtime.world.turtleTraces(),
        uncaughtException,
        ...runtime.io.output(),
      };
    } finally {
      frame.extra.finished = true;
      runtime.popFrame();
    }
  });
}

function describeUncaught(runtime: Runtime, error: unknown, frame: Frame): string | undefined {
  if (error instanceof UnsupportedFeatureError) return error.message;
  if (error === STACK_OVERFLOW) return 'stack level too deep (SystemStackError)';
  if (error instanceof ExitSignal) return undefined;
  if (error instanceof ReturnSignal && error.target === frame) return undefined;
  if (error instanceof RubyError) {
    if (isA(error.exception, runtime.c.SystemExit)) return undefined;
    return describeException(error.exception);
  }
  if (error instanceof ThrowSignal || error instanceof BreakSignal || error instanceof NextSignal) {
    throw new TypeError('A control signal escaped the program');
  }
  if (error instanceof RetrySignal) throw new Error('A retry escaped its rescue clause');
  throw error;
}
