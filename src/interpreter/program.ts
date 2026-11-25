import { type Interpreter, type ProgramExecution, type ProgramTrace, traceWith } from './interpreter';
import { interpreter as c } from './languages/c';
import { interpreter as cpp } from './languages/cpp';
import { interpreter as csharp } from './languages/csharp';
import { interpreter as dart } from './languages/dart';
import { interpreter as go } from './languages/go';
import { interpreter as haskell } from './languages/haskell';
import { interpreter as java } from './languages/java';
import { interpreter as javascript } from './languages/javascript';
import { interpreter as kotlin } from './languages/kotlin';
import { interpreter as php } from './languages/php';
import { interpreter as python } from './languages/python';
import { interpreter as ruby } from './languages/ruby';
import { interpreter as rust } from './languages/rust';
import { interpreter as typescript } from './languages/typescript';
import { interpreter as zig } from './languages/zig';
import type { ProgramInput } from './programIo';

export type { ProgramExecution, ProgramRecording, ProgramRun, ProgramTrace } from './interpreter';

export type ProgrammingLanguage = keyof typeof interpreters;

const interpreters = {
  go,
  java,
  javascript,
  python,
  ruby,
  c,
  kotlin,
  typescript,
  cpp,
  php,
  rust,
  zig,
  dart,
  haskell,
  csharp,
} satisfies Record<string, Interpreter>;

/**
 * Runs a model program and records its steps outside the methods marked `// atomic` (`# atomic` in Python and Ruby, `-- atomic` in Haskell).
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
  return traceWith(interpreters[language], program, displayProgram, input);
}

/** Compiles and runs a learner's program, reporting how it ended. */
export function executeProgram(language: ProgrammingLanguage, source: string, input?: ProgramInput): ProgramExecution {
  return interpreters[language].execute(source, input);
}
