// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { bootstrap } from './bootstrap';
import { dec } from './bytes';
import { callValue } from './callables';
import { asInternal, type CallRecord, HostStackExhaustion, invoke, resetCallStack } from './calls';
import { E_DEPRECATED, E_ERROR, E_WARNING, emitError, throwableLocation } from './errors';
import { throwableText, traceText } from './exceptions';
import { releaseDropped, releaseGlobalObject } from './garbage';
import { holderCounts } from './holderCounts';
import { type ParsedProgram, parsePhp } from './parse';
import { releaseBoundedRegexSubject } from './regexExecution';
import { ExitSignal, FatalError, type Frame, PhpThrow, Runtime, SCRIPT_PATH, withRuntime } from './runtime';
import { runExecuteOnLargeStack } from './stackFallback';
import { mayDestruct, runStatements } from './statements';
import { UnsupportedFeatureError } from './unsupported';
import { PhpObject } from './values';

import './library';

export function executePhpProgram(source: string, input?: ProgramInput): ProgramExecution {
  try {
    const parsed = parsePhp(source);
    const runtime = new Runtime(input);
    const run = runProgram(runtime, parsed);
    if (runtime.hostStackExhausted) {
      const retried = runExecuteOnLargeStack(source, runtime.budget.remainingMilliseconds, input);
      if (retried) return retried;
    }
    return { kind: 'executed', ...run };
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
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
    bootstrap();
    runtime.program = parsed.program;
    runtime.notices = parsed.notices;
    let uncaughtException: string | undefined;
    try {
      uncaughtException = guard(runtime, () => {
        for (const notice of parsed.parseNotices)
          emitError(notice.level === 'Deprecated' ? E_DEPRECATED : E_WARNING, notice.message, notice.row);
        runStatements(parsed.program, parsed.conversionError);
      });
      onEnd?.(runtime.globalFrame);
      runtime.world.recordFinalTurtles();
      // A rejection of an unsupported feature ends the run outside PHP, so PHP's shutdown does not run after it.
      if (!rejectedRuns.has(runtime)) uncaughtException = shutdown(runtime) ?? uncaughtException;
    } finally {
      releaseBoundedRegexSubject();
      runtime.flush();
    }
    const stdoutBytes = runtime.stdoutBytes;
    return {
      finalBoard: runtime.world.boardText(),
      finalTurtles: runtime.world.turtleTraces(true),
      uncaughtException,
      ...runtime.io.output(),
      ...(stdoutBytes === undefined ? {} : { stdoutBytes }),
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

/** The runs that rejected an unsupported feature, wherever it was raised (including in an exception handler). */
const rejectedRuns = new WeakSet<Runtime>();

// code-gauge-allow functionCognitiveComplexity 24 -- Dispatches uncaught outcomes before runtime shutdown.
function report(runtime: Runtime, error: unknown, inShutdown = false, release = true): string | undefined {
  if (error instanceof ExitSignal) {
    if (inShutdown) runtime.shuttingDown = true;
    return undefined;
  }
  if (error instanceof UnsupportedFeatureError) {
    restoreStack(runtime);
    rejectedRuns.add(runtime);
    return error.message;
  }
  if (error instanceof PhpThrow) {
    restoreStack(runtime);
    return invokeExceptionHandler(runtime, error.object, inShutdown, release);
  }
  if (error instanceof HostStackExhaustion) {
    const trace = traceText(error.record ? [error.record] : []);
    restoreStack(runtime);
    const message = `Fatal error: ${error.message} in ${SCRIPT_PATH} on line ${(error.row ?? 0) + 1}\nStack trace:\n${trace}`;
    runtime.echo(`\n${message}\n`);
    return dec(message);
  }
  if (error instanceof FatalError) {
    const records = error.calls as CallRecord[];
    const trace = traceText(error.exhausted ? records.slice(0, 1) : records);
    restoreStack(runtime);
    const file = error.row < 0 ? 'Unknown' : SCRIPT_PATH;
    const message = `Fatal error: ${error.message ? `${error.message} in ${file} on line ${error.row + 1}${error.withTrace ? `\nStack trace:\n${trace}` : ''}` : ''}`;
    if (error.message) runtime.echo(`\n${message}\n`);
    return dec(message);
  }
  throw error;
}

/** Releases an uncaught exception once it is reported or handled, as PHP does before shutdown. */
function releaseUncaught(runtime: Runtime, object: PhpObject): string | undefined {
  if (runtime.thrown === object) runtime.thrown = undefined;
  // A destructor's exception here is a fatal error in PHP, which ends the release; shutdown frees what remains.
  return guard(runtime, () => runtime.withNativeReleaseMode('shutdown', () => runtime.release([object], false, true)));
}

function invokeExceptionHandler(
  runtime: Runtime,
  object: PhpObject,
  inShutdown: boolean,
  release: boolean
): string | undefined {
  const handler = runtime.exceptionHandler;
  if (handler === null || handler === undefined) {
    const message = printUncaught(runtime, object);
    return (release ? releaseUncaught(runtime, object) : undefined) ?? message;
  }
  runtime.replacedExceptionHandlers.push(handler);
  runtime.exceptionHandler = undefined;
  try {
    // PHP calls the handler after the program's code has unwound, from no line of it.
    asInternal(() => callValue(handler, [{ v: object }], undefined));
    // PHP releases the handled exception before restoring the handler, so its destructors' exceptions go uncaught.
    const failure = releaseUncaught(runtime, object);
    if (failure === undefined && runtime.exceptionHandler === undefined)
      runtime.exceptionHandler = runtime.replacedExceptionHandlers.pop() ?? null;
    return failure;
  } catch (error_) {
    // PHP keeps both exceptions when the handler throws, so their objects survive until shutdown.
    return report(runtime, error_, inShutdown, false);
  }
}

function restoreStack(runtime: Runtime): void {
  runtime.frames.length = 1;
  runtime.depth = 0;
  resetCallStack();
}

function printUncaught(runtime: Runtime, object: PhpObject): string | undefined {
  for (;;) {
    try {
      const text = throwableText(object);
      const message = `Fatal error: Uncaught ${text}\n  thrown in ${throwableLocation(object)}`;
      if ((runtime.errorReporting & E_ERROR) !== 0n) runtime.echo(`\n${message}\n`);
      return dec(message);
    } catch (error) {
      if (!(error instanceof PhpThrow)) return report(runtime, error);
      runtime.spend();
      object = error.object;
    }
  }
}

/** Releases file-scope statics, symbol-table objects, then the remaining object handles. */
function shutdown(runtime: Runtime): string | undefined {
  if (runtime.shuttingDown || runtime.exhausted) return undefined;
  runtime.frames.length = 1;
  const staticFailure = guard(runtime, () => releaseMainStatics(runtime));
  if (runtime.shuttingDown || runtime.exhausted) return staticFailure;
  let objectFailure: string | undefined;
  const outerFailure = guard(runtime, () =>
    runtime.withNativeReleaseMode('shutdown', () => {
      objectFailure = shutdownObjects(runtime);
    })
  );
  return outerFailure ?? objectFailure ?? staticFailure;
}

function shutdownObjects(runtime: Runtime): string | undefined {
  runtime.releasingGlobalsAtShutdown = true;
  let globalStep: { stop: boolean; failure?: string };
  try {
    globalStep = destroyGlobals(runtime);
  } finally {
    runtime.releasingGlobalsAtShutdown = false;
  }
  if (globalStep.stop) return globalStep.failure;
  for (const object of runtime.objectsInShutdownOrder()) {
    if (object.destructed) continue;
    const destructor = object.cls.findMethod('__destruct');
    object.destructed = true;
    if (!destructor) continue;
    runtime.destructibles--;
    if (!mayDestruct(destructor, object)) continue;
    const step = guardShutdownStep(runtime, () =>
      asInternal(() =>
        invoke(
          {
            fn: destructor.fn,
            thisObj: object,
            scope: destructor.scope,
            staticClass: object.cls,
            method: destructor,
          },
          [],
          undefined
        )
      )
    );
    if (step.stop) return step.failure;
  }
  runtime.shuttingDown = true;
  return undefined;
}

function guardShutdownStep(runtime: Runtime, run: () => void): { stop: boolean; failure?: string } {
  try {
    run();
    return { stop: runtime.shuttingDown || runtime.exhausted };
  } catch (error) {
    const failure = report(runtime, error, true);
    return { stop: failure !== undefined || runtime.shuttingDown || runtime.exhausted, failure };
  }
}

function releaseMainStatics(runtime: Runtime): void {
  const statics = [...runtime.globalStatics.values()];
  runtime.globalStatics.clear();
  for (const ref of statics) ref.rc--;
  releaseDropped(runtime, statics, true, 'shutdown');
}

function destroyGlobals(runtime: Runtime): { stop: boolean; failure?: string } {
  if (runtime.destructibles === 0) return { stop: false };
  const order = globalOrder(runtime);
  const state: { counts?: ReturnType<typeof holderCounts> } = {};
  for (;;) {
    let removed = false;
    for (const name of order) {
      const outcome = destroyGlobalEntry(runtime, name, state);
      if (outcome.stop) return outcome;
      if (outcome.removed) removed = true;
    }
    if (!removed) return { stop: false };
  }
}

function destroyGlobalEntry(
  runtime: Runtime,
  name: string,
  state: { counts?: ReturnType<typeof holderCounts> }
): { stop: boolean; failure?: string; removed: boolean } {
  runtime.spend();
  const ref = runtime.globalFrame.vars.get(name);
  if (!ref) return { stop: false, removed: false };
  const value = ref.v;
  // A variable that became a reference stays one, which this pass skips even when nothing else holds it.
  if (!(value instanceof PhpObject) || ref.isRef) return { stop: false, removed: false };
  state.counts ??= holderCounts(runtime);
  if (state.counts.get(value) !== 1) return { stop: false, removed: false };
  runtime.globalFrame.vars.delete(name);
  ref.rc--;
  let fastRemoved = false;
  const step = guardShutdownStep(runtime, () => {
    fastRemoved = releaseGlobalObject(runtime, value);
  });
  if (step.stop) return { ...step, removed: true };
  if (fastRemoved) state.counts.delete(value);
  else state.counts = undefined;
  return { stop: false, removed: true };
}

/** The global variables in the order PHP's symbol table holds them: the program's variables in order of appearance. */
function globalOrder(runtime: Runtime): string[] {
  const order = new Set(runtime.compiledNames(runtime.globalFrame));
  for (const name of runtime.globalFrame.vars.keys()) {
    runtime.spend();
    order.add(name);
  }
  return [...order].toReversed();
}
