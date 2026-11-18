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
