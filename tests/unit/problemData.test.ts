import { expect, test } from 'vitest';

import { generateProblem } from '../../src/problems/generateProblem';

test.each([
  {
    problemId: 'straight',
    languageId: 'java',
  },
  {
    problemId: 'stepBack',
    languageId: 'java',
  },
  {
    problemId: 'turnRight',
    languageId: 'java',
  },
  {
    problemId: 'turnRightAndTurnLeft',
    languageId: 'java',
  },
] as const)('Get a program by program and language ids', ({ languageId, problemId }) => {
  expect(generateProblem(problemId, languageId, Date.now().toString())).not.toBeFalsy();
});
