import { executeCProgram } from '../c/execute';
import { findCTraceAnnotations } from '../c/parse';
import { traceCProgram } from '../c/trace';
import { executeJavaProgram } from '../java/execute';
import { traceJavaProgram } from '../java/trace';
import { findJavaScriptTraceAnnotations } from '../javascript/parse';
import { executeJavaScriptProgram } from '../javascript/run';
import { traceJavaScriptProgram } from '../javascript/trace';
import { findJavaTraceAnnotations } from '../problems/fillInBlank/javaSource';
import type { TraceItem, TraceItemVariable, TurtleTrace } from '../problems/trace';
import { findPythonTraceAnnotations } from '../python/parse';
import { executePythonProgram } from '../python/run';
import { tracePythonProgram } from '../python/trace';
import type { SourceDiagnostic } from './diagnostics';
import type { ExecutionLimitError } from './limits';
import type { ProgramInput, ProgramOutput } from './programIo';
import { atomicAnnotationsOf, removeAnnotations, type TraceAnnotation, type TraceOptions } from './traceAnnotations';

export type ProgrammingLanguage = keyof typeof interpreters;

export interface ProgramRun extends ProgramOutput {
  finalBoard: string;
  /** The turtles that the program's variables still reach when it ends. */
  finalTurtles: TurtleTrace[];
  /** The description of the exception that ended the program, if one escaped it. */
  uncaughtException: string | undefined;
}

export type ProgramExecution =
  | { kind: 'compileError'; diagnostics: SourceDiagnostic[] }
  | { kind: 'limitExceeded'; limit: ExecutionLimitError['limit'] }
  | ({ kind: 'executed' } & ProgramRun);

/** What an interpreter records while running a model program. */
export interface ProgramRecording extends ProgramRun {
  traceItems: TraceItem[];
  /** The variables of the program's entry point when it ends. */
  finalVars: TraceItemVariable;
}

export interface ProgramTrace extends ProgramRecording {
  /** The program without its atomic annotations (`// atomic`, or `# atomic` in Python), whose rows match the lines that trace items refer to. */
  displayProgram: string;
}

interface Interpreter {
  /** Finds the annotations in line comments, skipping look-alikes in literals and other comments. */
  findTraceAnnotations: (source: string) => TraceAnnotation[];
  /** Runs a model program, recording its steps outside the methods its annotations mark atomic. */
  record: (program: string, trace: TraceOptions, input?: ProgramInput) => ProgramRecording;
  /** Compiles and runs a learner's program, reporting how it ended. */
  execute: (source: string, input?: ProgramInput) => ProgramExecution;
}

const interpreters = {
  java: { findTraceAnnotations: findJavaTraceAnnotations, record: traceJavaProgram, execute: executeJavaProgram },
  javascript: {
    findTraceAnnotations: findJavaScriptTraceAnnotations,
    record: traceJavaScriptProgram,
    execute: executeJavaScriptProgram,
  },
  python: {
    findTraceAnnotations: findPythonTraceAnnotations,
    record: tracePythonProgram,
    execute: executePythonProgram,
  },
  c: { findTraceAnnotations: findCTraceAnnotations, record: traceCProgram, execute: executeCProgram },
} satisfies Record<string, Interpreter>;

/**
 * Runs a model program and records its steps outside the methods marked `// atomic` (`# atomic` in Python).
 *
 * @param program The program to run, with every blank filled in.
 * @param displayProgram The program shown to learners, whose blanks may be placeholders on the same rows.
 */
export function traceProgram(
  language: ProgrammingLanguage,
  program: string,
  displayProgram: string,
  input?: ProgramInput
): ProgramTrace {
  const interpreter: Interpreter = interpreters[language];
  return {
    ...interpreter.record(
      program,
      { atomicAnnotations: atomicAnnotationsOf(program, interpreter.findTraceAnnotations(program)) },
      input
    ),
    displayProgram: removeAnnotations(displayProgram, interpreter.findTraceAnnotations(displayProgram)),
  };
}

/** Compiles and runs a learner's program, reporting how it ended. */
export function executeProgram(language: ProgrammingLanguage, source: string, input?: ProgramInput): ProgramExecution {
  const interpreter: Interpreter = interpreters[language];
  return interpreter.execute(source, input);
}
