import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { type CompiledProgram, compileProgram } from './compiler';
import { utf8Decode } from './literals';
import { withRuntime } from './native';
import { describePanic } from './panicText';
import { parseGo } from './parse';
import { type Frame, GoFatal, GoPanic, ProgramExit, Runtime } from './runtime';
import { Scheduler } from './scheduler';
import { BASIC, typeString } from './types';
import { Cell, Iface } from './values';

export function executeGoProgram(source: string, input?: ProgramInput): ProgramExecution {
  let compiled: CompiledProgram;
  try {
    compiled = compileProgram(parseGo(source));
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
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
 * Initializes the package-level variables and runs `main` to its end or to a panic that ends the program.
 *
 * @param onEnd Receives `main`'s frame when it returns, while the frame still holds its variables.
 */
export function runProgram(runtime: Runtime, program: CompiledProgram, onEnd?: (frame: Frame) => void): ProgramRun {
  return withRuntime(runtime, () => {
    let uncaughtException: string | undefined;
    try {
      runtime.globals = program.globalZeros.map((zero) => new Cell(zero()));
      // The turtles that main's variables still reach when it ends are the final ones, as in Java.
      const onMainEnd = (frame: Frame): void => {
        runtime.scheduler?.finishMain();
        onEnd?.(frame);
        runtime.collectGarbage();
      };
      if (program.concurrent) {
        const scheduler = new Scheduler(runtime);
        const main = scheduler.spawn(function* () {
          yield* runtime.resume(program.initializer, [], [], undefined);
          for (const init of program.inits) yield* runtime.resume(init, [], [], undefined);
          return yield* runtime.resume(program.main, [], [], undefined, undefined, onMainEnd);
        });
        scheduler.run(main);
      } else {
        runtime.call(program.initializer, [], [], undefined);
        for (const init of program.inits) runtime.call(init, [], [], undefined);
        runtime.call(program.main, [], [], undefined, undefined, onMainEnd);
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
  });
}

function describeUncaught(error: unknown): string | undefined {
  // os.Exit ends the program as Java's System.exit does, which the trace and the grader do not count as a failure.
  if (error instanceof ProgramExit) return undefined;
  if (error instanceof GoPanic) return describePanicSafely(error);
  if (error instanceof GoFatal) return error.description;
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return 'runtime: goroutine stack exceeds 1000000000-byte limit\nfatal error: stack overflow';
  }
  throw error;
}

/**
 * Describes a panic, ending as Go's runtime does when an Error or String method panics while it is printed, and as
 * the program otherwise ends when such a method exits or overflows the stack.
 */
function describePanicSafely(panic: GoPanic): string | undefined {
  try {
    return describePanic(panic);
  } catch (error) {
    if (!(error instanceof GoPanic)) return describeUncaught(error);
    const { value } = error;
    if (!(value instanceof Iface)) throw error;
    const reason = value.type === BASIC.string ? (value.value as string) : `type ${typeString(value.type)}`;
    return `fatal error: panic while printing panic value: ${utf8Decode(reason)}`;
  }
}
