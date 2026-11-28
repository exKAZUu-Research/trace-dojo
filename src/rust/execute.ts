import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { buildProgram, type BuiltProgram } from './build';
import { DEFAULT_SPEC } from './fmt';
import { Interpreter } from './interpreter';
import { type Module } from './items';
import {
  ControlSignal,
  FmtFailure,
  type Frame,
  OutOfMemory,
  ProcessExit,
  Runtime,
  RustPanic,
  StackOverflow,
} from './runtime';
import { resolve, shallow, type Type } from './types';
import { EnumValue, type Value } from './values';

export function executeRustProgram(source: string, input?: ProgramInput): ProgramExecution {
  try {
    const built = buildProgram(source);
    return { kind: 'executed', ...runProgram(new Runtime(input), built, false) };
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/** The commit of Rust 1.99.1, which the paths of its standard library's sources in panic messages name. */
const RUSTC_COMMIT = '58cf8f9c35b355199727627d07ae34a4e2846d67';

export function describePanic(panic: RustPanic): string {
  const { row, col, displayCol } = panic.span;
  // A location in a dependency of the standard library is a full path (`/rust/deps/...`).
  const location = panic.libraryLocation?.startsWith('/')
    ? panic.libraryLocation
    : panic.libraryLocation
      ? `/rustc/${RUSTC_COMMIT}/library/${panic.libraryLocation}`
      : `src/main.rs:${row + 1}:${displayCol ?? col}`;
  return `thread 'main' (1) panicked at ${location}:\n${panic.message}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`;
}

/**
 * Runs `main` to its end, to a panic, or to `std::process::exit`.
 *
 * @param onEnd Receives `main`'s frame on exit while the frame still holds its variables.
 */
export function runProgram(
  runtime: Runtime,
  built: BuiltProgram,
  tracing: boolean,
  onEnd?: (frame: Frame) => void
): ProgramRun {
  const { program, checker } = built;
  const main = (program.root as Module).values.get('main');
  if (main?.binding.kind !== 'fn') throw new Error('No main function');
  const mainFn = main.binding.def;
  const interp = new Interpreter(program, checker, tracing);
  interp.runtime = runtime;
  let uncaughtException: string | undefined;
  try {
    const compiled = interp.compiler.compileFn(mainFn);
    const result = interp.invoke(compiled, new Map(), [], undefined, [], (frame, returned) => {
      onEnd?.(frame);
      runtime.withRoots([returned], () => runtime.collectGarbage());
    });
    uncaughtException = describeMainResult(interp, result, mainFn.ret);
  } catch (error) {
    uncaughtException = describeUncaught(error);
  } finally {
    interp.restoreOperations();
  }
  runtime.finishOutput();
  return {
    finalBoard: runtime.world.boardText(),
    finalTurtles: runtime.world.turtleTraces(),
    uncaughtException,
    ...runtime.io.output(),
  };
}

function describeMainResult(interp: Interpreter, result: Value, type: Type): string | undefined {
  const ret = shallow(resolve(type, true));
  if (ret.kind !== 'adt' || ret.def.builtin !== 'Result' || !(result instanceof EnumValue)) return;
  if (result.variant === 0) return describeMainResult(interp, result.fields[0], ret.args[0]);
  const error = result.fields[0];
  try {
    return interp.runtime.withRoots([error], () => {
      interp.runtime.collectGarbage();
      return `Error: ${interp.formatter.debug(error, resolve(ret.args[1], true), DEFAULT_SPEC, undefined)}`;
    });
  } finally {
    interp.runtime.collectGarbage();
  }
}

function describeUncaught(error: unknown): string | undefined {
  if (error instanceof ProcessExit) return undefined;
  if (error instanceof RustPanic) return describePanic(error);
  if (error instanceof StackOverflow || (error instanceof RangeError && /call stack/i.test(error.message))) {
    return "\nthread 'main' (1) has overflowed its stack\nfatal runtime error: stack overflow, aborting";
  }
  if (error instanceof OutOfMemory) {
    return `memory allocation of ${error.bytes} bytes failed\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`;
  }
  // An impl's formatting error that nothing above turned into its own panic ends the program as a writer's does.
  if (error instanceof FmtFailure) {
    return describePanic(
      new RustPanic(
        'a formatting trait implementation returned an error when the underlying stream did not',
        { row: 0, col: 0 },
        'core/src/io/write.rs:411:17'
      )
    );
  }
  if (error instanceof ControlSignal) throw new TypeError(`Unexpected ${error.kind} outside its loop or function`);
  throw error;
}
