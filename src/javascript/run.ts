import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { Program } from './ast';
import { errorHeadline, inspect } from './inspect';
import { parseJavaScript } from './parse';
import { Runtime } from './runtime';
import { JsObject, JsThrow, Scope } from './values';

export function executeJavaScriptProgram(source: string, input?: ProgramInput): ProgramExecution {
  return executeParsedProgram(() => parseJavaScript(source), input);
}

/** Parses a program with `parse`, which throws a `CompileError` to reject it, and runs it. */
export function executeParsedProgram(parse: () => Program, input?: ProgramInput): ProgramExecution {
  let program: Program;
  try {
    program = parse();
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    // Checking a program before it runs is bounded as running it is.
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(input), program) };
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
// code-gauge-allow duplicateLines 20 -- Each language's runner wraps its own runtime and collects the same output contract.
export function runProgram(runtime: Runtime, program: Program, onEnd?: (scope: Scope) => void): ProgramRun {
  const scope = new Scope(runtime.realm.globals, {
    // A CommonJS script's `this` is its empty `module.exports`.
    thisValue: program.isStrict ? undefined : runtime.newObject(),
    homeObject: undefined,
    constructing: undefined,
    newTarget: undefined,
    isStrict: program.isStrict,
    hasImplicitThis: !program.isStrict,
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
    return {
      finalBoard: runtime.world.boardText(),
      finalTurtles: runtime.world.turtleTraces(),
      uncaughtException,
      ...runtime.io.output(),
    };
  } finally {
    runtime.popFrame();
  }
}

function describeUncaught(runtime: Runtime, error: unknown): string {
  if (isHostStackOverflow(error)) return 'RangeError: Maximum call stack size exceeded';
  if (!(error instanceof JsThrow)) throw error;
  try {
    // Node.js prints a thrown string as it is, an error by its stack, and any other value as `console.log` shows it.
    const { value } = error;
    if (typeof value === 'string') return value;
    return value instanceof JsObject && value.isError ? errorHeadline(runtime, value) : inspect(runtime, value);
  } catch (formattingError) {
    // A value too deep to inspect leaves only a generic description.
    if (formattingError instanceof JsThrow || isHostStackOverflow(formattingError)) return 'Error';
    throw formattingError;
  }
}

/** The host's stack can run out before the call depth limit when each call nests many statements. */
function isHostStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}
