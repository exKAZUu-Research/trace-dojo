import { expect, test } from 'vitest';
import { z } from 'zod';

import { createNodeBundleRunner } from '../helpers/nodeBundleRunner';

const runNodeBundle = createNodeBundleRunner();

test('deep superclass and instance evidence remains bounded under Node', { timeout: 30_000 }, () => {
  const output = runNodeBundle('test/helpers/haskellEvidenceMemory.ts', { heapMb: 512 });
  const result = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('executed'), stdout: z.string(), uncaughtException: z.undefined().optional() }),
    z.object({ kind: z.literal('limitExceeded'), limit: z.literal('operations') }),
  ]);
  const results = z.tuple([result, result]).parse(JSON.parse(output));
  if (results[0].kind === 'executed') expect(results[0].stdout).toBe('1\n');
  expect(results[1]).toMatchObject({ kind: 'executed', stdout: '7\n' });
});
