import type { BrowserReadyLanguage } from '../browserReadyInterpreters';
import type { ProgramExecution, ProgramTrace } from '../interpreter';
import type { ProgramInput } from '../programIo';
import { errorOf, type InterpreterRequest, type InterpreterResponse } from './protocol';

/** Runs programs off the main thread, one at a time, in a worker that loads each language's interpreter on first use. */
export interface InterpreterRunner {
  /** `traceProgram` of `../program`, which rejects with what that throws. */
  traceProgram: (
    language: BrowserReadyLanguage,
    program: string,
    displayProgram: string,
    input?: ProgramInput,
    options?: RunOptions
  ) => Promise<ProgramTrace>;
  /** `executeProgram` of `../program`. */
  executeProgram: (
    language: BrowserReadyLanguage,
    source: string,
    input?: ProgramInput,
    options?: RunOptions
  ) => Promise<ProgramExecution>;
  /** Stops the worker, rejecting the program it runs; the next call starts a new worker. */
  terminate: () => void;
}

export interface RunOptions {
  /**
   * How long the program may run after its interpreter is loaded before the runner terminates the worker, which
   * bounds what the interpreters' own limits fail to stop.
   */
  timeoutMs?: number;
}

/** Rejects a run that the runner stopped, which leaves no result. */
export class InterpreterStoppedError extends Error {
  constructor(
    /** `loadTimeout` when the interpreter did not load in time, and `timeout` when the program outlasted its limit. */
    readonly reason: 'timeout' | 'loadTimeout' | 'terminated' | 'workerError',
    detail?: string
  ) {
    super(`The interpreter worker stopped: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'InterpreterStoppedError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Bounds the download of an interpreter and its grammar, which a stalled connection never finishes. */
const LOAD_TIMEOUT_MS = 60_000;

/** @param createWorker Starts a module worker whose entry is `./interpreterWorker.ts`. */
export function createInterpreterRunner(createWorker: () => Worker): InterpreterRunner {
  let worker: Worker | undefined;
  let stopRunning: Stop | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const run = <T extends ProgramTrace | ProgramExecution>(
    request: InterpreterRequest,
    { timeoutMs = DEFAULT_TIMEOUT_MS }: RunOptions = {}
  ): Promise<T> => {
    const result = queue.then(async () => {
      const running = (worker ??= createWorker());
      const { finished, stop } = runOn<T>(running, request, timeoutMs);
      stopRunning = stop;
      try {
        return await finished;
      } catch (error) {
        if (error instanceof InterpreterStoppedError && worker === running) worker = undefined;
        throw error;
      } finally {
        stopRunning = undefined;
      }
    });
    queue = result.catch(() => {});
    return result;
  };

  return {
    traceProgram: (language, program, displayProgram, input, options) =>
      run({ kind: 'trace', language, program, displayProgram, input }, options),
    executeProgram: (language, source, input, options) => run({ kind: 'execute', language, source, input }, options),
    terminate: () => {
      if (stopRunning) stopRunning('terminated');
      else worker?.terminate();
      worker = undefined;
    },
  };
}

type Stop = (reason: InterpreterStoppedError['reason'], detail?: string) => void;

/** Runs one program on a worker that runs nothing else, terminating the worker when the run is stopped. */
function runOn<T>(
  worker: Worker,
  request: InterpreterRequest,
  timeoutMs: number
): { finished: Promise<T>; stop: Stop } {
  const listening = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const stop: Stop = (reason, detail) => {
    worker.terminate();
    reject(new InterpreterStoppedError(reason, detail));
  };
  worker.addEventListener(
    'message',
    ({ data }: MessageEvent<InterpreterResponse>) => {
      if (data.type === 'started') {
        clearTimeout(timer);
        timer = setTimeout(stop, timeoutMs, 'timeout');
      } else if (data.type === 'finished') resolve(data.result as T);
      else if (data.loaded) reject(errorOf(data.error));
      else stop('workerError', data.error.message);
    },
    { signal: listening.signal }
  );
  worker.addEventListener('error', ({ message }) => stop('workerError', message), {
    signal: listening.signal,
  });
  worker.postMessage(request);
  timer = setTimeout(stop, LOAD_TIMEOUT_MS, 'loadTimeout');
  const finished = promise.finally(() => {
    clearTimeout(timer);
    listening.abort();
  });
  return { finished, stop };
}
