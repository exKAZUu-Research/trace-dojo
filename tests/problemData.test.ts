import { expect, test } from 'vitest';

import { generateProgram, getProgramCheckpoints } from '../src/problems/problemData';

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
  expect(generateProgram(programId, languageId, Date.now().toString())).not.toBeFalsy();
});

test.each([
  {
    programId: 'getProgramCheckpointsTest',
    expected: [2, 5],
  },
] as const)('Get program checkpoint line numbers', ({ expected, programId }) => {
  expect(getProgramCheckpoints(programId)).toEqual(expected);
});
