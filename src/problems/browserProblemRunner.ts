import { createInterpreterRunner, type InterpreterRunner } from '../interpreter/worker/interpreterRunner';

let runner: InterpreterRunner | undefined;

/** The runner that every page of a tab shares, so the interpreter is loaded once per tab. */
export function getBrowserProblemRunner(): InterpreterRunner {
  runner ??= createInterpreterRunner(
    () => new Worker(new URL('../interpreter/worker/interpreterWorker.ts', import.meta.url), { type: 'module' })
  );
  return runner;
}
