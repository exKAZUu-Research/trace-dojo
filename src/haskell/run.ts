import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { type CompiledProgram, compileProgram, setSpliceRunner } from './compile';
import type { GlobalDef } from './core';
import { ioSupport } from './ioPrimitives';
import { forceString } from './primitives';
import { Runtime, type TraceFrame } from './runtime';
import { HaskellException, type Slot, type Value } from './values';

// A splice runs as a program of its own while the program that has it compiles: its output, after a mark, spells
// its code, and what it prints before the mark and to its standard error is the compiler's output, as runIO's is in
// GHC. An error it reports with reportError, marked in its standard error, fails it, as a run without the mark does.
setSpliceRunner((program) => {
  const run = runProgram(new Runtime(), compileProgram(program));
  if (run.uncaughtException !== undefined) {
    throw new CompileError([{ row: 0, message: run.uncaughtException }]);
  }
  const reported = /\u0001([^\u0001]*)\u0001/.exec(run.stderr);
  if (reported) throw new CompileError([{ row: 0, message: reported[1] }]);
  const mark = run.stdout.lastIndexOf('\u0000');
  if (mark === -1) throw new CompileError([{ row: 0, message: 'Exception when trying to run compile-time code' }]);
  return { printed: run.stdout.slice(0, mark), printedError: run.stderr, code: run.stdout.slice(mark + 1) };
});

export function executeHaskellProgram(source: string, input?: ProgramInput): ProgramExecution {
  let compiled: CompiledProgram;
  try {
    compiled = compileProgram(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
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
 * The message an exception that escapes `main` reports, or `undefined` for an exit code, which ends the program
 * without one, as `exitWith` does.
 */
function uncaughtMessage(runtime: Runtime, error: HaskellException): string | undefined {
  if (error.cause?.kind !== 'value') return error.display;
  const apply = (support: GlobalDef | undefined): Value =>
    runtime.machine.apply(runtime.machine.force(runtime.global(support as GlobalDef)), [
      (error.cause as { value: Slot }).value,
    ]);
  try {
    if ((runtime.machine.force(apply(ioSupport.exitCode)) as bigint) >= 0n) return undefined;
    return forceString(apply(ioSupport.display), runtime);
  } catch (error_) {
    if (!(error_ instanceof HaskellException)) throw error_;
    return uncaughtMessage(runtime, error_);
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
  // What the program's splices printed while it compiled comes first, as GHC prints it before the program runs.
  if (program.compileOutput) runtime.io.stdout.write(program.compileOutput);
  if (program.compileErrorOutput) runtime.io.stderr.write(program.compileErrorOutput);
  try {
    runtime.machine.runIO(runtime.global(program.main));
  } catch (error) {
    if (!(error instanceof HaskellException)) throw error;
    uncaughtException = uncaughtMessage(runtime, error);
  }
  onEnd?.(runtime.frames[0]);
  runtime.collectGarbage();
  while (runtime.frames.length > 0) runtime.popFrame(runtime.frames.at(-1)!, false);
  return {
    finalBoard: runtime.world.boardText(),
    finalTurtles: runtime.world.turtleTraces(),
    uncaughtException,
    ...runtime.io.output(),
  };
}
