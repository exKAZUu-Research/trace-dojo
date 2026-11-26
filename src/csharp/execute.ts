import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { type CompiledProgram, compileProgram } from './compiler';
import { Evaluator } from './evaluator';
import { runtimeTypeName } from './objects';
import { parseCSharp } from './parse';
import { PointerRangeError } from './pointers';
import { type CsThrow, Frame, ProgramExit, Runtime } from './runtime';
import { awaitedFailure, DeadlockError, type TaskState, UnhandledAsyncException } from './tasks';
import { arrayType, namedType, type TypeSymbol } from './types';
import { CsArray, CsObject, meterStructs, type Value } from './values';

export function executeCSharpProgram(source: string, input?: ProgramInput): ProgramExecution {
  let compiled: CompiledProgram;
  try {
    compiled = compileProgram(parseCSharp(source));
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    const runtime = new Runtime(compiled.library, input);
    return { kind: 'executed', ...runProgram(new Evaluator(runtime, compiled)) };
  } catch (error) {
    // A library call whose arguments use what this environment cannot run, such as a regular expression's construct.
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs the program's entry point.
 *
 * @param onMainExit Called when the entry point returns or throws, while its frame still holds its locals.
 */
export function runProgram(evaluator: Evaluator, onMainExit?: (frame: Frame) => void): ProgramRun {
  const { runtime, program } = evaluator;
  let finalTurtles: ProgramRun['finalTurtles'] = [];
  runtime.onExit = (frame) => {
    if (frame.method !== program.entry || runtime.frames.length > 0 || frame.isSuspended) return;
    onMainExit?.(frame);
    runtime.frames.push(frame);
    try {
      runtime.collectGarbage();
    } finally {
      runtime.frames.pop();
    }
    finalTurtles = runtime.world.turtleTraces();
  };
  meterStructs((fieldCount) => runtime.meterStructFields(fieldCount));
  let uncaughtException: string | undefined;
  try {
    uncaughtException = runEntry(evaluator);
  } finally {
    meterStructs(undefined);
  }
  return { finalBoard: runtime.world.boardText(), finalTurtles, uncaughtException, ...runtime.io.output() };
}

// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function runEntry(evaluator: Evaluator): string | undefined {
  const { runtime, program } = evaluator;
  const root = new Frame(runtime, undefined, undefined, new Map(), undefined, 0);
  const entry = program.entry;
  const stringSymbol = runtime.library.specials.get('string') as TypeSymbol;
  const args: Value[] = entry.parameters.length === 0 ? [] : [new CsArray(arrayType(namedType(stringSymbol)), [0], [])];
  try {
    // `[ModuleInitializer]` methods run when the module loads, before the entry point.
    for (const type of program.types)
      for (const method of type.methods)
        if (method.isModuleInitializer) evaluator.invoke(root, method, undefined, [], undefined, new Map());
    // .NET initializes a type with a static constructor before any of its members runs, so before Main is called.
    runtime.ensureInitialized(entry.owner.declaredType);
    const result = evaluator.invoke(root, entry, undefined, args, undefined, new Map());
    // An entry point's task is waited for, as the generated `Main` does with `GetAwaiter().GetResult()`.
    if (result instanceof CsObject) {
      const state = result.native as TaskState;
      runtime.scheduler.runUntil(() => state.isDone);
      const failure = awaitedFailure(runtime, state);
      if (failure) throw failure;
    }
    return undefined;
  } catch (error) {
    if (error instanceof ProgramExit) return undefined;
    if (error instanceof DeadlockError) return error.message;
    if (error instanceof PointerRangeError) return error.message;
    if (error instanceof UnhandledAsyncException) return describeUncaught(evaluator, error.thrown, error.isRethrown);
    if (evaluator.isStackOverflow(error)) {
      runtime.io.stderr.write('Stack overflow.\n');
      return 'Stack overflow.';
    }
    const thrown = evaluator.asThrow(error);
    if (!thrown) throw error;
    return describeUncaught(evaluator, thrown);
  }
}

/** Reports an exception that escaped the entry point as .NET does on standard error, and describes it. */
function describeUncaught(evaluator: Evaluator, thrown: CsThrow, isRethrown = false): string {
  let description: string;
  try {
    description = evaluator.uncaughtText(thrown.exception);
  } catch (error) {
    if (!evaluator.asThrow(error) && !evaluator.isStackOverflow(error)) throw error;
    description = runtimeTypeName(thrown.exception.type);
  }
  evaluator.runtime.io.stderr.write(`Unhandled exception. ${description}\n`);
  if (isRethrown) evaluator.runtime.io.stderr.write('--- End of stack trace from previous location ---\n');
  return description;
}
