import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { CompiledProgram } from './compiler';
import { initialGlobals, topLevelFunctionClosure } from './declarationRuntime';
import { parseDart } from './parse';
import { compileProgram, LINKS } from './program';
import { DartThrow, type Frame, ProgramExit, Runtime } from './runtime';
import { coreTypes, interfaceType } from './types';
import { type Callable, DartList, type Value } from './values';

export function executeDartProgram(source: string, input?: ProgramInput): ProgramExecution {
  try {
    const compiled = compileProgram(parseDart(source));
    return { kind: 'executed', ...runProgram(newRuntime(input), compiled) };
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

export function newRuntime(input?: ProgramInput): Runtime {
  const runtime = new Runtime(input);
  runtime.links = LINKS;
  return runtime;
}

/**
 * Runs `main` to its end or to an exception that escapes it.
 *
 * @param onMainExit Called when `main` returns or throws, while its frame still holds its locals.
 */
export function runProgram(
  runtime: Runtime,
  program: CompiledProgram,
  onMainExit?: (frame: Frame) => void
): ProgramRun {
  runtime.recordShapes.registerDeclarations(program.recordFieldNames);
  runtime.globals = initialGlobals(program.globals);
  let finalTurtles: ProgramRun['finalTurtles'] = [];
  const recordEnd = (): void => {
    const frame = runtime.frames.at(-1);
    if (frame) onMainExit?.(frame);
    runtime.collectGarbage();
    finalTurtles = runtime.world.turtleTraces();
  };
  runtime.onMainExit = recordEnd;
  let uncaughtException: string | undefined;
  try {
    runMain(runtime, program);
    // The isolate keeps running the microtasks and timers that `main` left until none remain.
    runtime.events.run();
  } catch (error) {
    uncaughtException = describeUncaught(runtime, error);
  }
  if (runtime.onMainExit) {
    runtime.onMainExit = undefined;
    finalTurtles = runtime.world.turtleTraces();
  } else if (runtime.events.hasRun) {
    // Callbacks that ran after `main` returned may have moved turtles.
    runtime.collectGarbage();
    finalTurtles = runtime.world.turtleTraces();
  }
  return { finalBoard: runtime.world.boardText(), finalTurtles, uncaughtException, ...runtime.io.output() };
}

function runMain(runtime: Runtime, program: CompiledProgram): void {
  const { main } = program;
  if (main.type.typeParams.length > 0) {
    runtime.callValue(
      topLevelFunctionClosure(runtime, main),
      { positional: [], named: undefined, invocation: 'dynamic' },
      [],
      undefined
    );
    return;
  }
  const args: Value[] = [];
  if (program.mainTakesArguments) args.push(new DartList(coreTypes.list, interfaceType(coreTypes.string), [], true));
  if (main.type.positional.length > 1) args.push(undefined);
  (main.impl as Callable)(
    runtime,
    undefined,
    { positional: args, named: undefined, invocation: 'dynamic' },
    [],
    undefined
  );
}

function describeUncaught(runtime: Runtime, error: unknown): string | undefined {
  if (error instanceof ProgramExit) return undefined;
  if (isHostStackOverflow(error)) return 'Unhandled exception:\nStack Overflow';
  if (!(error instanceof DartThrow)) throw error;
  runtime.frames.length = 0;
  try {
    const text = runtime.invoke(error.value, 'toString', { positional: [], named: undefined }, [], undefined);
    return `Unhandled exception:\n${typeof text === 'string' ? text : LINKS.stringify(runtime, text)}`;
  } catch (formattingError) {
    if (formattingError instanceof DartThrow || isHostStackOverflow(formattingError)) {
      return 'Unhandled exception:\n<Received error while converting exception to string>';
    }
    throw formattingError;
  }
}

/** The host's stack can run out before Dart's call depth limit when each call nests many expressions. */
function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}
