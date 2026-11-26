import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { type CompiledProgram, compileProgram, setSpliceExecutor } from './compile';
import type { GlobalDef } from './core';
import { compileError } from './errors';
import { ioSupport } from './ioPrimitives';
import { forceString } from './primitives';
import { Runtime, type TraceFrame } from './runtime';
import { decodeSplice } from './thDecode';
import { compilationBudget } from './typeWorkBudget';
import { type ConValue, HaskellException, type Slot, type Value } from './values';

// A splice's code runs while the program that has it compiles, on the compilation's own budget: it stores its tree,
// which the compiler grafts in its place, and what it prints is the compiler's output, as runIO's is in GHC. An error
// it reports with reportError fails it, as does an exit or an end without a stored tree.
setSpliceExecutor((program, span, names) => {
  const budget = compilationBudget();
  const runtime = new Runtime(undefined, budget);
  const run = budget.withinMilliseconds(LIMITS.maxMilliseconds, () => runProgram(runtime, program));
  const failure =
    run.uncaughtException ??
    runtime.splice.errors[0] ??
    runtime.splice.exit ??
    (runtime.splice.result ? undefined : 'Exception when trying to run compile-time code');
  if (failure !== undefined) throw compileError(span, failure);
  return {
    result: decodeSplice(runtime, runtime.splice.result as Slot, span, names),
    printed: run.stdout,
    printedError: run.stderr,
  };
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
    if ((runtime.machine.force(apply(ioSupport.isExit)) as ConValue).con.name === 'True') return undefined;
    return forceString(apply(ioSupport.display), runtime);
  } catch (error_) {
    if (!(error_ instanceof HaskellException)) throw error_;
    return uncaughtMessage(runtime, error_);
  }
}

/** @param onEnd Called when the program ends, with the entry point's frame while it still shows its variables. */
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
