import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  '/^(a+)+$/.test(text)',
  '/^(a+)+$/.exec(text)',
  'text.match(/^(a+)+$/g)',
  'text.search(/^(a+)+$/)',
  'text.replace(/^(a+)+$/g, "x")',
  'text.split(/^(a+)+$/)',
  'text.matchAll(/^(a+)+$/g).next()',
])('regular expression backtracking in %s respects the execution deadline', (operation) => {
  expect(executeProgram('typescript', `const text = "a".repeat(32) + "!"; ${operation};`)).toEqual({
    kind: 'limitExceeded',
    limit: 'time',
  });
  expect(executeProgram('typescript', 'console.log(/a/.test("a"));')).toMatchObject({
    kind: 'executed',
    stdout: 'true\n',
    uncaughtException: undefined,
  });
});

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
