import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { Value } from './arith';
import { type CompiledProgram, Compiler } from './compiler';
import type { CompileOptions } from './compilerBase';
import { CRuntimeError, ProgramAbort, ProgramExit } from './errors';
import { libraryEntry } from './library';
import { cString } from './library/support';
import { parseC } from './parse';
import { type Frame, Runtime, storeValue } from './runtime';
import { CHAR_POINTER, INT, pointerTo, sizeOf } from './types';

// code-gauge-allow duplicateLines 15 -- Each language's runner wraps its own parser and runtime.
export function executeCProgram(source: string, input?: ProgramInput): ProgramExecution {
  let program: CompiledProgram;
  try {
    program = compileC(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(input), program) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

export function compileC(source: string, options: CompileOptions = {}): CompiledProgram {
  return new Compiler(options, libraryEntry).compile(parseC(source));
}

/** The name `argv[0]` holds, since the real one depends on where the program was built. */
const PROGRAM_NAME = './main';

/**
 * Lays out the program's memory, initializes its static variables, and runs `main` to its end or to an error that ends
 * the program.
 *
 * @param onEnd Receives `main`'s frame when it returns, while the frame still holds its variables.
 */
// code-gauge-allow duplicateLines 16 -- Each language's runner wraps its own runtime and collects the same output contract.
export function runProgram(runtime: Runtime, program: CompiledProgram, onEnd?: (frame: Frame) => void): ProgramRun {
  let uncaughtException: string | undefined;
  try {
    try {
      setUp(runtime, program);
      callMain(runtime, program, onEnd);
      exitWith(runtime);
    } catch (error) {
      if (!(error instanceof ProgramExit)) throw error;
    }
  } catch (error) {
    uncaughtException = describeUncaught(error);
  }
  runtime.flushOutput();
  return {
    finalBoard: runtime.world.boardText(),
    finalTurtles: runtime.world.turtleTraces(),
    uncaughtException,
    ...runtime.io.output(),
  };
}

function setUp(runtime: Runtime, program: CompiledProgram): void {
  for (const fn of program.functions) {
    const block = runtime.allocate(1, 'text');
    block.isReadOnly = true;
    block.target = fn;
    fn.address = block.base;
    runtime.functions.set(block.base, fn);
  }
  runtime.literals = program.strings.map((bytes) => runtime.stringLiteral(bytes));
  runtime.globals = program.globals.map((global) => {
    const hasStorage = global.isDefined || global.header !== undefined;
    const block = runtime.allocate(hasStorage ? Math.max(sizeOf(global.type), 1) : 0, 'data');
    block.initialized.fill(255);
    block.type = global.type;
    block.name = global.name;
    return block;
  });
  for (const name of ['stdin', 'stdout', 'stderr'] as const) {
    const file = runtime.allocate(8, 'data');
    file.isReadOnly = true;
    runtime.streams[name] = file.base;
  }
  for (const [index, global] of program.globals.entries()) {
    const block = runtime.globals[index];
    if (global.name in runtime.streams && !global.isDefined) {
      storeValue(runtime, block.base, global.type, runtime.streams[global.name as keyof Runtime['streams']]);
    }
    if (global.name === 'errno' && !global.isDefined) runtime.errnoAddress = block.base;
  }
  for (const [index, global] of program.globals.entries()) global.initialize?.(runtime, runtime.globals[index]);
}

function callMain(runtime: Runtime, program: CompiledProgram, onEnd: ((frame: Frame) => void) | undefined): void {
  const { main } = program;
  const args: Value[] = [];
  const types = [];
  if ((main.type.params ?? []).length === 2) {
    const name = runtime.stringLiteral(cString(PROGRAM_NAME));
    const argv = runtime.allocate(16, 'stack');
    storeValue(runtime, argv.base, CHAR_POINTER, name.base);
    storeValue(runtime, argv.base + 8, CHAR_POINTER, 0);
    args.push(1, argv.base);
    types.push(INT, pointerTo(CHAR_POINTER));
  }
  // The turtles that main's variables still reach when it ends are the final ones, as in Java.
  runtime.call(main, args, types, undefined, (frame) => {
    onEnd?.(frame);
    runtime.collectGarbage();
  });
}

/** Ends the program as returning from main does: `exit` runs the functions `atexit` registered. */
function exitWith(runtime: Runtime): void {
  while (runtime.exitHandlers.length > 0) {
    const address = runtime.exitHandlers.pop() as number;
    const fn = runtime.functions.get(address);
    if (fn) runtime.call(fn, [], [], undefined);
  }
}

function describeUncaught(error: unknown): string | undefined {
  // exit ends the program as Java's System.exit does, which the trace and the grader do not count as a failure.
  if (error instanceof ProgramExit) return undefined;
  if (error instanceof ProgramAbort || error instanceof CRuntimeError) return error.message;
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return new CRuntimeError('stackOverflow').message;
  }
  throw error;
}
