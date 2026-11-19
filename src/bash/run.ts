import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { Program } from './ast';
import { parseBash } from './parse';
import { type Frame, Runtime } from './runtime';
import { Shell } from './shell';
import { TurtleError } from './turtle';
import { UnsupportedFeatureError } from './unsupported';

// code-gauge-allow duplicateLines 15 -- The interpreter entry points mirror the other languages so callers use one contract.
export function executeBashProgram(source: string, input?: ProgramInput): ProgramExecution {
  let program: Program;
  try {
    program = parseBash(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Shell(new Runtime(input)), program) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs a program to its end, or to an error that stops it: a turtle's error, or a feature this environment lacks.
 *
 * @param onEnd Called when the program ends, with the top level's frame, while the shell still holds its variables.
 */
export function runProgram(shell: Shell, program: Program, onEnd?: (frame: Frame) => void): ProgramRun {
  const { runtime } = shell;
  let uncaughtException: string | undefined;
  try {
    shell.runProgram(program);
  } catch (error) {
    if (error instanceof TurtleError) uncaughtException = error.report;
    else if (error instanceof UnsupportedFeatureError) uncaughtException = error.message;
    else if (isHostStackOverflow(error)) throw new ExecutionLimitError('operations');
    else throw error;
  }
  onEnd?.(runtime.frames[0]);
  runtime.collectGarbage();
  return {
    finalBoard: runtime.world.boardText(),
    finalTurtles: runtime.world.turtleTraces(),
    uncaughtException,
    ...runtime.io.output(),
  };
}

/** Whether the host ran out of stack, which deeply nested expansions can exhaust before the call depth limit. */
function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}
