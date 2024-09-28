import { expect, test } from 'vitest';

import { generateProblem } from '../../src/problems/generateProblem';
import { problemIdToLanguageIdToProgram } from '../../src/problems/problemData';

test.each(Object.keys(problemIdToLanguageIdToProgram))('Trace the program of %s', (problemId) => {
  for (let i = 0; i < 100; i++) {
    expect(generateProblem(problemId, 'java', Date.now().toString())).not.toBeFalsy();
  }
});
