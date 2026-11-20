import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';
import { z } from 'zod';

import { buildNodeBundle } from '../helpers/buildNodeBundle';

test('deep superclass and instance evidence remains bounded under Node', { timeout: 30_000 }, () => {
  const bundle = buildNodeBundle('test/helpers/haskellEvidenceMemory.ts');
  const output = execFileSync('node', ['--max-old-space-size=512', '--input-type=module'], {
    input: bundle,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const result = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('executed'), stdout: z.string(), uncaughtException: z.undefined().optional() }),
    z.object({ kind: z.literal('limitExceeded'), limit: z.literal('operations') }),
  ]);
  const results = z.tuple([result, result]).parse(JSON.parse(output));
  if (results[0].kind === 'executed') expect(results[0].stdout).toBe('1\n');
  expect(results[1]).toMatchObject({ kind: 'executed', stdout: '7\n' });
});
