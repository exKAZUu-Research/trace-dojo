import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  ['aliases', (name: string) => name],
  ['arrays', (name: string) => `${name}[]`],
  ['tuples', (name: string) => `[${name}]`],
  ['type arguments', (name: string) => `Array<${name}>`],
  ['unions', (name: string) => `${name} | null`],
] as const)('deep forward %s stop at the type-checking budget', (_, reference) => {
  const source = [
    ...Array.from({ length: 10_000 }, (_, index) => `type A${index} = ${reference(`A${index + 1}`)};`),
    'type A10000 = number;',
    'console.log("ok");',
  ].join('\n');
  expect(executeProgram('typescript', source)).toMatchObject({ kind: 'limitExceeded' });
  expect(executeProgram('typescript', 'type A = number; const value: A = 1; console.log(value);')).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});
