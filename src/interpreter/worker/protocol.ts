import type { BrowserReadyLanguage } from '../browserReadyInterpreters';
import { CompileError, type SourceDiagnostic } from '../diagnostics';
import type { ProgramExecution, ProgramTrace } from '../interpreter';
import { ExecutionLimitError } from '../limits';
import type { ProgramInput } from '../programIo';

export type InterpreterRequest =
  | {
      kind: 'trace';
      language: BrowserReadyLanguage;
      program: string;
      displayProgram: string;
      input?: ProgramInput;
    }
  | { kind: 'execute'; language: BrowserReadyLanguage; source: string; input?: ProgramInput };

export type InterpreterResponse =
  /** The language's interpreter is loaded and the program starts now. */
  | { type: 'started' }
  | { type: 'finished'; result: ProgramTrace | ProgramExecution }
  /** `loaded` is false when the interpreter itself failed to load, after which the worker can never load it. */
  | { type: 'failed'; error: TransferredError; loaded: boolean };

/** An error as a message can carry it, since structured cloning drops an error's class and own fields. */
interface TransferredError {
  name: string;
  message: string;
  diagnostics?: SourceDiagnostic[];
  limit?: ExecutionLimitError['limit'];
}

export function transferredErrorOf(error: unknown): TransferredError {
  if (error instanceof CompileError)
    return { name: error.name, message: error.message, diagnostics: error.diagnostics };
  if (error instanceof ExecutionLimitError) return { name: error.name, message: error.message, limit: error.limit };
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

export function errorOf({ name, message, diagnostics, limit }: TransferredError): Error {
  if (diagnostics) return new CompileError(diagnostics);
  if (limit) return new ExecutionLimitError(limit);
  const error = new Error(message);
  error.name = name;
  return error;
}
