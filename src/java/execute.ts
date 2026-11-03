import type { TurtleTrace } from '../problems/trace';
import { type CompiledProgram, compileProgram } from './compiler';
import { CompileError, type JavaSourceDiagnostic } from './diagnostics';
import { parseJava } from './parse';
import { ExecutionLimitError, Frame, JavaThrow, Runtime } from './runtime';
import { JavaArray } from './values';

export type JavaExecution =
  | { kind: 'compileError'; diagnostics: JavaSourceDiagnostic[] }
  | { kind: 'limitExceeded'; limit: ExecutionLimitError['limit'] }
  | ({ kind: 'executed' } & ProgramRun);

export interface ProgramRun {
  finalBoard: string;
  /** The turtles that `main`'s variables and static fields still reach when it returns. */
  finalTurtles: TurtleTrace[];
  /** The `toString()` of the exception that ended the program, if one escaped `main`. */
  uncaughtException: string | undefined;
}

/** Compiles and runs a learner's program, reporting how it ended. */
export function executeJavaProgram(source: string): JavaExecution {
  let compiled: CompiledProgram;
  try {
    compiled = compileProgram(parseJava(source));
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(compiled.builtins), compiled) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs `main`.
 *
 * @param onMainExit Called when `main` returns or throws, while its frame still holds its locals.
 */
export function runProgram(
  runtime: Runtime,
  program: CompiledProgram,
  onMainExit?: (frame: Frame) => void
): ProgramRun {
  let finalTurtles: TurtleTrace[] = [];
  runtime.onExit = (frame) => {
    if (frame.method !== program.mainMethod || runtime.frames.length !== 1) return;
    onMainExit?.(frame);
    // Collecting while main's frame still exists keeps the turtles its variables hold.
    runtime.collectGarbage();
    finalTurtles = turtlesOf(runtime);
  };
  const uncaughtException = runMain(runtime, program);
  return { finalBoard: boardText(runtime), finalTurtles, uncaughtException };
}

function runMain(runtime: Runtime, program: CompiledProgram): string | undefined {
  const root = new Frame(runtime, undefined, [], undefined, undefined);
  try {
    runtime.initializeClass(root, program.entryClass);
    const args = new JavaArray(program.builtins.stringClass.type, []);
    runtime.invoke(root, program.mainMethod, undefined, [args], undefined);
    return undefined;
  } catch (error) {
    if (!(error instanceof JavaThrow)) throw error;
    return runtime.invokeToString(root, error.value)?.value ?? error.value.cls.name;
  }
}

export function boardText(runtime: Runtime): string {
  return runtime.world.board.map((row) => row.join('')).join('\n');
}

export function turtlesOf(runtime: Runtime): TurtleTrace[] {
  return runtime.turtleStates().map(({ color, dir, x, y }) => ({ x, y, color, dir }));
}
