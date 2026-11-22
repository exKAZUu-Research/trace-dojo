import { createInterpreterRunner } from '../../src/interpreter/worker/interpreterRunner';
import { type ProblemJob, runProblemJob } from './problemJobs';

declare global {
  var runProblemJobs: (jobs: ProblemJob[]) => Promise<unknown[]>;
}

const runner = createInterpreterRunner(
  () => new Worker('/src/interpreter/worker/interpreterWorker.js', { type: 'module' })
);

globalThis.runProblemJobs = async (jobs) => {
  const results: unknown[] = [];
  for (const job of jobs) results.push(await runProblemJob(runner, job));
  return results;
};
