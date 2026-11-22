import { expect, test } from 'vitest';

import { problemIdToProgram } from '../../src/problems/problemData';
import { instantiateProblem } from '../helpers/nodeProblems';

/** Problems that show how an uncaught exception stops a program. */
const problemsEndingWithException = new Set(['exception2', 'exception5']);

test.each(Object.keys(problemIdToProgram))('Trace the program of %s', async (problemId) => {
  for (let i = 0; i < 100; i++) {
    const problem = await instantiateProblem(problemId, Date.now().toString());
    expect(problem.uncaughtException !== undefined).toBe(problemsEndingWithException.has(problemId));
  }
});
