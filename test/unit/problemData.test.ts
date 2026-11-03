import { expect, test } from 'vitest';

import { instantiateProblem } from '../../src/problems/instantiateProblem';
import { problemIdToProgram } from '../../src/problems/problemData';

test.each(Object.keys(problemIdToProgram))('Trace the program of %s', (problemId) => {
  for (let i = 0; i < 100; i++) {
    expect(instantiateProblem(problemId, Date.now().toString())).toBeTruthy();
  }
});
