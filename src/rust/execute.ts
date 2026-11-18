import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { buildProgram, type BuiltProgram } from './build';
import { DEFAULT_SPEC } from './fmt';
import { Interpreter } from './interpreter';
import { type Module } from './items';
import { ControlSignal, type Frame, ProcessExit, Runtime, RustPanic, StackOverflow } from './runtime';
import { resolve, shallow } from './types';
import { EnumValue } from './values';

export function executeRustProgram(source: string, input?: ProgramInput): ProgramExecution {
  let built: BuiltProgram;
  try {
    built = buildProgram(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(input), built, false) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/** The text Rust prints when a panic ends the program. */
export function describePanic(panic: RustPanic): string {
  const { row, col } = panic.span;
  return `thread 'main' (1) panicked at src/main.rs:${row + 1}:${col}:\n${panic.message}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`;
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
  if (error instanceof ControlSignal) throw new TypeError(`Unexpected ${error.kind} outside its loop or function`);
  throw error;
}
