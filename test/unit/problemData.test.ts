import { expect, test } from 'vitest';

import { instantiateProblem } from '../../src/problems/instantiateProblem';
import { problemIdToProgram } from '../../src/problems/problemData';

/** Problems that show how an uncaught exception stops a program. */
const problemsEndingWithException = new Set(['exception2', 'exception5']);

test.each(Object.keys(problemIdToProgram))('Trace the program of %s', (problemId) => {
  for (let i = 0; i < 100; i++) {
    const problem = instantiateProblem(problemId, Date.now().toString());
    expect(problem).toBeTruthy();
    expect(problem?.uncaughtException !== undefined).toBe(problemsEndingWithException.has(problemId));
  }
});
