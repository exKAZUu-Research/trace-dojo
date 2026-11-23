import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { type CompiledProgram, compileProgram } from './compiler';
import { Evaluator } from './evaluator';
import { runtimeTypeName } from './objects';
import { parseCSharp } from './parse';
import { type CsThrow, Frame, ProgramExit, Runtime } from './runtime';
import { arrayType, namedType, type TypeSymbol } from './types';
import { CsArray, type Value } from './values';

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
    if (frame.method !== program.entry || runtime.frames.length > 0) return;
    onMainExit?.(frame);
    runtime.frames.push(frame);
    try {
      runtime.collectGarbage();
    } finally {
      runtime.frames.pop();
    }
    finalTurtles = runtime.world.turtleTraces();
  };
  const uncaughtException = runEntry(evaluator);
  return { finalBoard: runtime.world.boardText(), finalTurtles, uncaughtException, ...runtime.io.output() };
}

function runEntry(evaluator: Evaluator): string | undefined {
  const { runtime, program } = evaluator;
  const root = new Frame(runtime, undefined, undefined, new Map(), undefined, 0);
  const entry = program.entry;
  const stringSymbol = runtime.library.specials.get('string') as TypeSymbol;
  const args: Value[] = entry.parameters.length === 0 ? [] : [new CsArray(arrayType(namedType(stringSymbol)), [0], [])];
  try {
    // .NET initializes a type with a static constructor before any of its members runs, so before Main is called.
    runtime.ensureInitialized(entry.owner.declaredType);
    evaluator.invoke(root, entry, undefined, args, undefined, new Map());
    return undefined;
  } catch (error) {
    if (error instanceof ProgramExit) return undefined;
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
function describeUncaught(evaluator: Evaluator, thrown: CsThrow): string {
  let description: string;
  try {
    description = evaluator.uncaughtText(thrown.exception);
  } catch (error) {
    if (!evaluator.asThrow(error) && !evaluator.isStackOverflow(error)) throw error;
    description = runtimeTypeName(thrown.exception.type);
  }
  evaluator.runtime.io.stderr.write(`Unhandled exception. ${description}\n`);
  return description;
}
