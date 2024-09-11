import { expect, test } from 'vitest';

import { generateProblem } from '../src/problems/generateProblem';

test.each([
  {
    programId: 'straight',
    languageId: 'js',
  },
  {
    programId: 'stepBack',
    languageId: 'js',
  },
  {
    programId: 'turnRight',
    languageId: 'js',
  },
  {
    programId: 'turnRightAndTurnLeft',
    languageId: 'js',
  },
] as const)('Get a program by program and language ids', ({ languageId, programId }) => {
  expect(generateProblem(programId, languageId, Date.now().toString())).not.toBeFalsy();
});
