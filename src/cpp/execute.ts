import { CRuntimeError } from '../c/errors';
import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TurtleTrace } from '../problems/trace';
import { byteArray } from './bytes';
import { type CompiledProgram, type CompileOptions, Compiler } from './compiler';
import { type CppException, CppRuntimeError, ProgramAbort, ProgramExit } from './errors';
import { Library } from './library/registry';
import { cStringStore, readCString } from './library/support';
import { invoke } from './objectCompiler';
import { parseCpp } from './parse';
import type { Frame, Runtime } from './runtime';
import { Runtime as CppRuntime } from './runtime';
import { type ClassInfo, type Type, typeName } from './types';
import { ArrayStore, Box, CObject, Ptr } from './values';

// code-gauge-allow duplicateLines 15 -- Each language's runner wraps its own parser and runtime.
export function executeCppProgram(source: string, input?: ProgramInput): ProgramExecution {
  let program: CompiledProgram;
  try {
    program = compileCpp(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new CppRuntime(input), program) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

export function compileCpp(source: string, options: CompileOptions = {}): CompiledProgram {
  return new Compiler(new Library(), options).compile(parseCpp(source));
}

/** The name `argv[0]` holds, since the real one depends on where the program was built. */
const PROGRAM_NAME = './main';

/**
 * Initializes the program's static storage and runs `main` to its end or to an error that ends the program.
 *
 * @param onEnd Receives `main`'s frame when its body completes, while the frame still holds its variables.
 */
export function runProgram(runtime: Runtime, program: CompiledProgram, onEnd?: (frame: Frame) => void): ProgramRun {
  let uncaughtException: string | undefined;
  let finalTurtles: TurtleTrace[] | undefined;
  runtime.describeUncaught = (frame, exception) => {
    const description = describeException(frame, exception);
    runtime.write('stderr', `${description}\n`);
    return description;
  };
  // The turtles that main's variables reach when its body completes are the final ones, as in Java, before the
  // variables' lifetimes end and their turtles leave the board.
  runtime.onMainEnd = (frame) => {
    onEnd?.(frame);
    runtime.collectGarbage();
    finalTurtles = runtime.world.turtleTraces();
  };
  try {
    runtime.globals = program.createGlobals();
    const startup = runtime.pushFrame(undefined, undefined, undefined, undefined);
    try {
      program.initializeGlobals(startup);
      const args = program.mainTakesArguments ? mainArguments() : [];
      invoke(startup, program.main, args, undefined, undefined as unknown as number);
    } finally {
      runtime.popFrame();
    }
  } catch (error) {
    uncaughtException = describeFailure(error);
  }
  runtime.flushOutput();
  if (!finalTurtles) {
    runtime.collectGarbage();
    finalTurtles = runtime.world.turtleTraces();
  }
  return { finalBoard: runtime.world.boardText(), finalTurtles, uncaughtException, ...runtime.io.output() };
}

function mainArguments(): unknown[] {
  const argv = new ArrayStore([new Ptr(cStringStore(PROGRAM_NAME), 0), new Ptr(undefined, 0)]);
  return [1, new Ptr(argv, 0)];
}

function describeFailure(error: unknown): string | undefined {
  // exit ends the program as Java's System.exit does, which the trace and the grader do not count as a failure.
  if (error instanceof ProgramExit) return undefined;
  if (error instanceof ProgramAbort || error instanceof CppRuntimeError || error instanceof CRuntimeError)
    return error.message;
  if (error instanceof RangeError && /call stack/i.test(error.message))
    return new CppRuntimeError('stackOverflow').message;
  throw error;
}

/** The message libc++abi writes when an exception ends the program, with `what()` for a `std::exception`. */
function describeException(frame: Frame, exception: CppException): string {
  const prefix = `libc++abi: terminating due to uncaught exception of type ${demangledName(exception.type)}`;
  const { value } = exception;
  if (!(value instanceof CObject) || !isStdException(value)) return prefix;
  const what = value.cls.virtuals.get('what()const');
  if (!what) return prefix;
  try {
    const result = invoke(frame, what, [], new Ptr(new Box(value), 0), undefined as unknown as number);
    return `${prefix}: ${decode(readCString(result as Ptr))}`;
  } catch {
    return prefix;
  }
}

function isStdException(object: CObject): boolean {
  for (let cls: ClassInfo | undefined = object.cls; cls; cls = cls.base) {
    if (cls.name === 'std::exception' && cls.library) return true;
  }
  return false;
}

/** A type's name as `__cxa_demangle` writes it, which puts `const` after the type it qualifies. */
function demangledName(type: Type): string {
  if (type.kind === 'pointer') {
    const target = type.to;
    const base = demangledName({ ...target, isConst: false } as Type);
    return `${base}${'isConst' in target && target.isConst ? ' const' : ''}*`;
  }
  if (type.kind === 'class' && type.cls.library?.kind === 'string') {
    return 'std::__1::basic_string<char, std::__1::char_traits<char>, std::__1::allocator<char>>';
  }
  return typeName({ ...type, isConst: false } as Type);
}

function decode(bytes: string): string {
  return new TextDecoder().decode(byteArray(bytes));
}
