import { instantiateTemplate } from '../../src/problems/instantiateTemplate';
import type { ProblemRunner } from '../../src/problems/problemRunner';

/** One use of the interpreter by a page: generating a problem, or running the code a learner submits. */
export type ProblemJob =
  | { kind: 'instantiate'; template: string; seed: string }
  | { kind: 'execute'; source: string };

/** The outcome of a job, with a failure as a value so that hosts can be compared on it. */
export async function runProblemJob(runner: ProblemRunner, job: ProblemJob): Promise<unknown> {
  try {
    return job.kind === 'instantiate'
      ? await instantiateTemplate(runner, job.template, job.seed)
      : await runner.executeProgram('java', job.source);
  } catch (error) {
    return { failure: String(error) };
  }
}
