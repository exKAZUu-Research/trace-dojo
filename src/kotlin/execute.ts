import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { CompiledProgram } from './compiler';
import { stringOf } from './format';
import { compileKotlin, libraryExceptions } from './library';
import { libraryClass } from './natives/registry';
import { parseKotlin } from './parse';
import { Frame, type FunctionInfo, KotlinThrow, ProgramExit, Runtime } from './runtime';
import { KObject, type Value } from './values';

export function executeKotlinProgram(source: string, input?: ProgramInput): ProgramExecution {
  let compiled: CompiledProgram;
  try {
    compiled = compileKotlin(parseKotlin(source));
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(libraryExceptions(), input), compiled) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

const ROOT_INFO: FunctionInfo = {
  name: '<root>',
  locals: [],
  captures: [],
  slotCount: 0,
  isAtomic: false,
  isLibrary: true,
  isLambda: false,
  showsThis: false,
};

/**
 * Initializes the top-level properties and runs `main` to its end or to the exception that ends the program.
 *
 * @param onMainExit Receives `main`'s frame when it returns or throws, while the frame still holds its variables.
 */
export function runProgram(
  runtime: Runtime,
  program: CompiledProgram,
  onMainExit?: (frame: Frame) => void
): ProgramRun {
  let finalTurtles: ProgramRun['finalTurtles'] = [];
  const root = new Frame(runtime, ROOT_INFO, [], undefined, undefined);
  runtime.globals = Array.from({ length: program.globalCount });
  runtime.onExit = (frame) => {
    if (runtime.frames.length !== 1 || frame.info.isLibrary) return;
    onMainExit?.(frame);
    // Collecting while main's frame still exists keeps the turtles its variables hold.
    runtime.collectGarbage();
    finalTurtles = runtime.world.turtleTraces();
  };
  let uncaughtException: string | undefined;
  try {
    for (const initializer of program.initializers) initializer.run(root);
    const args: Value[] = [];
    if (program.mainTakesArgs) {
      const array = new KObject(libraryClass('kotlin.Array'), 0);
      array.items = [];
      args.push(array);
    }
    const isMainFrame = runtime.onExit;
    runtime.onExit = (frame) => {
      if (frame.info.name === program.main.name && runtime.frames.length === 1) isMainFrame(frame);
    };
    (program.main.invoke as NonNullable<typeof program.main.invoke>)(root, undefined, args, undefined);
  } catch (error) {
    uncaughtException = describeUncaught(root, error);
  }
  return { finalBoard: runtime.world.boardText(), finalTurtles, uncaughtException, ...runtime.io.output() };
}

function describeUncaught(root: Frame, error: unknown): string | undefined {
  if (error instanceof ProgramExit) return undefined;
  if (error instanceof RangeError && /call stack/i.test(error.message)) return 'java.lang.StackOverflowError';
  if (!(error instanceof KotlinThrow)) throw error;
  try {
    return stringOf(root, error.value);
  } catch (formattingError) {
    // A program's toString() may itself fail, which leaves only the class to describe the exception.
    if (formattingError instanceof KotlinThrow || formattingError instanceof RangeError)
      return error.value.cls.qualifiedName;
    throw formattingError;
  }
}
