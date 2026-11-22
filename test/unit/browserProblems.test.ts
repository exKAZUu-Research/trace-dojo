import { chromium, firefox, webkit } from 'playwright';
import { describe, expect, test } from 'vitest';

import { challengeBases } from '../../src/problems/challenge/definitions';
import { javaChallengeDefinitions } from '../../src/problems/javaChallenges/definitions';
import { instantiateJavaChallenge } from '../../src/problems/javaChallenges/instantiate';
import { practiceDefinitions } from '../../src/problems/practice/definitions';
import { problemIdToProgram } from '../../src/problems/problemData';
import { openBrowserInterpreterPage } from '../helpers/browserInterpreterSession';
import { nodeRunner } from '../helpers/nodeProblems';
import { type ProblemJob, runProblemJob } from '../helpers/problemJobs';

const BROWSER_TYPES = { chromium, firefox, webkit };
// CI installs Chromium alone; `BROWSER_ENGINES=chromium,firefox,webkit` compares the other engines where installed.
const engines = (process.env.BROWSER_ENGINES ?? 'chromium').split(',') as (keyof typeof BROWSER_TYPES)[];
const JOBS_PER_MESSAGE = 100;

describe.each(engines)('%s', (engine) => {
  test('generates every problem and runs every model program as Node.js does', async () => {
    const jobs = productJobs();
    const expected = [];
    for (const job of jobs) expected.push(await runProblemJob(nodeRunner, job));

    const session = await openBrowserInterpreterPage(
      'test/helpers/browserProblemPage.ts',
      'runProblemJobs',
      BROWSER_TYPES[engine]
    );
    try {
      for (let start = 0; start < jobs.length; start += JOBS_PER_MESSAGE) {
        const actual = await session.page.evaluate(
          (chunk) => globalThis.runProblemJobs(chunk),
          jobs.slice(start, start + JOBS_PER_MESSAGE)
        );
        for (const [index, result] of actual.entries())
          expect(result, JSON.stringify(jobs[start + index])).toEqual(expected[start + index]);
      }
    } finally {
      await session.close();
    }
  }, 600_000);
});

/** What the pages ask of the interpreter for the problems the product serves, with two seeds for random numbers. */
function productJobs(): ProblemJob[] {
  const templates = [
    ...Object.values(problemIdToProgram),
    ...practiceDefinitions.map(({ program }) => program),
    ...challengeBases.map(({ java }) => java),
  ];
  const jobs: ProblemJob[] = templates.flatMap((template) =>
    (/<\d+-\d+>/.test(template) ? ['browser-seed-1', 'browser-seed-2'] : ['']).map(
      (seed): ProblemJob => ({ kind: 'instantiate', template, seed })
    )
  );
  const sources = new Set(
    Object.entries(javaChallengeDefinitions).flatMap(([id, definition]) => [
      definition.correctProgram,
      instantiateJavaChallenge(id, definition.problemFormat).displayProgram,
    ])
  );
  for (const source of sources) jobs.push({ kind: 'execute', source });
  return jobs;
}
