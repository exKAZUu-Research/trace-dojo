import { expect, test } from 'vitest';

import { generateProblem } from '../src/problems/generateProblem';

test.each([
  {
    programId: 'straight',
    languageId: 'js',
  },
  {
    programId: 'curve',
    languageId: 'java',
  },
] as const)('Get a program by program and language ids', ({ languageId, programId }) => {
  expect(generateProblem(programId, languageId, Date.now().toString())).not.toBeFalsy();
});
