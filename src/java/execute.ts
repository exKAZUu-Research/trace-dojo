import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import { type CompiledProgram, compileProgram } from './compiler';
import { parseJava } from './parse';
import { Frame, JavaThrow, ProgramExit, Runtime } from './runtime';
import { JavaArray } from './values';

export function executeJavaProgram(source: string): ProgramExecution {
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
  let finalTurtles: ProgramRun['finalTurtles'] = [];
  runtime.onExit = (frame) => {
    if (frame.method !== program.mainMethod || runtime.frames.length !== 1) return;
    onMainExit?.(frame);
    // Collecting while main's frame still exists keeps the turtles its variables hold.
    runtime.collectGarbage();
    finalTurtles = runtime.world.turtleTraces();
  };
  const uncaughtException = runMain(runtime, program);
  return { finalBoard: runtime.world.boardText(), finalTurtles, uncaughtException };
}

function runMain(runtime: Runtime, program: CompiledProgram): string | undefined {
  const root = new Frame(runtime, undefined, [], undefined, undefined);
  try {
    runtime.initializeClass(root, program.entryClass);
    const { mainMethod, entryConstructor } = program;
    const receiver = entryConstructor ? runtime.allocateObject(root, program.entryClass) : undefined;
    if (entryConstructor) runtime.invoke(root, entryConstructor, receiver, [], undefined);
    const args = mainMethod.parameterTypes.length === 0 ? [] : [new JavaArray(program.builtins.stringClass.type, [])];
    runtime.invoke(root, mainMethod, receiver, args, undefined);
    return undefined;
  } catch (error) {
    return describeUncaught(runtime, root, error);
  }
}

function describeUncaught(runtime: Runtime, root: Frame, error: unknown): string | undefined {
  if (error instanceof ProgramExit) return undefined;
  if (isHostStackOverflow(error)) return 'java.lang.StackOverflowError';
  if (!(error instanceof JavaThrow)) throw error;
  try {
    return runtime.invokeToString(root, error.value)?.value ?? error.value.cls.name;
  } catch (formattingError) {
    // A learner's toString() may itself fail, which leaves only the class to describe the exception.
    if (formattingError instanceof JavaThrow || isHostStackOverflow(formattingError)) return error.value.cls.name;
    throw formattingError;
  }
}

/** The host's stack can run out before the Java call depth limit when each call nests many statements. */
function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}
