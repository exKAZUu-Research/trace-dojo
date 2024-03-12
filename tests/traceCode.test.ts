import * as fs from 'node:fs';

import { expect, test } from 'vitest';

import { traceProgram } from '../src/tracer/traceProgram';

test.each([
  {
    program: {
      displayProgram: 'straight',
      instrumentedProgram: fs.readFileSync('test-fixtures/sample.js', { encoding: 'utf8' }),
    },
    expected: [
      { sid: 1, variables: { a: 1 } },
      { sid: 2, variables: { a: 1, b: 2 } },
      { sid: 5, variables: { ret: 2 } },
      { sid: 3, variables: { a: 2, b: 2 } },
      { sid: 4, variables: { a: 2, b: 2, c: 4 } },
    ],
  },
] as const)('Trace a program', ({ expected, program }) => {
  expect(traceProgram(program)).toEqual(expected);
});
