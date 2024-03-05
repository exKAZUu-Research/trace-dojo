import { expect, test } from 'vitest';

import { generateProgram } from '../src/problems/problemData';

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
  expect(generateProgram(programId, languageId)).not.toBeFalsy();
});
