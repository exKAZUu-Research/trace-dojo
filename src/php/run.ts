// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { bootstrap } from './bootstrap';
import { type CallRecord, HostStackExhaustion, invoke, resetCallStack } from './calls';
import { throwableText, traceText } from './exceptions';
import { holderCounts } from './garbage';
import { callValue, runStatements } from './interp';
import { type ParsedProgram, parsePhp } from './parse';
import { ExitSignal, FatalError, type Frame, PhpThrow, Runtime, SCRIPT_PATH, withRuntime } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { PhpObject } from './values';

import './library';

// code-gauge-allow duplicateLines 15 -- The interpreter entry points mirror the other languages so callers use one contract.
export function executePhpProgram(source: string, input?: ProgramInput): ProgramExecution {
  let parsed: ParsedProgram;
  try {
    parsed = parsePhp(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(input), parsed) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs a program to its end, to `exit`, or to an error that ends it, then shuts down as PHP does.
 *
 * @param onEnd Called when the program ends, while the global frame still holds its variables.
 */
export function runProgram(runtime: Runtime, parsed: ParsedProgram, onEnd?: (frame: Frame) => void): ProgramRun {
  return withRuntime(runtime, () => {
    resetCallStack();
    bootstrap(runtime);
    runtime.program = parsed.program;
    runtime.notices = parsed.notices;
    let uncaughtException: string | undefined;
    try {
      uncaughtException = guard(runtime, () => runStatements(parsed.program));
      onEnd?.(runtime.globalFrame);
      uncaughtException = shutdown(runtime) ?? uncaughtException;
    } finally {
      runtime.flush();
    }
    return {
      finalBoard: runtime.world.boardText(),
      finalTurtles: runtime.world.turtleTraces(),
      uncaughtException,
      ...runtime.io.output(),
    };
  });
}

/** Runs code, reporting an exception or fatal error that escapes it as PHP does and returning its description. */
function guard(runtime: Runtime, run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return report(runtime, error);
  }
}

function report(runtime: Runtime, error: unknown): string | undefined {
  if (error instanceof ExitSignal) return undefined;
  if (error instanceof UnsupportedFeatureError) {
    restoreStack(runtime);
    return error.message;
  }
  if (error instanceof PhpThrow) {
    restoreStack(runtime);
    if (runtime.exceptionHandler !== null) {
      const handler = runtime.exceptionHandler;
      runtime.exceptionHandler = null;
      try {
        callValue(handler, [{ v: error.object }], undefined);
        return undefined;
      } catch (error_) {
        return report(runtime, error_);
      }
    }
    return printUncaught(runtime, error.object);
  }
  if (error instanceof HostStackExhaustion) {
    const trace = traceText(error.record ? [error.record] : []);
    restoreStack(runtime);
    const message = `Fatal error: ${error.message} in ${SCRIPT_PATH} on line ${(error.row ?? 0) + 1}\nStack trace:\n${trace}`;
    runtime.echo(`\n${message}\n`);
    return message;
  }
  if (error instanceof FatalError) {
    const records = error.calls as CallRecord[];
    const trace = traceText(error.exhausted ? records.slice(0, 1) : records);
    restoreStack(runtime);
    const message = `Fatal error: ${error.message ? `${error.message} in ${SCRIPT_PATH} on line ${error.row + 1}\nStack trace:\n${trace}` : ''}`;
    if (error.message) runtime.echo(`\n${message}\n`);
    return message || 'Fatal error';
  }
  throw error;
}

function restoreStack(runtime: Runtime): void {
  runtime.frames.length = 1;
  runtime.depth = 0;
  resetCallStack();
}

function printUncaught(runtime: Runtime, object: PhpObject): string {
  let text: string;
  try {
    text = throwableText(object);
  } catch (error) {
    if (error instanceof PhpThrow) text = throwableText(error.object);
    else throw error;
  }
  const line = object.props.get('line');
  const message = `Fatal error: Uncaught ${text}\n  thrown in ${SCRIPT_PATH} on line ${typeof line === 'bigint' ? line : 0}`;
  runtime.echo(`\n${message}\n`);
  return message;
}

/** Destroys the objects that remain, as PHP's shutdown does: global variables first, newest first, then the rest. */
function shutdown(runtime: Runtime): string | undefined {
  return guard(runtime, () => {
    runtime.frames.length = 1;
    destroyGlobals(runtime);
    const remaining = [...runtime.objects.values()].toSorted((a, b) => a.id - b.id);
    for (const object of remaining) {
      if (object.destructed) continue;
      const destructor = object.cls.findMethod('__destruct');
      object.destructed = true;
      if (!destructor) continue;
      runtime.destructibles--;
      invoke(
        { fn: destructor.fn, thisObj: object, scope: destructor.scope, staticClass: object.cls, method: destructor },
        [],
        undefined
      );
    }
    runtime.shuttingDown = true;
  });
}

function destroyGlobals(runtime: Runtime): void {
  if (runtime.destructibles === 0) return;
  const order = globalOrder(runtime);
  for (;;) {
    let removed = false;
    for (const name of order.toReversed()) {
      const ref = runtime.globalFrame.vars.get(name);
      if (!ref) continue;
      const value = ref.v;
      if (!(value instanceof PhpObject) || ref.rc > 1 || holderCounts(runtime).get(value) !== 1) continue;
      runtime.globalFrame.vars.delete(name);
      removed = true;
      runtime.collectGarbage();
    }
    if (!removed) break;
  }
}

/** The global variables in the order PHP's symbol table holds them: the program's variables in order of appearance. */
function globalOrder(runtime: Runtime): string[] {
  const order = [...(runtime.program?.mainVars ?? [])];
  for (const name of runtime.globalFrame.vars.keys()) if (!order.includes(name)) order.push(name);
  return order;
}
