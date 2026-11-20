import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget, ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { buildProgram, type BuiltProgram } from './build';
import { settleStrings } from './capacity';
import { DEFAULT_SPEC } from './fmt';
import { Interpreter } from './interpreter';
import { type Module } from './items';
import { ControlSignal, type Frame, OutOfMemory, ProcessExit, Runtime, RustPanic, StackOverflow } from './runtime';
import { resolve, shallow } from './types';
import { EnumValue } from './values';

// code-gauge-allow duplicateLines 15 -- Each language reports how its program ended alike.
export function executeRustProgram(source: string, input?: ProgramInput): ProgramExecution {
  const budget = new ExecutionBudget();
  try {
    const built = buildProgram(source, undefined, budget);
    return { kind: 'executed', ...runProgram(new Runtime(input, budget), built, false) };
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/** The commit of Rust 1.99.1, which the paths of its standard library's sources in panic messages name. */
const RUSTC_COMMIT = '58cf8f9c35b355199727627d07ae34a4e2846d67';

/** The text Rust prints when a panic ends the program. */
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
 * @param onEnd Receives `main`'s frame when it returns, while the frame still holds its variables.
 */
export function runProgram(
  runtime: Runtime,
  built: BuiltProgram,
  tracing: boolean,
  onEnd?: (frame: Frame) => void
): ProgramRun {
  const { program, checker } = built;
  const interp = new Interpreter(program, checker, tracing);
  interp.runtime = runtime;
  const main = (program.root as Module).values.get('main');
  if (main?.binding.kind !== 'fn') throw new Error('No main function');
  const mainFn = main.binding.def;
  let uncaughtException: string | undefined;
  try {
    const compiled = interp.compiler.compileFn(mainFn);
    const result = interp.invoke(compiled, new Map(), [], undefined, [], (frame) => {
      onEnd?.(frame);
      runtime.collectGarbage();
    });
    const ret = shallow(resolve(mainFn.ret, true));
    if (ret.kind === 'adt' && ret.def.builtin === 'Result' && result instanceof EnumValue && result.variant === 1) {
      const errorType = resolve(ret.args[1], true);
      uncaughtException = `Error: ${interp.formatter.debug(result.fields[0], errorType, DEFAULT_SPEC, undefined)}`;
    }
  } catch (error) {
    uncaughtException = describeUncaught(error);
  } finally {
    // The `String`s in flight are kept by their text, which must not outlive the run.
    settleStrings();
  }
  return {
    finalBoard: runtime.world.boardText(),
    finalTurtles: runtime.world.turtleTraces(),
    uncaughtException,
    ...runtime.io.output(),
  };
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
  if (error instanceof ControlSignal) throw new TypeError(`Unexpected ${error.kind} outside its loop or function`);
  throw error;
}
