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

test('formats a wide shared object diagnostic within the execution budget', () => {
  const properties = Array.from({ length: 100 }, (_, index) => `p${index}: previous`).join(', ');
  const objects = Array.from(
    { length: 4 },
    (_, index) => `const layer${index} = { ${properties.replaceAll('previous', index ? `layer${index - 1}` : '0')} };`
  );
  const result = executeProgram('typescript', [...objects, 'const invalid: string = layer3;'].join('\n'));
  expect(result).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 4, message: expect.stringMatching(/p0.*\.\.\./) }],
  });
});
