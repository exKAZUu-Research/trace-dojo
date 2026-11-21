import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['value', 'type', 'property'])('long misspelled %s names stop at the checker budget', (kind) => {
  const name = 'a'.repeat(80_000);
  const misspelled = `${name.slice(0, -1)}b`;
  const source =
    kind === 'value'
      ? `const ${name} = 1; ${misspelled};`
      : kind === 'type'
        ? `type ${name} = number; let value: ${misspelled};`
        : `const value = {${name}: 1}; value.${misspelled};`;
  expect(executeProgram('typescript', source)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
  expect(executeProgram('typescript', 'const value = 1; console.log(value);')).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
  });
});
