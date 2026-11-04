import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { Program } from './ast';
import { parseJavaScript } from './parse';
import { Runtime } from './runtime';
import { JsThrow, Scope } from './values';

export function executeJavaScriptProgram(source: string): ProgramExecution {
  let program: Program;
  try {
    program = parseJavaScript(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(), program) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs a program to its end or to an exception that escapes it.
 *
 * @param onEnd Called when the program ends, while its scope still holds its variables.
 */
export function runProgram(runtime: Runtime, program: Program, onEnd?: (scope: Scope) => void): ProgramRun {
  const scope = new Scope(runtime.realm.globals, {
    thisValue: undefined,
    homeObject: undefined,
    constructing: undefined,
    newTarget: undefined,
  });
  runtime.pushFrame(scope, undefined, false);
  try {
    let uncaughtException: string | undefined;
    try {
      runtime.evaluator.runProgram(program);
    } catch (error) {
      uncaughtException = describeUncaught(runtime, error);
    }
    onEnd?.(scope);
    runtime.collectGarbage();
    return { finalBoard: runtime.world.boardText(), finalTurtles: runtime.world.turtleTraces(), uncaughtException };
  } finally {
    runtime.popFrame();
  }
}

function describeUncaught(runtime: Runtime, error: unknown): string {
  if (isHostStackOverflow(error)) return 'RangeError: Maximum call stack size exceeded';
  if (!(error instanceof JsThrow)) throw error;
  try {
    return runtime.toString(error.value);
  } catch (formattingError) {
    // A program's own toString() may itself fail, which leaves only a generic description.
    if (formattingError instanceof JsThrow || isHostStackOverflow(formattingError)) return 'Error';
    throw formattingError;
  }
}

/** The host's stack can run out before the call depth limit when each call nests many statements. */
function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}
