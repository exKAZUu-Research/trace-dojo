import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { type CompiledProgram, compileProgram } from './compile';
import { Runtime, type TraceFrame } from './runtime';
import { HaskellException } from './values';

// code-gauge-allow duplicateLines 15 -- The interpreter entry points mirror the other languages so callers use one contract.
export function executeHaskellProgram(source: string, input?: ProgramInput): ProgramExecution {
  let compiled: CompiledProgram;
  try {
    compiled = compileProgram(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(input), compiled) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs a program's `main` to its end or to an exception that escapes it.
 *
 * @param onEnd Called when the program ends, with the entry point's frame while it still shows its variables.
 */
export function runProgram(
  runtime: Runtime,
  program: CompiledProgram,
  onEnd?: (frame: TraceFrame | undefined) => void
): ProgramRun {
  let uncaughtException: string | undefined;
  try {
    runtime.machine.runIO(runtime.global(program.main));
  } catch (error) {
    if (!(error instanceof HaskellException)) throw error;
    uncaughtException = error.display;
  }
  onEnd?.(runtime.frames[0]);
  runtime.collectGarbage();
  runtime.frames.length = 0;
  return {
    finalBoard: runtime.world.boardText(),
    finalTurtles: runtime.world.turtleTraces(),
    uncaughtException,
    ...runtime.io.output(),
  };
}
