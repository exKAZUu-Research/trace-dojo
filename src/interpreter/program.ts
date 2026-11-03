import { executeJavaProgram } from '../java/execute';
import { traceJavaProgram } from '../java/trace';
import { findJavaTraceAnnotations } from '../problems/fillInBlank/javaSource';
import type { TraceItem, TraceItemVariable, TurtleTrace } from '../problems/trace';
import type { SourceDiagnostic } from './diagnostics';
import type { ExecutionLimitError } from './limits';
import { type Annotations, readAnnotations, removeAnnotations, type TraceAnnotation } from './traceAnnotations';

export type ProgrammingLanguage = keyof typeof interpreters;

export interface ProgramRun {
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
  /** The program without its `// step` and `// caller` annotations. */
  displayProgram: string;
  sidToLineIndex: Map<number, number>;
  callerIdToLineIndex: Map<number, number>;
}

interface Interpreter {
  /** Finds the annotations in line comments, skipping look-alikes in literals and other comments. */
  findTraceAnnotations: (source: string) => TraceAnnotation[];
  /** Runs a model program, recording the state after every statement on a `// step` row. */
  record: (program: string, annotations: Annotations) => ProgramRecording;
  /** Compiles and runs a learner's program, reporting how it ended. */
  execute: (source: string) => ProgramExecution;
}

const interpreters = {
  java: { findTraceAnnotations: findJavaTraceAnnotations, record: traceJavaProgram, execute: executeJavaProgram },
} satisfies Record<string, Interpreter>;

/**
 * Runs a model program and records the state after every statement on a `// step` row.
 *
 * @param program The program to run, with every blank filled in.
 * @param displayProgram The program shown to learners, whose blanks may be placeholders on the same rows.
 */
export function traceProgram(language: ProgrammingLanguage, program: string, displayProgram: string): ProgramTrace {
  const interpreter: Interpreter = interpreters[language];
  const displayedAnnotations = interpreter.findTraceAnnotations(displayProgram);
  const displayed = readAnnotations(displayProgram, displayedAnnotations);
  return {
    ...interpreter.record(program, readAnnotations(program, interpreter.findTraceAnnotations(program))),
    displayProgram: removeAnnotations(displayProgram, displayedAnnotations),
    sidToLineIndex: new Map([...displayed.stepIdByRow].map(([row, id]) => [id, row + 1])),
    callerIdToLineIndex: new Map([...displayed.callerIdByRow].map(([row, id]) => [id, row + 1])),
  };
}

/** Compiles and runs a learner's program, reporting how it ended. */
export function executeProgram(language: ProgrammingLanguage, source: string): ProgramExecution {
  const interpreter: Interpreter = interpreters[language];
  return interpreter.execute(source);
}
