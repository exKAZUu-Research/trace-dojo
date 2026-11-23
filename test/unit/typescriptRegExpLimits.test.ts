import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['/a/.test("abc")', '"abc".match(/a/) !== null'])(
  'many simple matches of %s complete within the execution budget',
  (match) => {
    const source = `let matches = 0; for (let i = 0; i < 20000; i++) { if (${match}) matches++; } console.log(matches);`;
    expect(executeProgram('typescript', source)).toMatchObject({
      kind: 'executed',
      stdout: '20000\n',
      uncaughtException: undefined,
    });
  }
);
