import { expect, test } from 'vitest';
import { z } from 'zod';

import { createNodeBundleRunner } from '../helpers/nodeBundleRunner';

const runNodeBundle = createNodeBundleRunner();

test('large Kotlin arrays and lists work under Node within the allocation limit', { timeout: 30_000 }, () => {
  const output = runNodeBundle('test/helpers/kotlinLargeCollectionsUnderNode.ts');
  const results = z
    .array(z.object({ kind: z.literal('executed'), stdout: z.string(), uncaughtException: z.string().optional() }))
    .parse(JSON.parse(output));
  expect(results).toEqual([
    { kind: 'executed', stdout: '200000\n' },
    { kind: 'executed', stdout: '1\n' },
    { kind: 'executed', stdout: '49995000\n' },
  ]);
});
