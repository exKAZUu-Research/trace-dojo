import { expect, test } from 'vitest';

import { instantiateProblem } from '../../src/problems/instantiateProblem';
import { problemIdToLanguageIdToProgram } from '../../src/problems/problemData';

test.each(Object.keys(problemIdToLanguageIdToProgram))('Trace the program of %s', (problemId) => {
  for (let i = 0; i < 100; i++) {
    expect(instantiateProblem(problemId, 'java', Date.now().toString())).toBeTruthy();
  }
});
